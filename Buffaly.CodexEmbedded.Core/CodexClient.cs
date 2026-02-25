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
	private readonly object _bufferedTurnNotificationsLock = new();
	private readonly Dictionary<string, List<TurnNotification>> _bufferedTurnNotificationsByTurnId = new(StringComparer.Ordinal);
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
					},
					capabilities = new
					{
						experimentalApi = true
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
		var normalizedApprovalPolicy = NormalizeApprovalPolicy(options.ApprovalPolicy);
		var normalizedSandboxMode = NormalizeSandboxMode(options.SandboxMode);
		var threadStartParams = new Dictionary<string, object?>();
		if (!string.IsNullOrWhiteSpace(options.Cwd))
		{
			threadStartParams["cwd"] = options.Cwd;
		}
		if (!string.IsNullOrWhiteSpace(options.Model))
		{
			threadStartParams["model"] = options.Model;
		}
		if (!string.IsNullOrWhiteSpace(normalizedApprovalPolicy))
		{
			threadStartParams["approvalPolicy"] = normalizedApprovalPolicy;
		}
		if (!string.IsNullOrWhiteSpace(normalizedSandboxMode))
		{
			threadStartParams["sandbox"] = normalizedSandboxMode;
		}

		var result = await _rpc.SendRequestAsync(
			method: "thread/start",
			@params: threadStartParams,
			cancellationToken);

		var threadId = JsonPath.GetRequiredString(result, "thread", "id");
		var resolvedApprovalPolicy = NormalizeApprovalPolicy(JsonPath.TryGetString(result, "approvalPolicy")) ?? normalizedApprovalPolicy;
		var resolvedSandboxMode = ReadSandboxModeFromResponse(result) ?? normalizedSandboxMode;
		return new CodexSession(this, threadId, options.Cwd, options.Model, resolvedApprovalPolicy, resolvedSandboxMode);
	}

	public async Task<CodexSession> AttachToSessionAsync(CodexSessionAttachOptions options, CancellationToken cancellationToken = default)
	{
		await InitializeAsync(cancellationToken);
		var normalizedApprovalPolicy = NormalizeApprovalPolicy(options.ApprovalPolicy);
		var normalizedSandboxMode = NormalizeSandboxMode(options.SandboxMode);
		var threadResumeParams = new Dictionary<string, object?>
		{
			["threadId"] = options.ThreadId
		};
		if (!string.IsNullOrWhiteSpace(options.Cwd))
		{
			threadResumeParams["cwd"] = options.Cwd;
		}
		if (!string.IsNullOrWhiteSpace(options.Model))
		{
			threadResumeParams["model"] = options.Model;
		}
		if (!string.IsNullOrWhiteSpace(normalizedApprovalPolicy))
		{
			threadResumeParams["approvalPolicy"] = normalizedApprovalPolicy;
		}
		if (!string.IsNullOrWhiteSpace(normalizedSandboxMode))
		{
			threadResumeParams["sandbox"] = normalizedSandboxMode;
		}

		// Prefer thread/resume; callers expect this to fail loudly if unsupported.
		var result = await _rpc.SendRequestAsync(
			method: "thread/resume",
			@params: threadResumeParams,
			cancellationToken);

		var threadId = JsonPath.GetRequiredString(result, "thread", "id");
		var resolvedApprovalPolicy = NormalizeApprovalPolicy(JsonPath.TryGetString(result, "approvalPolicy")) ?? normalizedApprovalPolicy;
		var resolvedSandboxMode = ReadSandboxModeFromResponse(result) ?? normalizedSandboxMode;
		return new CodexSession(this, threadId, options.Cwd, options.Model, resolvedApprovalPolicy, resolvedSandboxMode);
	}

	public async Task<bool> InterruptTurnAsync(string threadId, TimeSpan? waitForTurnStart = null, CancellationToken cancellationToken = default)
	{
		await InitializeAsync(cancellationToken);

		var normalizedThreadId = threadId?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			return false;
		}

		var wait = waitForTurnStart.GetValueOrDefault();
		var deadlineUtc = wait > TimeSpan.Zero ? DateTimeOffset.UtcNow.Add(wait) : DateTimeOffset.MinValue;

		TurnTracker? tracker = null;
		do
		{
			tracker = FindInFlightTurnByThreadId(normalizedThreadId);
			if (tracker is not null)
			{
				break;
			}

			if (wait <= TimeSpan.Zero || DateTimeOffset.UtcNow >= deadlineUtc)
			{
				return false;
			}

			await Task.Delay(75, cancellationToken);
		} while (true);

		await _rpc.SendRequestAsync(
			method: "turn/interrupt",
			@params: new
			{
				threadId = normalizedThreadId,
				turnId = tracker.TurnId
			},
			cancellationToken);

		return true;
	}

	public bool TryGetActiveTurnId(string threadId, out string? turnId)
	{
		turnId = null;
		var normalizedThreadId = threadId?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			return false;
		}

		var tracker = FindInFlightTurnByThreadId(normalizedThreadId);
		if (tracker is null)
		{
			return false;
		}

		turnId = tracker.TurnId;
		return true;
	}

	private TurnTracker? FindInFlightTurnByThreadId(string threadId)
	{
		foreach (var tracker in _turnsByTurnId.Values)
		{
			if (string.Equals(tracker.ThreadId, threadId, StringComparison.Ordinal))
			{
				return tracker;
			}
		}

		return null;
	}

	private void RouteTurnNotification(string turnId, TurnNotification notification)
	{
		if (_turnsByTurnId.TryGetValue(turnId, out var tracker))
		{
			tracker.EnqueueNotification(notification);
			return;
		}

		BufferTurnNotification(turnId, notification);

		// Close the small race where a tracker is added after the first lookup.
		if (_turnsByTurnId.TryGetValue(turnId, out tracker))
		{
			var buffered = TakeBufferedTurnNotifications(turnId);
			if (buffered.Count == 0)
			{
				return;
			}

			foreach (var bufferedNotification in buffered)
			{
				tracker.EnqueueNotification(bufferedNotification);
			}
		}
	}

	private void BufferTurnNotification(string turnId, TurnNotification notification)
	{
		lock (_bufferedTurnNotificationsLock)
		{
			if (!_bufferedTurnNotificationsByTurnId.TryGetValue(turnId, out var notifications))
			{
				notifications = new List<TurnNotification>();
				_bufferedTurnNotificationsByTurnId[turnId] = notifications;
			}

			notifications.Add(notification);
		}
	}

	private IReadOnlyList<TurnNotification> TakeBufferedTurnNotifications(string turnId)
	{
		lock (_bufferedTurnNotificationsLock)
		{
			if (!_bufferedTurnNotificationsByTurnId.TryGetValue(turnId, out var notifications))
			{
				return Array.Empty<TurnNotification>();
			}

			_bufferedTurnNotificationsByTurnId.Remove(turnId);
			return notifications;
		}
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
		var input = BuildTurnInput(text, images);
		if (input.Length == 0)
		{
			throw new ArgumentException("Either message text or at least one image is required.");
		}
		var normalizedApprovalPolicy = NormalizeApprovalPolicy(options?.ApprovalPolicy);
		var normalizedSandboxMode = NormalizeSandboxMode(options?.SandboxMode);
		var turnStartParams = new Dictionary<string, object?>
		{
			["threadId"] = threadId,
			["input"] = input
		};
		if (!string.IsNullOrWhiteSpace(options?.Model))
		{
			turnStartParams["model"] = options.Model;
		}
		if (!string.IsNullOrWhiteSpace(options?.ReasoningEffort))
		{
			turnStartParams["effort"] = options.ReasoningEffort;
		}
		if (!string.IsNullOrWhiteSpace(options?.Cwd))
		{
			turnStartParams["cwd"] = options.Cwd;
		}
		if (!string.IsNullOrWhiteSpace(normalizedApprovalPolicy))
		{
			turnStartParams["approvalPolicy"] = normalizedApprovalPolicy;
		}

		var sandboxPolicy = BuildTurnSandboxPolicy(normalizedSandboxMode);
		if (sandboxPolicy is not null)
		{
			turnStartParams["sandboxPolicy"] = sandboxPolicy;
		}
		var collaborationMode = BuildTurnCollaborationModePayload(options);
		if (collaborationMode is not null)
		{
			turnStartParams["collaborationMode"] = collaborationMode;
		}

		var turnStartResult = await _rpc.SendRequestAsync(
			method: "turn/start",
			@params: turnStartParams,
			cancellationToken);

		var turnId = JsonPath.GetRequiredString(turnStartResult, "turn", "id");
		var tracker = new TurnTracker(threadId, turnId, progress);
		if (!_turnsByTurnId.TryAdd(turnId, tracker))
		{
			throw new InvalidOperationException($"Duplicate turn id '{turnId}'.");
		}
		tracker.Prime(TakeBufferedTurnNotifications(turnId));

		try
		{
			return await tracker.Completion.Task.WaitAsync(cancellationToken);
		}
		finally
		{
			_turnsByTurnId.TryRemove(turnId, out _);
		}
	}

	internal async Task SendSteerAsync(
		string threadId,
		string expectedTurnId,
		string text,
		IReadOnlyList<CodexUserImageInput>? images,
		CancellationToken cancellationToken)
	{
		await InitializeAsync(cancellationToken);

		var normalizedThreadId = threadId?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			throw new ArgumentException("threadId is required.", nameof(threadId));
		}

		var normalizedExpectedTurnId = expectedTurnId?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedExpectedTurnId))
		{
			throw new ArgumentException("expectedTurnId is required.", nameof(expectedTurnId));
		}

		var input = BuildTurnInput(text, images);
		if (input.Length == 0)
		{
			throw new ArgumentException("Either message text or at least one image is required.");
		}

		await _rpc.SendRequestAsync(
			method: "turn/steer",
			@params: new
			{
				threadId = normalizedThreadId,
				expectedTurnId = normalizedExpectedTurnId,
				input
			},
			cancellationToken);
	}

	private static object[] BuildTurnInput(string? text, IReadOnlyList<CodexUserImageInput>? images)
	{
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
					url = image.Url.Trim()
				});
			}
		}

		return input.ToArray();
	}

	private static object? BuildTurnSandboxPolicy(string? sandboxMode)
	{
		var normalized = NormalizeSandboxMode(sandboxMode);
		return normalized switch
		{
			"read-only" => new Dictionary<string, object?>
			{
				["type"] = "readOnly"
			},
			"workspace-write" => new Dictionary<string, object?>
			{
				["type"] = "workspaceWrite"
			},
			"danger-full-access" => new Dictionary<string, object?>
			{
				["type"] = "dangerFullAccess"
			},
			_ => null
		};
	}

	private static object? BuildTurnCollaborationModePayload(CodexTurnOptions? options)
	{
		var mode = NormalizeCollaborationMode(options?.CollaborationMode?.Mode);
		if (string.IsNullOrWhiteSpace(mode))
		{
			return null;
		}

		var settings = BuildTurnCollaborationSettingsPayload(options, options?.CollaborationMode?.Settings);
		return new Dictionary<string, object?>
		{
			["mode"] = mode,
			["settings"] = settings
		};
	}

	private static object BuildTurnCollaborationSettingsPayload(CodexTurnOptions? options, CodexCollaborationSettings? overrideSettings)
	{
		var model = !string.IsNullOrWhiteSpace(overrideSettings?.Model)
			? overrideSettings!.Model
			: options?.Model;
		var reasoningEffort = !string.IsNullOrWhiteSpace(overrideSettings?.ReasoningEffort)
			? overrideSettings!.ReasoningEffort
			: options?.ReasoningEffort;
		var developerInstructions = overrideSettings?.DeveloperInstructions;
		var settings = new Dictionary<string, object?>();
		if (!string.IsNullOrWhiteSpace(model))
		{
			settings["model"] = model;
		}
		if (!string.IsNullOrWhiteSpace(reasoningEffort))
		{
			settings["reasoning_effort"] = reasoningEffort;
		}
		if (developerInstructions is not null)
		{
			settings["developer_instructions"] = developerInstructions;
		}

		return settings;
	}

	private static string? ReadSandboxModeFromResponse(JsonElement root)
	{
		if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("sandbox", out var sandbox))
		{
			return null;
		}

		if (sandbox.ValueKind == JsonValueKind.String)
		{
			return NormalizeSandboxMode(sandbox.GetString());
		}

		if (sandbox.ValueKind == JsonValueKind.Object)
		{
			if (sandbox.TryGetProperty("type", out var typeElement))
			{
				return NormalizeSandboxMode(typeElement.ToString());
			}

			if (sandbox.TryGetProperty("mode", out var modeElement))
			{
				return NormalizeSandboxMode(modeElement.ToString());
			}

			if (sandbox.TryGetProperty("kind", out var kindElement))
			{
				return NormalizeSandboxMode(kindElement.ToString());
			}

			foreach (var property in sandbox.EnumerateObject())
			{
				if (property.Value.ValueKind != JsonValueKind.Object)
				{
					continue;
				}

				return NormalizeSandboxMode(property.Name);
			}
		}

		return null;
	}

	private static string? NormalizeApprovalPolicy(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant();
		return normalized switch
		{
			"untrusted" => "untrusted",
			"on-failure" => "on-failure",
			"onfailure" => "on-failure",
			"on-request" => "on-request",
			"onrequest" => "on-request",
			"never" => "never",
			_ => null
		};
	}

	private static string? NormalizeSandboxMode(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant().Replace("_", "-");
		return normalized switch
		{
			"read-only" => "read-only",
			"readonly" => "read-only",
			"read only" => "read-only",
			"workspace-write" => "workspace-write",
			"workspacewrite" => "workspace-write",
			"workspace write" => "workspace-write",
			"danger-full-access" => "danger-full-access",
			"dangerfullaccess" => "danger-full-access",
			"danger full access" => "danger-full-access",
			"dangerfull" => "danger-full-access",
			_ => null
		};
	}

	private static string? NormalizeCollaborationMode(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant();
		return normalized switch
		{
			"plan" => "plan",
			"default" => "default",
			_ => null
		};
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

					if (!string.IsNullOrEmpty(delta) && !string.IsNullOrEmpty(turnId))
					{
						RouteTurnNotification(turnId, TurnNotification.ForDelta(threadId, delta));
					}
					return;
				}
				case "turn/completed":
				case "codex/event/task_complete":
				case "codex/event/turn_complete":
				{
					if (!TryParseCompletionNotification(method, paramsElement, out var completion))
					{
						return;
					}

					RouteTurnNotification(
						completion.TurnId,
						TurnNotification.ForCompleted(completion.ThreadId, completion.Status, completion.ErrorMessage));

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
					var turnId = JsonPath.TryGetString(paramsElement, "turnId")
						?? JsonPath.TryGetString(paramsElement, "turn", "id");
					var threadId = JsonPath.TryGetString(paramsElement, "threadId")
						?? JsonPath.TryGetString(paramsElement, "turn", "threadId");
					var willRetry = TryReadOptionalBool(paramsElement, "willRetry");

					if (!string.IsNullOrWhiteSpace(composite))
					{
						foreach (var tracker in _turnsByTurnId.Values)
						{
							tracker.OnError(composite);
						}
					}

					// Some providers emit a terminal error without a separate turn-completed event.
					// When retry has been exhausted, close the turn tracker immediately.
					if (!string.IsNullOrWhiteSpace(turnId) && willRetry == false)
					{
						RouteTurnNotification(
							turnId,
							TurnNotification.ForCompleted(
								threadId,
								status: "failed",
								errorMessage: string.IsNullOrWhiteSpace(composite) ? "Turn failed." : composite));
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

	private static bool TryParseCompletionNotification(string method, JsonElement paramsElement, out CompletionNotification completion)
	{
		completion = default;

		if (string.Equals(method, "turn/completed", StringComparison.Ordinal))
		{
			var turnId = JsonPath.TryGetString(paramsElement, "turn", "id");
			if (string.IsNullOrWhiteSpace(turnId))
			{
				turnId = JsonPath.TryGetString(paramsElement, "turnId");
			}

			if (string.IsNullOrWhiteSpace(turnId))
			{
				return false;
			}

			var status = JsonPath.TryGetString(paramsElement, "turn", "status") ?? "unknown";
			var errorMessage = JsonPath.TryGetString(paramsElement, "turn", "error", "message");
			var threadId = JsonPath.TryGetString(paramsElement, "threadId");

			completion = new CompletionNotification(turnId, threadId, status, errorMessage);
			return true;
		}

		if (!string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/turn_complete", StringComparison.Ordinal))
		{
			return false;
		}

		var eventTurnId = JsonPath.TryGetString(paramsElement, "msg", "turn_id")
			?? JsonPath.TryGetString(paramsElement, "msg", "turnId")
			?? JsonPath.TryGetString(paramsElement, "id")
			?? JsonPath.TryGetString(paramsElement, "turnId");
		if (string.IsNullOrWhiteSpace(eventTurnId))
		{
			return false;
		}

		var eventStatus = JsonPath.TryGetString(paramsElement, "msg", "status");
		if (string.IsNullOrWhiteSpace(eventStatus))
		{
			eventStatus = string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal)
				? "completed"
				: "unknown";
		}

		var eventErrorMessage =
			JsonPath.TryGetString(paramsElement, "msg", "error", "message")
			?? JsonPath.TryGetString(paramsElement, "msg", "errorMessage")
			?? JsonPath.TryGetString(paramsElement, "error", "message")
			?? JsonPath.TryGetString(paramsElement, "errorMessage")
			?? TryReadPrimitiveString(paramsElement, "msg", "error")
			?? TryReadPrimitiveString(paramsElement, "error");

		var eventThreadId = JsonPath.TryGetString(paramsElement, "threadId")
			?? JsonPath.TryGetString(paramsElement, "msg", "thread_id")
			?? JsonPath.TryGetString(paramsElement, "msg", "threadId")
			?? JsonPath.TryGetString(paramsElement, "conversationId");

		completion = new CompletionNotification(eventTurnId, eventThreadId, eventStatus, eventErrorMessage);
		return true;
	}

	private static string? TryReadPrimitiveString(JsonElement root, params string[] path)
	{
		if (path is null || path.Length == 0)
		{
			return null;
		}

		var current = root;
		foreach (var segment in path)
		{
			if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
			{
				return null;
			}
		}

		return current.ValueKind switch
		{
			JsonValueKind.String => current.GetString(),
			JsonValueKind.Number => current.ToString(),
			JsonValueKind.True => "true",
			JsonValueKind.False => "false",
			_ => null
		};
	}

	private static bool? TryReadOptionalBool(JsonElement root, params string[] path)
	{
		if (path is null || path.Length == 0)
		{
			return null;
		}

		var current = root;
		foreach (var segment in path)
		{
			if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
			{
				return null;
			}
		}

		return current.ValueKind switch
		{
			JsonValueKind.True => true,
			JsonValueKind.False => false,
			JsonValueKind.String when bool.TryParse(current.GetString(), out var parsed) => parsed,
			_ => null
		};
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
			"item/tool/request_user_input" => new { answers = new Dictionary<string, object>() },
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

	private enum TurnNotificationKind
	{
		Delta,
		Completed
	}

	private readonly record struct CompletionNotification(
		string TurnId,
		string? ThreadId,
		string Status,
		string? ErrorMessage);

	private readonly struct TurnNotification
	{
		public TurnNotificationKind Kind { get; }
		public string? ThreadId { get; }
		public string? Delta { get; }
		public string Status { get; }
		public string? ErrorMessage { get; }

		private TurnNotification(TurnNotificationKind kind, string? threadId, string? delta, string status, string? errorMessage)
		{
			Kind = kind;
			ThreadId = threadId;
			Delta = delta;
			Status = status;
			ErrorMessage = errorMessage;
		}

		public static TurnNotification ForDelta(string? threadId, string delta)
		{
			return new TurnNotification(TurnNotificationKind.Delta, threadId, delta, "unknown", errorMessage: null);
		}

		public static TurnNotification ForCompleted(string? threadId, string status, string? errorMessage)
		{
			return new TurnNotification(TurnNotificationKind.Completed, threadId, delta: null, status, errorMessage);
		}
	}

	private sealed class TurnTracker
	{
		private static readonly TimeSpan DeferredCompletionDelay = TimeSpan.FromMilliseconds(50);
		private readonly StringBuilder _text = new();
		private readonly object _lock = new();
		private readonly List<TurnNotification> _queuedNotifications = new();
		private string? _lastError;
		private bool _isPrimed;
		private bool _hasDeferredCompletion;
		private string _deferredCompletionStatus = "unknown";
		private string? _deferredCompletionErrorMessage;
		private bool _deferredCompletionScheduled;

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

		public void Prime(IReadOnlyList<TurnNotification> bufferedNotifications)
		{
			lock (_lock)
			{
				if (_isPrimed)
				{
					return;
				}

				if (bufferedNotifications.Count > 0)
				{
					if (_queuedNotifications.Count == 0)
					{
						_queuedNotifications.AddRange(bufferedNotifications);
					}
					else
					{
						_queuedNotifications.InsertRange(0, bufferedNotifications);
					}
				}

				_isPrimed = true;
				foreach (var notification in _queuedNotifications)
				{
					ApplyNotificationLocked(notification);
				}
				_queuedNotifications.Clear();
			}
		}

		public void EnqueueNotification(TurnNotification notification)
		{
			lock (_lock)
			{
				if (!_isPrimed)
				{
					_queuedNotifications.Add(notification);
					return;
				}

				ApplyNotificationLocked(notification);
			}
		}

		public void OnError(string message)
		{
			lock (_lock)
			{
				_lastError = message;
			}
		}

		private void ApplyNotificationLocked(TurnNotification notification)
		{
			switch (notification.Kind)
			{
				case TurnNotificationKind.Delta:
				{
					if (string.IsNullOrEmpty(notification.Delta))
					{
						return;
					}

					_text.Append(notification.Delta);
					Progress?.Report(new CodexDelta(notification.ThreadId ?? ThreadId, TurnId, notification.Delta));

					// Guard against out-of-order notification timing where completion is observed before
					// the first delta for a turn. Finalize once delta text is available.
					if (_hasDeferredCompletion)
					{
						CompleteTurnLocked(_deferredCompletionStatus, _deferredCompletionErrorMessage);
					}
					return;
				}
				case TurnNotificationKind.Completed:
				{
					var finalError = notification.ErrorMessage ?? _lastError;
					if (_text.Length == 0 &&
						string.IsNullOrWhiteSpace(finalError) &&
						string.Equals(notification.Status, "completed", StringComparison.OrdinalIgnoreCase))
					{
						_hasDeferredCompletion = true;
						_deferredCompletionStatus = notification.Status;
						_deferredCompletionErrorMessage = finalError;
						ScheduleDeferredCompletion();
						return;
					}

					CompleteTurnLocked(notification.Status, finalError);
					return;
				}
				default:
					return;
			}
		}

		private void CompleteTurnLocked(string status, string? errorMessage)
		{
			if (Completion.Task.IsCompleted)
			{
				return;
			}

			_hasDeferredCompletion = false;
			var aggregated = _text.ToString();
			Completion.TrySetResult(new CodexTurnResult(ThreadId, TurnId, status, errorMessage, aggregated));
		}

		private void ScheduleDeferredCompletion()
		{
			if (_deferredCompletionScheduled)
			{
				return;
			}

			_deferredCompletionScheduled = true;
			_ = Task.Run(async () =>
			{
				try
				{
					await Task.Delay(DeferredCompletionDelay);
					lock (_lock)
					{
						if (_hasDeferredCompletion)
						{
							CompleteTurnLocked(_deferredCompletionStatus, _deferredCompletionErrorMessage);
						}
					}
				}
				catch
				{
				}
				finally
				{
					lock (_lock)
					{
						_deferredCompletionScheduled = false;
					}
				}
			});
		}
	}
}

