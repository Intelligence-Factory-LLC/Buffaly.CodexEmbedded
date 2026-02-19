using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

internal sealed class JsonRpcJsonlClient : IAsyncDisposable
{
	private readonly IJsonlTransport _transport;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
	{
		DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
	};
	private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new(StringComparer.Ordinal);
	private readonly SemaphoreSlim _sendLock = new(1, 1);
	private long _nextId;
	private Task? _stdoutPump;
	private Task? _stderrPump;
	private CancellationTokenSource? _pumpCts;

	public event Action<CodexCoreEvent>? OnEvent;
	public event Action<string, JsonElement>? OnNotification;

	// Server requests are JSON-RPC requests initiated by the server (method + id).
	// Handler returns the JSON element to send as `result`.
	public Func<string, JsonElement, JsonElement, CancellationToken, Task<JsonElement>>? OnServerRequest;

	public JsonRpcJsonlClient(IJsonlTransport transport)
	{
		_transport = transport;
	}

	public Task StartAsync(CancellationToken cancellationToken)
	{
		if (_pumpCts is not null)
		{
			throw new InvalidOperationException("Already started.");
		}

		_pumpCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		_stdoutPump = Task.Run(() => PumpStdoutAsync(_pumpCts.Token));
		_stderrPump = Task.Run(() => PumpStderrAsync(_pumpCts.Token));
		return Task.CompletedTask;
	}

	public async Task<JsonElement> SendRequestAsync(string method, object? @params, CancellationToken cancellationToken)
	{
		var id = Interlocked.Increment(ref _nextId);
		var idKey = id.ToString(CultureInfo.InvariantCulture);

		var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
		_pending[idKey] = tcs;

		try
		{
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "debug", "rpc_sent", $"{method} id={idKey}"));

			var payload = new Dictionary<string, object?>
			{
				["id"] = id,
				["method"] = method,
				["params"] = @params
			};

			var json = JsonSerializer.Serialize(payload, _jsonOptions);

			await _sendLock.WaitAsync(cancellationToken);
			try
			{
				await _transport.WriteStdinLineAsync(json, cancellationToken);
			}
			finally
			{
				_sendLock.Release();
			}

			return await tcs.Task.WaitAsync(cancellationToken);
		}
		catch
		{
			_pending.TryRemove(idKey, out _);
			throw;
		}
	}

	public async Task<JsonElement> SendResponseAsync(JsonElement idElement, object result, CancellationToken cancellationToken)
	{
		object idValue = idElement.ValueKind switch
		{
			JsonValueKind.String => idElement.GetString() ?? string.Empty,
			JsonValueKind.Number when idElement.TryGetInt64(out var longValue) => longValue,
			JsonValueKind.Number when idElement.TryGetDecimal(out var decimalValue) => decimalValue,
			_ => idElement.ToString()
		};

		var payload = new Dictionary<string, object?>
		{
			["id"] = idValue,
			["result"] = result
		};

		var json = JsonSerializer.Serialize(payload, _jsonOptions);
		await _sendLock.WaitAsync(cancellationToken);
		try
		{
			await _transport.WriteStdinLineAsync(json, cancellationToken);
		}
		finally
		{
			_sendLock.Release();
		}

		// Return a dummy element for convenience.
		using var doc = JsonDocument.Parse("{\"ok\":true}");
		return doc.RootElement.Clone();
	}

	private async Task PumpStdoutAsync(CancellationToken cancellationToken)
	{
		try
		{
			while (!cancellationToken.IsCancellationRequested)
			{
				var line = await _transport.ReadStdoutLineAsync(cancellationToken);
				if (line is null)
				{
					break;
				}

				OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "debug", "stdout_jsonl", line));

				JsonDocument doc;
				try
				{
					doc = JsonDocument.Parse(line);
				}
				catch (Exception ex)
				{
					OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "warn", "stdout_parse_failed", ex.Message));
					continue;
				}

				using (doc)
				{
					var root = doc.RootElement;
					if (root.TryGetProperty("id", out var idElement))
					{
						var idKey = idElement.ValueKind switch
						{
							JsonValueKind.String => idElement.GetString(),
							JsonValueKind.Number => idElement.ToString(),
							_ => null
						};

						if (!string.IsNullOrWhiteSpace(idKey) && _pending.TryRemove(idKey!, out var tcs))
						{
							if (root.TryGetProperty("result", out var resultElement))
							{
								tcs.TrySetResult(resultElement.Clone());
							}
							else if (root.TryGetProperty("error", out var errorElement))
							{
								tcs.TrySetException(new InvalidOperationException(errorElement.ToString()));
							}
							else
							{
								tcs.TrySetException(new InvalidOperationException("Malformed JSON-RPC response."));
							}

							continue;
						}

						// If it has method+id, it's a server request.
						if (root.TryGetProperty("method", out var methodElement) && methodElement.ValueKind == JsonValueKind.String)
						{
							if (OnServerRequest is not null)
							{
								_ = Task.Run(async () =>
								{
									try
									{
										await OnServerRequest(methodElement.GetString()!, idElement, root, cancellationToken);
									}
									catch (Exception ex)
									{
										OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "warn", "server_request_handler_failed", ex.Message));
									}
								}, cancellationToken);
							}

							continue;
						}
					}

					if (root.TryGetProperty("method", out var notificationMethod) && notificationMethod.ValueKind == JsonValueKind.String)
					{
						OnNotification?.Invoke(notificationMethod.GetString()!, root.Clone());
					}
				}
			}
		}
		catch (OperationCanceledException)
		{
		}
		catch (Exception ex)
		{
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "error", "stdout_pump_failed", ex.Message));
		}
		finally
		{
			foreach (var tcs in _pending.Values)
			{
				tcs.TrySetException(new InvalidOperationException("Transport closed before response."));
			}
			_pending.Clear();
		}
	}

	private async Task PumpStderrAsync(CancellationToken cancellationToken)
	{
		try
		{
			while (!cancellationToken.IsCancellationRequested)
			{
				var line = await _transport.ReadStderrLineAsync(cancellationToken);
				if (line is null)
				{
					break;
				}

				OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "debug", "stderr_line", line));
			}
		}
		catch (OperationCanceledException)
		{
		}
		catch (Exception ex)
		{
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "error", "stderr_pump_failed", ex.Message));
		}
	}

	public async ValueTask DisposeAsync()
	{
		try
		{
			_pumpCts?.Cancel();
		}
		catch
		{
		}
		finally
		{
			_pumpCts?.Dispose();
			_pumpCts = null;
		}

		try
		{
			if (_stdoutPump is not null)
			{
				await _stdoutPump;
			}
		}
		catch
		{
		}

		try
		{
			if (_stderrPump is not null)
			{
				await _stderrPump;
			}
		}
		catch
		{
		}

		_sendLock.Dispose();
		await _transport.DisposeAsync();
	}
}

