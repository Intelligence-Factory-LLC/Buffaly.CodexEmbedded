using System.Collections.Concurrent;
using System.Diagnostics;
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
	private readonly ConcurrentDictionary<string, PendingRpcRequest> _pending = new(StringComparer.Ordinal);
	private readonly SemaphoreSlim _sendLock = new(1, 1);
	private long _nextId;
	private Task? _stdoutPump;
	private Task? _stderrPump;
	private CancellationTokenSource? _pumpCts;
	private DateTimeOffset? _lastStdinWriteUtc;
	private DateTimeOffset? _lastStdoutReadUtc;
	private DateTimeOffset? _lastStderrReadUtc;

	public event Action<CodexCoreEvent>? OnEvent;
	public event Action<string, JsonElement>? OnNotification;

	// Server requests are JSON-RPC requests initiated by the server (method + id).
	// Handler returns the JSON element to send as `result`.
	public Func<string, JsonElement, JsonElement, CancellationToken, Task<JsonElement>>? OnServerRequest;

	public JsonRpcJsonlClient(IJsonlTransport transport)
	{
		_transport = transport;
	}

	private sealed record PendingRpcRequest(
		TaskCompletionSource<JsonElement> Completion,
		string Method,
		DateTimeOffset SentAtUtc);

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
		var stopwatch = Stopwatch.StartNew();

		var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
		_pending[idKey] = new PendingRpcRequest(tcs, method, DateTimeOffset.UtcNow);

		try
		{
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "debug", "rpc_sent", $"{method} id={idKey} pending={_pending.Count}"));

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
				_lastStdinWriteUtc = DateTimeOffset.UtcNow;
			}
			finally
			{
				_sendLock.Release();
			}

			var result = await tcs.Task.WaitAsync(cancellationToken);
			stopwatch.Stop();
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "debug", "rpc_completed", $"{method} id={idKey} elapsedMs={stopwatch.ElapsedMilliseconds} pending={_pending.Count}"));
			return result;
		}
		catch (OperationCanceledException)
		{
			stopwatch.Stop();
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "warn", "rpc_wait_canceled", $"{method} id={idKey} elapsedMs={stopwatch.ElapsedMilliseconds} pending={_pending.Count}"));
			_pending.TryRemove(idKey, out _);
			throw;
		}
		catch
		{
			stopwatch.Stop();
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "warn", "rpc_wait_failed", $"{method} id={idKey} elapsedMs={stopwatch.ElapsedMilliseconds} pending={_pending.Count}"));
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
			_lastStdinWriteUtc = DateTimeOffset.UtcNow;
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
				_lastStdoutReadUtc = DateTimeOffset.UtcNow;

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

						if (!string.IsNullOrWhiteSpace(idKey) && _pending.TryRemove(idKey!, out var pending))
						{
							if (root.TryGetProperty("result", out var resultElement))
							{
								pending.Completion.TrySetResult(resultElement.Clone());
							}
							else if (root.TryGetProperty("error", out var errorElement))
							{
								pending.Completion.TrySetException(new InvalidOperationException(errorElement.ToString()));
							}
							else
							{
								pending.Completion.TrySetException(new InvalidOperationException("Malformed JSON-RPC response."));
							}

							continue;
						}
						else if (!string.IsNullOrWhiteSpace(idKey) &&
							!root.TryGetProperty("method", out _))
						{
							var hasResult = root.TryGetProperty("result", out _);
							var hasError = root.TryGetProperty("error", out _);
							OnEvent?.Invoke(new CodexCoreEvent(
								DateTimeOffset.UtcNow,
								"warn",
								"rpc_response_unmatched",
								$"id={idKey} hasResult={hasResult} hasError={hasError} pending={_pending.Count}"));
						}

						// If it has method+id, it's a server request.
						if (root.TryGetProperty("method", out var methodElement) && methodElement.ValueKind == JsonValueKind.String)
						{
							if (OnServerRequest is not null)
							{
								var methodName = methodElement.GetString()!;
								var idClone = idElement.Clone();
								var rootClone = root.Clone();

								_ = Task.Run(async () =>
								{
									try
									{
										await OnServerRequest(methodName, idClone, rootClone, cancellationToken);
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
			foreach (var pending in _pending.Values)
			{
				pending.Completion.TrySetException(new InvalidOperationException("Transport closed before response."));
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
				_lastStderrReadUtc = DateTimeOffset.UtcNow;

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

	public CodexRpcDebugSnapshot GetDebugSnapshot(int maxPending = 8)
	{
		var nowUtc = DateTimeOffset.UtcNow;
		var boundedMax = Math.Clamp(maxPending, 1, 64);
		var pendingRequests = _pending
			.OrderBy(x => x.Value.SentAtUtc)
			.Take(boundedMax)
			.Select(x => new CodexRpcPendingRequest(
				Id: x.Key,
				Method: x.Value.Method,
				AgeMs: Math.Max(0, (nowUtc - x.Value.SentAtUtc).TotalMilliseconds)))
			.ToArray();

		return new CodexRpcDebugSnapshot(
			CapturedAtUtc: nowUtc,
			PendingCount: _pending.Count,
			PendingRequests: pendingRequests,
			LastStdinWriteUtc: _lastStdinWriteUtc,
			LastStdoutReadUtc: _lastStdoutReadUtc,
			LastStderrReadUtc: _lastStderrReadUtc);
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

