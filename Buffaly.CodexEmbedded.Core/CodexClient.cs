using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

public sealed class CodexClient : IAsyncDisposable
{
	private readonly JsonRpcJsonlClient _rpc;
	private readonly SemaphoreSlim _initializeLock = new(1, 1);
	private readonly ConcurrentDictionary<string, TurnTracker> _turnsByTurnId = new(StringComparer.Ordinal);
	private readonly Func<CodexServerRequest, CancellationToken, Task<object?>>? _serverRequestHandler;
	private bool _initialized;

	public event Action<CodexCoreEvent>? OnEvent;

	private CodexClient(JsonRpcJsonlClient rpc, Func<CodexServerRequest, CancellationToken, Task<object?>>? serverRequestHandler)
	{
		_rpc = rpc;
		_serverRequestHandler = serverRequestHandler;
		_rpc.OnEvent += ev => OnEvent?.Invoke(ev);
		_rpc.OnNotification += HandleNotification;
		_rpc.OnServerRequest += HandleServerRequestAsync;
	}

	public static async Task<CodexClient> StartAsync(CodexClientOptions options, CancellationToken cancellationToken = default)
	{
		var transport = await ProcessJsonlTransport.StartAsync(options, cancellationToken);
		var rpc = new JsonRpcJsonlClient(transport);
		await rpc.StartAsync(cancellationToken);
		var client = new CodexClient(rpc, options.ServerRequestHandler);
		await client.InitializeAsync(cancellationToken);
		return client;
	}

	// Exposed for unit/self-tests and alternative embedding scenarios.
	public static async Task<CodexClient> ConnectAsync(IJsonlTransport transport, CancellationToken cancellationToken = default)
	{
		var rpc = new JsonRpcJsonlClient(transport);
		await rpc.StartAsync(cancellationToken);
		var client = new CodexClient(rpc, serverRequestHandler: null);
		await client.InitializeAsync(cancellationToken);
		return client;
	}

	public async Task<IReadOnlyList<CodexModelInfo>> ListModelsAsync(int? limit = 200, CancellationToken cancellationToken = default)
	{
		await InitializeAsync(cancellationToken);

		var result = await _rpc.SendRequestAsync(
			method: "model/list",
			@params: new { cursor = (string?)null, limit },
			cancellationToken);

		if (!result.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
		{
			return Array.Empty<CodexModelInfo>();
		}

		var output = new List<CodexModelInfo>();
		foreach (var model in data.EnumerateArray())
		{
			var modelName = JsonPath.TryGetString(model, "model");
			if (string.IsNullOrWhiteSpace(modelName))
			{
				continue;
			}

			var displayName = JsonPath.TryGetString(model, "displayName") ?? modelName;
			var isDefault = model.TryGetProperty("isDefault", out var isDefaultEl) && isDefaultEl.ValueKind == JsonValueKind.True;
			var description = JsonPath.TryGetString(model, "description");
			output.Add(new CodexModelInfo(modelName, displayName, isDefault, description));
		}

		return output;
	}

	public async Task InitializeAsync(CancellationToken cancellationToken = default)
	{
		if (_initialized)
		{
			return;
		}

		await _initializeLock.WaitAsync(cancellationToken);
		try
		{
			if (_initialized)
			{
				return;
			}

			await _rpc.SendRequestAsync(
				method: "initialize",
				@params: new
				{
					clientInfo = new
					{
						name = "codex_app_server_core",
						title = "Codex App-Server Core",
						version = "0.1.0"
					}
				},
				cancellationToken);

			_initialized = true;
		}
		finally
		{
			_initializeLock.Release();
		}
	}

	public async Task<CodexSession> CreateSessionAsync(CodexSessionCreateOptions options, CancellationToken cancellationToken = default)
	{
		await InitializeAsync(cancellationToken);

		var result = await _rpc.SendRequestAsync(
			method: "thread/start",
			@params: new
			{
				cwd = options.Cwd,
				model = options.Model
			},
			cancellationToken);

		var threadId = JsonPath.GetRequiredString(result, "thread", "id");
		return new CodexSession(this, threadId, options.Cwd, options.Model);
	}

	public async Task<CodexSession> AttachToSessionAsync(CodexSessionAttachOptions options, CancellationToken cancellationToken = default)
	{
		await InitializeAsync(cancellationToken);

		// Prefer thread/resume; callers expect this to fail loudly if unsupported.
		var result = await _rpc.SendRequestAsync(
			method: "thread/resume",
			@params: new
			{
				threadId = options.ThreadId
			},
			cancellationToken);

		var threadId = JsonPath.GetRequiredString(result, "thread", "id");
		return new CodexSession(this, threadId, options.Cwd, options.Model);
	}

	internal async Task<CodexTurnResult> SendMessageAsync(
		string threadId,
		string text,
		CodexTurnOptions? options,
		IReadOnlyList<CodexUserImageInput>? images,
		IProgress<CodexDelta>? progress,
		CancellationToken cancellationToken)
	{
		await InitializeAsync(cancellationToken);

		var input = new List<object>();
		if (!string.IsNullOrWhiteSpace(text))
		{
			input.Add(new
			{
				type = "text",
				text
			});
		}

		if (images is not null)
		{
			foreach (var image in images)
			{
				if (image is null || string.IsNullOrWhiteSpace(image.Url))
				{
					continue;
				}

				input.Add(new
				{
					type = "image",
					url = image.Url
				});
			}
		}

		if (input.Count == 0)
		{
			throw new ArgumentException("Either message text or at least one image is required.");
		}

		var turnStartResult = await _rpc.SendRequestAsync(
			method: "turn/start",
			@params: new
			{
				threadId,
				model = options?.Model,
				input = input.ToArray()
			},
			cancellationToken);

		var turnId = JsonPath.GetRequiredString(turnStartResult, "turn", "id");
		var tracker = new TurnTracker(threadId, turnId, progress);
		if (!_turnsByTurnId.TryAdd(turnId, tracker))
		{
			throw new InvalidOperationException($"Duplicate turn id '{turnId}'.");
		}

		try
		{
			return await tracker.Completion.Task.WaitAsync(cancellationToken);
		}
		finally
		{
			_turnsByTurnId.TryRemove(turnId, out _);
		}
	}

	private void HandleNotification(string method, JsonElement message)
	{
		try
		{
			if (!message.TryGetProperty("params", out var paramsElement))
			{
				paramsElement = default;
			}

			switch (method)
			{
				case "item/agentMessage/delta":
				{
					var delta = JsonPath.TryGetString(paramsElement, "delta");
					var turnId = JsonPath.TryGetString(paramsElement, "turnId");
					var threadId = JsonPath.TryGetString(paramsElement, "threadId");

					if (!string.IsNullOrEmpty(delta) && !string.IsNullOrEmpty(turnId) && _turnsByTurnId.TryGetValue(turnId, out var tracker))
					{
						tracker.OnDelta(delta, threadId);
					}
					return;
				}
				case "turn/completed":
				{
					var turnId = JsonPath.TryGetString(paramsElement, "turn", "id");
					if (string.IsNullOrWhiteSpace(turnId))
					{
						turnId = JsonPath.TryGetString(paramsElement, "turnId");
					}

					if (string.IsNullOrWhiteSpace(turnId))
					{
						return;
					}

					var status = JsonPath.TryGetString(paramsElement, "turn", "status") ?? "unknown";
					var errorMessage = JsonPath.TryGetString(paramsElement, "turn", "error", "message");

					if (_turnsByTurnId.TryGetValue(turnId, out var tracker))
					{
						tracker.OnCompleted(status, errorMessage);
					}

					return;
				}
				case "error":
				{
					// Forward errors to all in-flight turns; they might be transient retries.
					var messageText = JsonPath.TryGetString(paramsElement, "error", "message")
						?? JsonPath.TryGetString(paramsElement, "message");
					var additional = JsonPath.TryGetString(paramsElement, "error", "additionalDetails")
						?? JsonPath.TryGetString(paramsElement, "additionalDetails");
					var composite = string.IsNullOrWhiteSpace(additional) ? messageText : $"{messageText} ({additional})";

					if (!string.IsNullOrWhiteSpace(composite))
					{
						foreach (var tracker in _turnsByTurnId.Values)
						{
							tracker.OnError(composite);
						}
					}
					return;
				}
				default:
					return;
			}
		}
		catch (Exception ex)
		{
			OnEvent?.Invoke(new CodexCoreEvent(DateTimeOffset.UtcNow, "warn", "notification_handler_failed", ex.Message));
		}
	}

	private async Task<JsonElement> HandleServerRequestAsync(string method, JsonElement idElement, JsonElement message, CancellationToken cancellationToken)
	{
		var paramsElement = message.TryGetProperty("params", out var p) ? p : default;
		var req = new CodexServerRequest(method, paramsElement, message);

		object? result = null;
		if (_serverRequestHandler is not null)
		{
			result = await _serverRequestHandler(req, cancellationToken);
		}

		// Safe defaults if handler is absent or returns null.
		result ??= method switch
		{
			"item/commandExecution/requestApproval" => new { decision = "decline" },
			"item/fileChange/requestApproval" => new { decision = "decline" },
			"item/tool/requestUserInput" => new { answers = new Dictionary<string, object>() },
			"item/tool/call" => new
			{
				success = false,
				contentItems = new object[]
				{
					new { type = "inputText", text = "Dynamic tool calls are not supported by this client." }
				}
			},
			_ => new { }
		};

		return await _rpc.SendResponseAsync(idElement, result, cancellationToken);
	}

	public async ValueTask DisposeAsync()
	{
		_initializeLock.Dispose();

		foreach (var tracker in _turnsByTurnId.Values)
		{
			tracker.Completion.TrySetException(new OperationCanceledException("Client disposed."));
		}
		_turnsByTurnId.Clear();

		await _rpc.DisposeAsync();
	}

	private sealed class TurnTracker
	{
		private readonly StringBuilder _text = new();
		private readonly object _lock = new();
		private string? _lastError;

		public string ThreadId { get; }
		public string TurnId { get; }
		public IProgress<CodexDelta>? Progress { get; }
		public TaskCompletionSource<CodexTurnResult> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

		public TurnTracker(string threadId, string turnId, IProgress<CodexDelta>? progress)
		{
			ThreadId = threadId;
			TurnId = turnId;
			Progress = progress;
		}

		public void OnDelta(string delta, string? threadId)
		{
			lock (_lock)
			{
				_text.Append(delta);
			}

			Progress?.Report(new CodexDelta(threadId ?? ThreadId, TurnId, delta));
		}

		public void OnError(string message)
		{
			lock (_lock)
			{
				_lastError = message;
			}
		}

		public void OnCompleted(string status, string? errorMessage)
		{
			string aggregated;
			string? lastError;
			lock (_lock)
			{
				aggregated = _text.ToString();
				lastError = _lastError;
			}

			var finalError = errorMessage ?? lastError;
			Completion.TrySetResult(new CodexTurnResult(ThreadId, TurnId, status, finalError, aggregated));
		}
	}
}

