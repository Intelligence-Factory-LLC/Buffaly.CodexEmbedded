using System.Buffers;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

internal sealed class MultiSessionWebCliSocketSession : IAsyncDisposable
{
	private readonly WebSocket _socket;
	private readonly WebRuntimeDefaults _defaults;
	private readonly SessionOrchestrator _orchestrator;
	private readonly string _connectionId;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);
	private readonly SemaphoreSlim _socketSendLock = new(1, 1);
	private static readonly TimeSpan SafeSocketSendTimeout = TimeSpan.FromSeconds(5);
	private string? _activeSessionId;
	private volatile CodexEventVerbosity _uiLogVerbosity = CodexEventVerbosity.Normal;
	private int _sessionListPushQueued = 0;
	private int _forcedDisconnect = 0;

	private readonly LocalLogWriter _connectionLog;

	public MultiSessionWebCliSocketSession(WebSocket socket, WebRuntimeDefaults defaults, SessionOrchestrator orchestrator, string connectionId)
	{
		_socket = socket;
		_defaults = defaults;
		_orchestrator = orchestrator;
		_connectionId = connectionId;

		_orchestrator.Broadcast += HandleOrchestratorBroadcast;
		_orchestrator.CoreEvent += HandleOrchestratorCoreEvent;
		_orchestrator.SessionsChanged += HandleOrchestratorSessionsChanged;

		var logPath = Path.Combine(_defaults.LogRootPath, $"ws-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Sanitize(connectionId)}.log");
		_connectionLog = new LocalLogWriter(logPath);
	}

	public async Task RunAsync(CancellationToken cancellationToken)
	{
		await SendEventAsync("status", new { message = "Connected." }, cancellationToken);
		await SendEventAsync("log_verbosity", new { verbosity = _uiLogVerbosity.ToString().ToLowerInvariant() }, cancellationToken);
		await WriteConnectionLogAsync("[ws] connected", cancellationToken);

		try
		{
			while (!cancellationToken.IsCancellationRequested && _socket.State == WebSocketState.Open)
			{
				var message = await ReceiveTextMessageAsync(cancellationToken);
				if (message is null)
				{
					break;
				}

				await HandleClientMessageAsync(message, cancellationToken);
			}
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
			WriteConnectionLogLocal("[ws] receive loop canceled");
		}
		catch (WebSocketException ex) when (WebSocketDisconnectClassifier.IsExpected(ex))
		{
			WriteConnectionLogLocal($"[ws] remote disconnected without close handshake: {ex.Message}");
		}
	}

	private void HandleOrchestratorBroadcast(string type, object payload)
	{
		_ = SendEventSafeAsync(type, payload);
	}

	private void HandleOrchestratorSessionsChanged()
	{
		if (Interlocked.Exchange(ref _sessionListPushQueued, 1) != 0)
		{
			return;
		}

		_ = Task.Run(async () =>
		{
			try
			{
				await Task.Delay(150);
				await SendSessionListSafeAsync();
			}
			finally
			{
				Interlocked.Exchange(ref _sessionListPushQueued, 0);
			}
		});
	}

	private void HandleOrchestratorCoreEvent(string sessionId, CodexCoreEvent ev)
	{
		if (!CodexEventLogging.ShouldInclude(ev, _uiLogVerbosity))
		{
			return;
		}

		_ = SendEventSafeAsync(
			"log",
			new
			{
				source = "core",
				sessionId,
				level = ev.Level,
				eventType = ev.Type,
				message = CodexEventLogging.Format(ev, includeTimestamp: false)
			});
	}

	private async Task HandleClientMessageAsync(string message, CancellationToken cancellationToken)
	{
		var rawMessage = $"[client] raw {Truncate(message, 800)}";
		if (_uiLogVerbosity >= CodexEventVerbosity.Trace)
		{
			await WriteConnectionLogAsync(rawMessage, cancellationToken);
		}
		else
		{
			WriteConnectionLogLocal(rawMessage);
		}

		JsonDocument document;
		try
		{
			document = JsonDocument.Parse(message);
		}
		catch (Exception ex)
		{
			await SendEventAsync("error", new { message = $"Invalid JSON: {ex.Message}" }, cancellationToken);
			return;
		}

		using (document)
		{
			var root = document.RootElement;
			var type = TryGetString(root, "type");
			if (string.IsNullOrWhiteSpace(type))
			{
				await SendEventAsync("error", new { message = "Message must include 'type'." }, cancellationToken);
				return;
			}

			switch (type)
			{
				// Back-compat aliases.
				case "start_session":
					await CreateSessionAsync(root, setActive: true, cancellationToken);
					return;
				case "stop_session":
					await StopSessionAsync(GetSessionIdOrActive(root), cancellationToken);
					return;
				case "prompt":
					await StartTurnAsync(
						GetSessionIdOrActive(root),
						TryGetString(root, "text"),
						cwd: null,
						model: null,
						effort: null,
						approvalPolicy: null,
						sandboxMode: null,
						collaborationMode: null,
						hasModelOverride: false,
						hasEffortOverride: false,
						hasApprovalOverride: false,
						hasSandboxOverride: false,
						images: null,
						cancellationToken);
					return;

				// Multi-session protocol.
				case "session_create":
					await CreateSessionAsync(root, setActive: true, cancellationToken);
					return;
				case "session_list":
					await SendSessionListAsync(cancellationToken);
					return;
				case "session_catalog_list":
					await SendSessionCatalogAsync(cancellationToken);
					return;
				case "session_attach":
					await AttachSessionAsync(root, setActive: true, cancellationToken);
					return;
				case "session_select":
					SetActiveSession(TryGetString(root, "sessionId"));
					await SendEventAsync("status", new { message = $"Active session set to {_activeSessionId ?? "(none)"}" }, cancellationToken);
					return;
				case "session_stop":
					await StopSessionAsync(TryGetString(root, "sessionId"), cancellationToken);
					return;
				case "session_rename":
					await RenameSessionAsync(TryGetString(root, "sessionId"), TryGetString(root, "threadName"), cancellationToken);
					return;
				case "session_set_model":
					await SetSessionModelAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "model"),
						TryGetString(root, "effort"),
						root.TryGetProperty("model", out _),
						root.TryGetProperty("effort", out _),
						cancellationToken);
					return;
				case "session_set_permissions":
					await SetSessionPermissionsAsync(
						TryGetString(root, "sessionId"),
						TryGetApprovalPolicyRaw(root),
						TryGetSandboxModeRaw(root),
						HasApprovalPolicyOverride(root),
						HasSandboxModeOverride(root),
						cancellationToken);
					return;
				case "turn_start":
					var hasModelOverride = root.TryGetProperty("model", out _);
					var hasEffortOverride = root.TryGetProperty("effort", out _);
					var hasApprovalOverride = HasApprovalPolicyOverride(root);
					var hasSandboxOverride = HasSandboxModeOverride(root);
					await StartTurnAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "text"),
						TryGetString(root, "cwd"),
						TryGetString(root, "model"),
						TryGetString(root, "effort"),
						TryGetApprovalPolicyRaw(root),
						TryGetSandboxModeRaw(root),
						TryGetCollaborationMode(root),
						hasModelOverride,
						hasEffortOverride,
						hasApprovalOverride,
						hasSandboxOverride,
						TryGetTurnImageInputs(root),
						cancellationToken);
					return;
				case "turn_steer":
					await SteerTurnAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "text"),
						TryGetTurnImageInputs(root),
						cancellationToken);
					return;
				case "turn_queue_add":
				{
					var hasQueuedModelOverride = root.TryGetProperty("model", out _);
					var hasQueuedEffortOverride = root.TryGetProperty("effort", out _);
					var hasQueuedApprovalOverride = HasApprovalPolicyOverride(root);
					var hasQueuedSandboxOverride = HasSandboxModeOverride(root);
					await QueueTurnAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "text"),
						TryGetString(root, "cwd"),
						TryGetString(root, "model"),
						TryGetString(root, "effort"),
						TryGetApprovalPolicyRaw(root),
						TryGetSandboxModeRaw(root),
						TryGetCollaborationMode(root),
						hasQueuedModelOverride,
						hasQueuedEffortOverride,
						hasQueuedApprovalOverride,
						hasQueuedSandboxOverride,
						TryGetTurnImageInputs(root),
						cancellationToken);
					return;
				}
				case "turn_queue_pop":
					await PopQueuedTurnForEditingAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "queueItemId"),
						cancellationToken);
					return;
				case "turn_queue_remove":
					await RemoveQueuedTurnAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "queueItemId"),
						cancellationToken);
					return;
				case "turn_cancel":
					await CancelTurnAsync(TryGetString(root, "sessionId"), cancellationToken);
					return;
				case "approval_response":
					{
						var sessionId = TryGetString(root, "sessionId") ?? _activeSessionId;
						var approvalId = TryGetString(root, "approvalId");
						var decision = TryGetString(root, "decision");
						if (!string.IsNullOrWhiteSpace(sessionId) && !string.IsNullOrWhiteSpace(decision))
						{
							_orchestrator.TryResolveApproval(sessionId, approvalId, decision);
						}
					}
					return;
				case "tool_user_input_response":
					{
						var sessionId = TryGetString(root, "sessionId") ?? _activeSessionId;
						if (string.IsNullOrWhiteSpace(sessionId))
						{
							await SendEventAsync("error", new { message = "No active session for tool user input response." }, cancellationToken);
							return;
						}

						var requestId = TryGetString(root, "requestId");
						var answersByQuestionId = TryGetToolUserInputAnswers(root);
						if (!_orchestrator.TryResolveToolUserInput(sessionId, requestId, answersByQuestionId))
						{
							await SendEventAsync("error", new { message = "No pending tool user input request was found for this response." }, cancellationToken);
							return;
						}

						await SendEventAsync("status", new
						{
							sessionId,
							message = $"Submitted tool input answers ({answersByQuestionId.Count})."
						}, cancellationToken);
					}
					return;
				case "models_list":
					await SendModelsListAsync(TryGetString(root, "sessionId"), cancellationToken);
					return;
				case "log_verbosity_set":
					await SetLogVerbosityAsync(root, cancellationToken);
					return;
				case "ping":
					await SendEventAsync("pong", new { utc = DateTimeOffset.UtcNow.ToString("O") }, cancellationToken);
					return;
				default:
					await SendEventAsync("error", new { message = $"Unknown message type: {type}" }, cancellationToken);
					return;
			}
		}
	}

	private string? GetSessionIdOrActive(JsonElement root)
	{
		return ResolveSessionId(TryGetString(root, "sessionId"));
	}

	private string? ResolveSessionId(string? sessionId)
	{
		return string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
	}

	private async Task<string?> RequireSessionIdAsync(string? sessionId, string noActiveMessage, CancellationToken cancellationToken)
	{
		var resolvedSessionId = ResolveSessionId(sessionId);
		if (!string.IsNullOrWhiteSpace(resolvedSessionId))
		{
			return resolvedSessionId;
		}

		await SendEventAsync("error", new { message = noActiveMessage }, cancellationToken);
		return null;
	}

	private async Task<string?> RequireKnownSessionIdAsync(string? sessionId, string noActiveMessage, CancellationToken cancellationToken)
	{
		var resolvedSessionId = await RequireSessionIdAsync(sessionId, noActiveMessage, cancellationToken);
		if (string.IsNullOrWhiteSpace(resolvedSessionId))
		{
			return null;
		}

		if (_orchestrator.HasSession(resolvedSessionId))
		{
			return resolvedSessionId;
		}

		await SendEventAsync("error", new { message = $"Unknown session: {resolvedSessionId}" }, cancellationToken);
		return null;
	}

	private void SetActiveSession(string? sessionId)
	{
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return;
		}

		if (_orchestrator.HasSession(sessionId))
		{
			_activeSessionId = sessionId;
		}
	}

	private async Task CreateSessionAsync(JsonElement request, bool setActive, CancellationToken cancellationToken)
	{
		var requestId = TryGetString(request, "requestId");
		var model = TryGetString(request, "model") ?? _defaults.DefaultModel;
		var effort = WebCodexUtils.NormalizeReasoningEffort(TryGetString(request, "effort"));
		var approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(TryGetApprovalPolicyRaw(request));
		var sandboxMode = WebCodexUtils.NormalizeSandboxMode(TryGetSandboxModeRaw(request));
		var cwd = TryGetString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetString(request, "codexPath") ?? _defaults.CodexPath;

		var sessionId = Guid.NewGuid().ToString("N");
		await WriteConnectionLogAsync(
			$"[session] creating id={sessionId} cwd={cwd} model={model ?? "(default)"} effort={effort ?? "(default)"} approval={approvalPolicy ?? "(default)"} sandbox={sandboxMode ?? "(default)"}",
			cancellationToken);

		SessionOrchestrator.SessionCreatedPayload created;
		try
		{
			created = await _orchestrator.CreateSessionAsync(sessionId, model, effort, approvalPolicy, sandboxMode, cwd, codexPath, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			await WriteConnectionLogAsync($"[session] failed to start id={sessionId} error={ex.Message}", cancellationToken);
			await SendEventAsync("error", new { message = $"Failed to start session: {ex.Message}" }, cancellationToken);
			return;
		}

		if (setActive)
		{
			_activeSessionId = sessionId;
		}

		await SendEventAsync("session_created", new
		{
			sessionId,
			requestId,
			threadId = created.threadId,
			model = created.model,
			reasoningEffort = created.reasoningEffort,
			approvalPolicy = created.approvalPolicy,
			sandboxPolicy = created.sandboxPolicy,
			cwd = created.cwd,
			logPath = created.logPath
		}, cancellationToken);

		// Back-compat event.
		await SendEventAsync("session_started", new
		{
			threadId = created.threadId,
			model = created.model,
			reasoningEffort = created.reasoningEffort,
			approvalPolicy = created.approvalPolicy,
			sandboxPolicy = created.sandboxPolicy,
			cwd = created.cwd,
			logPath = created.logPath
		}, cancellationToken);

		await SendSessionListAsync(cancellationToken);
	}

	private async Task AttachSessionAsync(JsonElement request, bool setActive, CancellationToken cancellationToken)
	{
		var requestId = TryGetString(request, "requestId");
		var threadId = (TryGetString(request, "threadId") ?? TryGetString(request, "id"))?.Trim();
		if (string.IsNullOrWhiteSpace(threadId))
		{
			await SendEventAsync("error", new { message = "threadId is required to attach." }, cancellationToken);
			return;
		}

		var model = TryGetString(request, "model") ?? _defaults.DefaultModel;
		var effort = WebCodexUtils.NormalizeReasoningEffort(TryGetString(request, "effort"));
		var approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(TryGetApprovalPolicyRaw(request));
		var sandboxMode = WebCodexUtils.NormalizeSandboxMode(TryGetSandboxModeRaw(request));
		var cwd = TryGetString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetString(request, "codexPath") ?? _defaults.CodexPath;

		var loadedResolution = _orchestrator.ResolveLoadedSessionForAttach(threadId);
		if (loadedResolution.Kind == SessionOrchestrator.LoadedSessionAttachResolutionKind.Ambiguous)
		{
			var candidateList = loadedResolution.CandidateSessionIds.Count > 0
				? string.Join(", ", loadedResolution.CandidateSessionIds)
				: "(none)";
			await SendEventAsync(
				"error",
				new
				{
					message = $"Attach is ambiguous: multiple loaded sessions match thread {threadId}. Candidates: {candidateList}. Stop duplicate sessions and retry."
				},
				cancellationToken);
			return;
		}

		if (loadedResolution.Kind == SessionOrchestrator.LoadedSessionAttachResolutionKind.Unavailable)
		{
			var reason = string.IsNullOrWhiteSpace(loadedResolution.Reason)
				? $"Loaded session for thread {threadId} is unavailable for attach."
				: loadedResolution.Reason;
			await SendEventAsync("error", new { message = $"Attach failed: {reason}" }, cancellationToken);
			return;
		}

		if (loadedResolution.Kind == SessionOrchestrator.LoadedSessionAttachResolutionKind.Resolved)
		{
			var existingSessionId = loadedResolution.SessionId;
			if (string.IsNullOrWhiteSpace(existingSessionId))
			{
				await SendEventAsync(
					"error",
					new
					{
						message = $"Attach failed: loaded session state for thread {threadId} is no longer available."
					},
					cancellationToken);
				return;
			}

			if (setActive)
			{
				_activeSessionId = existingSessionId;
			}

			await WriteConnectionLogAsync(
				$"[session] attach resolved existing session id={existingSessionId} threadId={threadId}",
				cancellationToken);
			await SendEventAsync("status", new { message = $"Session already loaded for thread {threadId}." }, cancellationToken);

			// Protocol contract: `session_attached` is the authoritative attach completion event
			// for both fresh attach and already-loaded attach paths.
			await SendAttachCompletionEventsAsync(
				existingSessionId,
				requestId,
				loadedResolution.ThreadId,
				loadedResolution.Model,
				loadedResolution.ReasoningEffort,
				loadedResolution.ApprovalPolicy,
				loadedResolution.SandboxPolicy,
				loadedResolution.Cwd,
				logPath: null,
				cancellationToken);
			await SendSessionListAsync(cancellationToken);
			return;
		}

		var sessionId = Guid.NewGuid().ToString("N");
		await WriteConnectionLogAsync(
			$"[session] attaching id={sessionId} threadId={threadId} cwd={cwd} model={model ?? "(default)"} effort={effort ?? "(default)"} approval={approvalPolicy ?? "(default)"} sandbox={sandboxMode ?? "(default)"}",
			cancellationToken);

		SessionOrchestrator.SessionCreatedPayload attached;
		try
		{
			attached = await _orchestrator.AttachSessionAsync(sessionId, threadId, model, effort, approvalPolicy, sandboxMode, cwd, codexPath, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			await WriteConnectionLogAsync($"[session] failed to attach id={sessionId} threadId={threadId} error={ex.Message}", cancellationToken);
			await SendEventAsync("error", new { message = $"Failed to attach session: {ex.Message}" }, cancellationToken);
			return;
		}

		if (setActive)
		{
			_activeSessionId = sessionId;
		}

		await SendAttachCompletionEventsAsync(
			sessionId,
			requestId,
			attached.threadId,
			attached.model,
			attached.reasoningEffort,
			attached.approvalPolicy,
			attached.sandboxPolicy,
			attached.cwd,
			attached.logPath,
			cancellationToken);

		await SendSessionListAsync(cancellationToken);
	}

	private async Task SendAttachCompletionEventsAsync(
		string sessionId,
		string? requestId,
		string? threadId,
		string? model,
		string? reasoningEffort,
		string? approvalPolicy,
		string? sandboxPolicy,
		string? cwd,
		string? logPath,
		CancellationToken cancellationToken)
	{
		// Protocol contract: `session_attached` is the authoritative attach completion event
		// for both fresh attach and already-loaded attach paths.
		await SendEventAsync("session_created", new
		{
			sessionId,
			requestId,
			threadId,
			model,
			reasoningEffort,
			approvalPolicy,
			sandboxPolicy,
			cwd,
			attached = true,
			logPath
		}, cancellationToken);

		await SendEventAsync("session_attached", new
		{
			sessionId,
			requestId,
			threadId,
			model,
			reasoningEffort,
			approvalPolicy,
			sandboxPolicy,
			cwd,
			logPath
		}, cancellationToken);
	}

	private async Task SendSessionCatalogAsync(CancellationToken cancellationToken)
	{
		var sessions = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: 0);
		var processingByThread = _orchestrator.GetLiveProcessingByThread();
		var payload = sessions.Select(s => new
		{
			threadId = s.ThreadId,
			threadName = s.ThreadName,
			updatedAtUtc = s.UpdatedAtUtc?.ToString("O"),
			cwd = s.Cwd,
			model = s.Model,
			sessionFilePath = s.SessionFilePath,
			isProcessing = processingByThread.TryGetValue(s.ThreadId, out var isProcessing) && isProcessing
		}).ToArray();

		await SendEventAsync("session_catalog", new
		{
			codexHomePath = CodexHomePaths.ResolveCodexHomePath(_defaults.CodexHomePath),
			sessions = payload,
			processingByThread
		}, cancellationToken);
	}

	private async Task SetSessionModelAsync(
		string? sessionId,
		string? model,
		string? effort,
		bool hasModelOverride,
		bool hasEffortOverride,
		CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireKnownSessionIdAsync(sessionId, "No active session to set model for.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		var snapshotBefore = _orchestrator.GetSessionSnapshots(includeTurnCacheStats: false).FirstOrDefault(x => string.Equals(x.SessionId, requiredSessionId, StringComparison.Ordinal));
		var currentModel = string.IsNullOrWhiteSpace(snapshotBefore?.Model) ? null : snapshotBefore.Model.Trim();
		var currentEffort = WebCodexUtils.NormalizeReasoningEffort(snapshotBefore?.ReasoningEffort);
		var targetModel = hasModelOverride ? (string.IsNullOrWhiteSpace(model) ? null : model.Trim()) : currentModel;
		var targetEffort = hasEffortOverride ? WebCodexUtils.NormalizeReasoningEffort(effort) : currentEffort;
		if (string.Equals(currentModel, targetModel, StringComparison.Ordinal) &&
			string.Equals(currentEffort, targetEffort, StringComparison.Ordinal))
		{
			return;
		}

		var normalizedModel = hasModelOverride ? targetModel : null;
		var normalizedEffort = hasEffortOverride ? targetEffort : null;
		_orchestrator.TrySetSessionModel(requiredSessionId, normalizedModel, normalizedEffort);

		var snapshot = _orchestrator.GetSessionSnapshots(includeTurnCacheStats: false).FirstOrDefault(x => string.Equals(x.SessionId, requiredSessionId, StringComparison.Ordinal));
		var threadId = snapshot?.ThreadId ?? "unknown";

		await WriteConnectionLogAsync(
			$"[session] model updated session={requiredSessionId} thread={threadId} model={(normalizedModel ?? "(default)")} effort={(normalizedEffort ?? "(default)")}",
			cancellationToken);
		await SendSessionListAsync(cancellationToken);
	}

	private async Task SetSessionPermissionsAsync(
		string? sessionId,
		string? approvalPolicy,
		string? sandboxMode,
		bool hasApprovalOverride,
		bool hasSandboxOverride,
		CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireKnownSessionIdAsync(sessionId, "No active session to set permissions for.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		var normalizedApproval = hasApprovalOverride ? WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy) : null;
		var normalizedSandbox = hasSandboxOverride ? WebCodexUtils.NormalizeSandboxMode(sandboxMode) : null;
		if (!_orchestrator.TrySetSessionPermissions(
			requiredSessionId,
			normalizedApproval,
			normalizedSandbox,
			hasApprovalOverride,
			hasSandboxOverride))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {requiredSessionId}" }, cancellationToken);
			return;
		}

		var snapshot = _orchestrator.GetSessionSnapshots(includeTurnCacheStats: false).FirstOrDefault(x => string.Equals(x.SessionId, requiredSessionId, StringComparison.Ordinal));
		var threadId = snapshot?.ThreadId ?? "unknown";
		await WriteConnectionLogAsync(
			$"[session] permissions updated session={requiredSessionId} thread={threadId} approval={(snapshot?.ApprovalPolicy ?? "(default)")} sandbox={(snapshot?.SandboxPolicy ?? "(default)")}",
			cancellationToken);
		await SendSessionListAsync(cancellationToken);
	}

	private async Task SetLogVerbosityAsync(JsonElement request, CancellationToken cancellationToken)
	{
		var verbosityRaw = TryGetString(request, "verbosity");
		if (!CodexEventLogging.TryParseVerbosity(verbosityRaw, out var parsed))
		{
			await SendEventAsync("error", new
			{
				message = $"Unknown verbosity '{verbosityRaw}'. Use errors|normal|verbose|trace."
			}, cancellationToken);
			return;
		}

		_uiLogVerbosity = parsed;
		await SendEventAsync("log_verbosity", new { verbosity = parsed.ToString().ToLowerInvariant() }, cancellationToken);
		await WriteConnectionLogAsync($"[log] verbosity set to {parsed}", cancellationToken);
	}

	private async Task SendSessionListAsync(CancellationToken cancellationToken)
	{
		var snapshots = _orchestrator.GetSessionSnapshots(includeTurnCacheStats: false);
		if (!string.IsNullOrWhiteSpace(_activeSessionId) &&
			!snapshots.Any(x => string.Equals(x.SessionId, _activeSessionId, StringComparison.Ordinal)))
		{
			_activeSessionId = null;
		}

		var sessions = snapshots
			.Select(s => (object)new
			{
				sessionId = s.SessionId,
				threadId = s.ThreadId,
				cwd = s.Cwd,
				model = s.Model,
				reasoningEffort = s.ReasoningEffort,
				approvalPolicy = s.ApprovalPolicy,
				sandboxPolicy = s.SandboxPolicy,
				isTurnInFlight = s.IsTurnInFlight,
				isTurnInFlightInferredFromLogs = s.IsTurnInFlightInferredFromLogs,
				isTurnInFlightLogOnly = s.IsTurnInFlightLogOnly,
				isAppServerRecovering = s.IsAppServerRecovering,
				pendingApproval = s.PendingApproval is { } approval
					? new
					{
						approvalId = approval.ApprovalId,
						requestType = approval.RequestType,
						summary = approval.Summary,
						reason = approval.Reason,
						cwd = approval.Cwd,
						actions = approval.Actions,
						createdAtUtc = approval.CreatedAtUtc.ToString("O")
					}
					: null,
				queuedTurnCount = s.QueuedTurnCount,
				turnCountInMemory = s.TurnCountInMemory,
				queuedTurns = s.QueuedTurns.Select(queued => new
				{
					queueItemId = queued.QueueItemId,
					previewText = queued.PreviewText,
					imageCount = queued.ImageCount,
					createdAtUtc = queued.CreatedAtUtc.ToString("O")
				}).ToArray()
			})
			.ToList();

		var processingByThread = _orchestrator.GetLiveProcessingByThread();
		await SendEventAsync("session_list", new { activeSessionId = _activeSessionId, sessions, processingByThread }, cancellationToken);
	}

	private async Task SendModelsListAsync(string? sessionId, CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;

		try
		{
			var models = await _orchestrator.ListModelsAsync(sessionId, cancellationToken);

			var payload = models.Select(m => new
			{
				model = m.Model,
				displayName = m.DisplayName,
				isDefault = m.IsDefault,
				description = m.Description
			}).ToArray();
			var configuredDefaultModel = string.IsNullOrWhiteSpace(_defaults.DefaultModel) ? null : _defaults.DefaultModel.Trim();
			var listedDefaultModel = models.FirstOrDefault(m => m.IsDefault)?.Model;
			var effectiveDefaultModel = configuredDefaultModel ?? listedDefaultModel;

			await SendEventAsync("models_list", new { sessionId, models = payload, defaultModel = effectiveDefaultModel, error = (string?)null }, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			await SendEventAsync("models_list", new { sessionId, models = Array.Empty<object>(), defaultModel = (string?)null, error = ex.Message }, cancellationToken);
		}
	}

	private async Task StartTurnAsync(
		string? sessionId,
		string? text,
		string? cwd,
		string? model,
		string? effort,
		string? approvalPolicy,
		string? sandboxMode,
		CodexCollaborationMode? collaborationMode,
		bool hasModelOverride,
		bool hasEffortOverride,
		bool hasApprovalOverride,
		bool hasSandboxOverride,
		IReadOnlyList<CodexUserImageInput>? images,
		CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireSessionIdAsync(sessionId, "No active session. Create/select a session first.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		var normalizedText = text?.Trim() ?? string.Empty;
		var normalizedCwd = string.IsNullOrWhiteSpace(cwd) ? null : cwd.Trim();
		var normalizedModel = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
		var normalizedEffort = WebCodexUtils.NormalizeReasoningEffort(effort);
		var normalizedApproval = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy);
		var normalizedSandbox = WebCodexUtils.NormalizeSandboxMode(sandboxMode);
		var normalizedCollaborationMode = NormalizeCollaborationMode(collaborationMode);
		var imageCount = images?.Count ?? 0;
		if (string.IsNullOrWhiteSpace(normalizedText) && imageCount <= 0)
		{
			await SendEventAsync("error", new { message = "Prompt text or at least one image is required." }, cancellationToken);
			return;
		}

		if (!_orchestrator.HasSession(requiredSessionId))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {requiredSessionId}" }, cancellationToken);
			return;
		}

		if (_orchestrator.TryGetSessionRecoveryState(requiredSessionId, out var isRecovering) && isRecovering)
		{
			await SendEventAsync("error", new { message = "Session is recovering from an app-server disconnect. Wait for recovery to complete and retry." }, cancellationToken);
			return;
		}

		if (_orchestrator.TryGetTurnState(requiredSessionId, out var isTurnInFlight) && isTurnInFlight)
		{
			await SendEventAsync(
				"error",
				new { message = "A turn is already running. Use turn_steer to send now or turn_queue_add to queue." },
				cancellationToken);
			return;
		}

		_orchestrator.StartTurn(
			requiredSessionId,
			normalizedText,
			normalizedCwd,
			normalizedModel,
			normalizedEffort,
			normalizedApproval,
			normalizedSandbox,
			normalizedCollaborationMode,
			hasModelOverride,
			hasEffortOverride,
			hasApprovalOverride,
			hasSandboxOverride,
			images);
	}

	private async Task SteerTurnAsync(
		string? sessionId,
		string? text,
		IReadOnlyList<CodexUserImageInput>? images,
		CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireSessionIdAsync(sessionId, "No active session. Create/select a session first.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		var normalizedText = text?.Trim() ?? string.Empty;
		var imageCount = images?.Count ?? 0;
		if (string.IsNullOrWhiteSpace(normalizedText) && imageCount <= 0)
		{
			await SendEventAsync("error", new { message = "Prompt text or at least one image is required." }, cancellationToken);
			return;
		}

		if (!_orchestrator.HasSession(requiredSessionId))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {requiredSessionId}" }, cancellationToken);
			return;
		}

		if (_orchestrator.TryGetSessionRecoveryState(requiredSessionId, out var isRecovering) && isRecovering)
		{
			await SendEventAsync("error", new { message = "Session is recovering from an app-server disconnect. Wait for recovery to complete and retry." }, cancellationToken);
			return;
		}

		if (!_orchestrator.TryGetTurnState(requiredSessionId, out var isTurnInFlight) || !isTurnInFlight)
		{
			await SendEventAsync("error", new { message = "No running turn is available to steer. Start a new turn instead." }, cancellationToken);
			return;
		}

		if (_orchestrator.TryGetTurnSteerability(requiredSessionId, out var canSteer) && !canSteer)
		{
			await SendEventAsync("error", new { message = "Active turn is not steerable right now. Use queue to stage the prompt." }, cancellationToken);
			return;
		}

		var steer = await _orchestrator.SteerTurnAsync(requiredSessionId, normalizedText, images, cancellationToken);
		if (!steer.Success)
		{
			await SendEventAsync("error", new { message = steer.ErrorMessage ?? "Failed to steer active turn." }, cancellationToken);
		}
	}

	private async Task QueueTurnAsync(
		string? sessionId,
		string? text,
		string? cwd,
		string? model,
		string? effort,
		string? approvalPolicy,
		string? sandboxMode,
		CodexCollaborationMode? collaborationMode,
		bool hasModelOverride,
		bool hasEffortOverride,
		bool hasApprovalOverride,
		bool hasSandboxOverride,
		IReadOnlyList<CodexUserImageInput>? images,
		CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireSessionIdAsync(sessionId, "No active session. Create/select a session first.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		var normalizedText = text?.Trim() ?? string.Empty;
		var normalizedCwd = string.IsNullOrWhiteSpace(cwd) ? null : cwd.Trim();
		var normalizedModel = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
		var normalizedEffort = WebCodexUtils.NormalizeReasoningEffort(effort);
		var normalizedApproval = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy);
		var normalizedSandbox = WebCodexUtils.NormalizeSandboxMode(sandboxMode);
		var normalizedCollaborationMode = NormalizeCollaborationMode(collaborationMode);
		if (!_orchestrator.HasSession(requiredSessionId))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {requiredSessionId}" }, cancellationToken);
			return;
		}

		if (!_orchestrator.TryEnqueueTurn(
			requiredSessionId,
			normalizedText,
			normalizedCwd,
			normalizedModel,
			normalizedEffort,
			normalizedApproval,
			normalizedSandbox,
			normalizedCollaborationMode,
			hasModelOverride,
			hasEffortOverride,
			hasApprovalOverride,
			hasSandboxOverride,
			images,
			out var queueItemId,
			out var error))
		{
			await SendEventAsync("error", new { message = error ?? "Failed to queue prompt." }, cancellationToken);
			return;
		}

		await SendEventAsync("status", new { sessionId = requiredSessionId, message = $"Prompt queued ({queueItemId})." }, cancellationToken);
	}

	private async Task PopQueuedTurnForEditingAsync(string? sessionId, string? queueItemId, CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireSessionIdAsync(sessionId, "No active session. Create/select a session first.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		if (!_orchestrator.TryPopQueuedTurnForEditing(requiredSessionId, queueItemId ?? string.Empty, out var payload, out var errorMessage))
		{
			await SendEventAsync("error", new { message = errorMessage ?? "Failed to edit queued prompt." }, cancellationToken);
			return;
		}

		await SendEventAsync(
			"turn_queue_edit_item",
			new
			{
				sessionId = requiredSessionId,
				queueItemId = payload!.QueueItemId,
				text = payload.Text,
				images = payload.Images.Select(x => new { url = x.Url, name = "image" }).ToArray()
			},
			cancellationToken);
	}

	private async Task RemoveQueuedTurnAsync(string? sessionId, string? queueItemId, CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireSessionIdAsync(sessionId, "No active session. Create/select a session first.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		if (!_orchestrator.TryRemoveQueuedTurn(requiredSessionId, queueItemId ?? string.Empty, out var errorMessage))
		{
			await SendEventAsync("error", new { message = errorMessage ?? "Failed to remove queued prompt." }, cancellationToken);
			return;
		}
	}

	private async Task CancelTurnAsync(string? sessionId, CancellationToken cancellationToken)
	{
		var requiredSessionId = await RequireSessionIdAsync(sessionId, "No active session to cancel.", cancellationToken);
		if (string.IsNullOrWhiteSpace(requiredSessionId))
		{
			return;
		}

		await _orchestrator.CancelTurnAsync(requiredSessionId, cancellationToken);
	}

	private async Task StopSessionAsync(string? sessionId, CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session to stop." }, cancellationToken);
			return;
		}

		if (string.Equals(_activeSessionId, sessionId, StringComparison.Ordinal))
		{
			_activeSessionId = _orchestrator.GetSessionSnapshots(includeTurnCacheStats: false)
				.Select(x => x.SessionId)
				.FirstOrDefault(x => !string.Equals(x, sessionId, StringComparison.Ordinal));
		}

		if (!_orchestrator.HasSession(sessionId))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {sessionId}" }, cancellationToken);
			return;
		}

		await _orchestrator.StopSessionAsync(sessionId, cancellationToken);
	}

	private async Task RenameSessionAsync(string? sessionId, string? threadName, CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session to rename." }, cancellationToken);
			return;
		}

		var sessionSnapshot = _orchestrator.GetSessionSnapshots(includeTurnCacheStats: false).FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.Ordinal));
		if (sessionSnapshot is null)
		{
			await SendEventAsync("error", new { message = $"Unknown session: {sessionId}" }, cancellationToken);
			return;
		}

		var normalizedName = threadName?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedName))
		{
			await SendEventAsync("error", new { message = "threadName is required." }, cancellationToken);
			return;
		}

		if (normalizedName.Length > 200)
		{
			await SendEventAsync("error", new { message = "threadName must be 200 characters or fewer." }, cancellationToken);
			return;
		}

		var threadId = sessionSnapshot.ThreadId;
		var writeResult = await CodexSessionIndexMutator.TryAppendThreadRenameAsync(
			_defaults.CodexHomePath,
			threadId,
			normalizedName,
			cancellationToken);

		if (!writeResult.Success)
		{
			await SendEventAsync("error", new { message = $"Failed to rename session: {writeResult.ErrorMessage}" }, cancellationToken);
			return;
		}

		await WriteConnectionLogAsync($"[session] renamed thread={threadId} name={normalizedName}", cancellationToken);
		await SendEventAsync("status", new { message = $"Renamed session '{threadId}' to '{normalizedName}'." }, cancellationToken);
		await SendSessionCatalogAsync(cancellationToken);
	}

	private async Task SendEventSafeAsync(string type, object payload)
	{
		try
		{
			using var timeoutCts = new CancellationTokenSource(SafeSocketSendTimeout);
			await SendEventAsync(type, payload, timeoutCts.Token);
		}
		catch (Exception ex)
		{
			HandleSafeSendFailure($"send event '{type}'", ex);
		}
	}

	private async Task SendSessionListSafeAsync()
	{
		try
		{
			using var timeoutCts = new CancellationTokenSource(SafeSocketSendTimeout);
			await SendSessionListAsync(timeoutCts.Token);
		}
		catch (Exception ex)
		{
			HandleSafeSendFailure("send session_list", ex);
		}
	}

	private void HandleSafeSendFailure(string operation, Exception ex)
	{
		var simplified = ex switch
		{
			OperationCanceledException => "timed out",
			WebSocketException wsEx => wsEx.Message,
			_ => ex.Message
		};
		WriteConnectionLogLocal($"[ws_send] {operation} failed ({simplified}) socketState={_socket.State}");
		if (_socket.State != WebSocketState.Open)
		{
			return;
		}

		if (Interlocked.Exchange(ref _forcedDisconnect, 1) != 0)
		{
			return;
		}

		WriteConnectionLogLocal("[ws_send] forcing websocket abort after send failure");
		try
		{
			_socket.Abort();
		}
		catch (Exception abortEx)
		{
			WriteConnectionLogLocal($"[ws_send] websocket abort failed: {abortEx.Message}");
		}
	}

	private async Task SendEventAsync(string type, object payload, CancellationToken cancellationToken)
	{
		var frame = new { type, payload };
		var json = JsonSerializer.Serialize(frame, _jsonOptions);
		var bytes = Encoding.UTF8.GetBytes(json);

		await _socketSendLock.WaitAsync(cancellationToken);
		try
		{
			await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
		}
		finally
		{
			_socketSendLock.Release();
		}
	}

	private async Task WriteConnectionLogAsync(string message, CancellationToken cancellationToken)
	{
		WriteConnectionLogLocal(message);
		await SendEventAsync("log", new { source = "connection", message }, cancellationToken);
	}

	private void WriteConnectionLogLocal(string message)
	{
		_connectionLog.Write(message);
		Logs.DebugLog.WriteEvent("MultiSessionWebCliSocketSession", message);
	}

	private async Task<string?> ReceiveTextMessageAsync(CancellationToken cancellationToken)
	{
		var rented = ArrayPool<byte>.Shared.Rent(8192);
		try
		{
			using var ms = new MemoryStream();
			while (true)
			{
				var segment = new ArraySegment<byte>(rented);
				var result = await _socket.ReceiveAsync(segment, cancellationToken);
				if (result.MessageType == WebSocketMessageType.Close)
				{
					return null;
				}

				if (result.MessageType != WebSocketMessageType.Text)
				{
					continue;
				}

				ms.Write(segment.Array!, segment.Offset, result.Count);
				if (result.EndOfMessage)
				{
					break;
				}
			}

			return Encoding.UTF8.GetString(ms.ToArray());
		}
		finally
		{
			ArrayPool<byte>.Shared.Return(rented);
		}
	}

	public async ValueTask DisposeAsync()
	{
		_orchestrator.Broadcast -= HandleOrchestratorBroadcast;
		_orchestrator.CoreEvent -= HandleOrchestratorCoreEvent;
		_orchestrator.SessionsChanged -= HandleOrchestratorSessionsChanged;

		_activeSessionId = null;

		_socketSendLock.Dispose();
		_connectionLog.Dispose();

		if (_socket.State == WebSocketState.Open)
		{
			try
			{
				await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
			}
			catch
			{
			}
		}
	}

	private static string? TryGetString(JsonElement root, string name)
	{
		if (root.ValueKind != JsonValueKind.Object)
		{
			return null;
		}
		if (!root.TryGetProperty(name, out var value))
		{
			return null;
		}
		if (value.ValueKind == JsonValueKind.String)
		{
			return value.GetString();
		}
		if (value.ValueKind == JsonValueKind.Null)
		{
			return null;
		}
		return value.ToString();
	}

	private static string? TryGetApprovalPolicyRaw(JsonElement root)
	{
		return TryGetString(root, "approvalPolicy")
			?? TryGetString(root, "approval_policy")
			?? TryGetString(root, "approvalMode")
			?? TryGetString(root, "approval_mode");
	}

	private static string? TryGetSandboxModeRaw(JsonElement root)
	{
		return TryGetString(root, "sandboxPolicy")
			?? TryGetString(root, "sandbox_policy")
			?? TryGetString(root, "sandboxMode")
			?? TryGetString(root, "sandbox_mode")
			?? TryGetString(root, "sandbox");
	}

	private static bool HasApprovalPolicyOverride(JsonElement root)
	{
		return root.TryGetProperty("approvalPolicy", out _) ||
			root.TryGetProperty("approval_policy", out _) ||
			root.TryGetProperty("approvalMode", out _) ||
			root.TryGetProperty("approval_mode", out _);
	}

	private static bool HasSandboxModeOverride(JsonElement root)
	{
		return root.TryGetProperty("sandboxPolicy", out _) ||
			root.TryGetProperty("sandbox_policy", out _) ||
			root.TryGetProperty("sandboxMode", out _) ||
			root.TryGetProperty("sandbox_mode", out _) ||
			root.TryGetProperty("sandbox", out _);
	}

	private static Dictionary<string, string> TryGetToolUserInputAnswers(JsonElement root)
	{
		var answersByQuestionId = new Dictionary<string, string>(StringComparer.Ordinal);
		if (root.ValueKind != JsonValueKind.Object ||
			!root.TryGetProperty("answers", out var answersElement) ||
			answersElement.ValueKind != JsonValueKind.Object)
		{
			return answersByQuestionId;
		}

		foreach (var answerProperty in answersElement.EnumerateObject())
		{
			var questionId = answerProperty.Name?.Trim();
			if (string.IsNullOrWhiteSpace(questionId))
			{
				continue;
			}

			string? answerText = null;
			if (answerProperty.Value.ValueKind == JsonValueKind.String)
			{
				answerText = answerProperty.Value.GetString();
			}
			else if (answerProperty.Value.ValueKind == JsonValueKind.Object &&
				answerProperty.Value.TryGetProperty("answers", out var nestedAnswers) &&
				nestedAnswers.ValueKind == JsonValueKind.Array)
			{
				foreach (var candidate in nestedAnswers.EnumerateArray())
				{
					if (candidate.ValueKind == JsonValueKind.String)
					{
						answerText = candidate.GetString();
						if (!string.IsNullOrWhiteSpace(answerText))
						{
							break;
						}
					}
				}
			}
			else if (answerProperty.Value.ValueKind != JsonValueKind.Null &&
				answerProperty.Value.ValueKind != JsonValueKind.Undefined)
			{
				answerText = answerProperty.Value.ToString();
			}

			if (!string.IsNullOrWhiteSpace(answerText))
			{
				answersByQuestionId[questionId] = answerText.Trim();
			}
		}

		return answersByQuestionId;
	}

	private static IReadOnlyList<CodexUserImageInput> TryGetTurnImageInputs(JsonElement root)
	{
		const int maxImages = 4;
		const int maxUrlChars = 12_000_000;
		var output = new List<CodexUserImageInput>();
		if (root.ValueKind != JsonValueKind.Object)
		{
			return output;
		}

		if (!root.TryGetProperty("images", out var imagesElement) || imagesElement.ValueKind != JsonValueKind.Array)
		{
			return output;
		}

		foreach (var item in imagesElement.EnumerateArray())
		{
			if (item.ValueKind != JsonValueKind.Object)
			{
				continue;
			}

			var url = TryGetString(item, "url")?.Trim();
			if (string.IsNullOrWhiteSpace(url))
			{
				continue;
			}

			if (url.Length > maxUrlChars)
			{
				continue;
			}

			if (url.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)
				|| url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
				|| url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
			{
				output.Add(new CodexUserImageInput(url));
				if (output.Count >= maxImages)
				{
					break;
				}
			}
		}

		return output;
	}

	private static CodexCollaborationMode? TryGetCollaborationMode(JsonElement root)
	{
		if (root.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		if (!root.TryGetProperty("collaborationMode", out var collaborationElement) &&
			!root.TryGetProperty("collaboration_mode", out collaborationElement))
		{
			return null;
		}

		if (collaborationElement.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		var mode = WebCodexUtils.NormalizeCollaborationMode(TryGetString(collaborationElement, "mode"));
		if (string.IsNullOrWhiteSpace(mode))
		{
			return null;
		}

		var settings = TryGetCollaborationSettings(collaborationElement);
		return new CodexCollaborationMode
		{
			Mode = mode,
			Settings = settings
		};
	}

	private static CodexCollaborationSettings? TryGetCollaborationSettings(JsonElement collaborationElement)
	{
		if (!collaborationElement.TryGetProperty("settings", out var settingsElement) ||
			settingsElement.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		var model = TryGetString(settingsElement, "model");
		var reasoningEffort = TryGetString(settingsElement, "reasoning_effort")
			?? TryGetString(settingsElement, "reasoningEffort");
		var developerInstructions = TryGetString(settingsElement, "developer_instructions")
			?? TryGetString(settingsElement, "developerInstructions");

		if (string.IsNullOrWhiteSpace(model) &&
			string.IsNullOrWhiteSpace(reasoningEffort) &&
			string.IsNullOrWhiteSpace(developerInstructions))
		{
			return null;
		}

		return new CodexCollaborationSettings
		{
			Model = string.IsNullOrWhiteSpace(model) ? null : model!.Trim(),
			ReasoningEffort = WebCodexUtils.NormalizeReasoningEffort(reasoningEffort),
			DeveloperInstructions = string.IsNullOrWhiteSpace(developerInstructions) ? null : developerInstructions
		};
	}

	private static CodexCollaborationMode? NormalizeCollaborationMode(CodexCollaborationMode? collaborationMode)
	{
		if (collaborationMode is null)
		{
			return null;
		}

		var mode = WebCodexUtils.NormalizeCollaborationMode(collaborationMode.Mode);
		if (string.IsNullOrWhiteSpace(mode))
		{
			return null;
		}

		return new CodexCollaborationMode
		{
			Mode = mode,
			Settings = collaborationMode.Settings
		};
	}

	private static string Sanitize(string value)
	{
		var invalid = Path.GetInvalidFileNameChars();
		var sb = new StringBuilder(value.Length);
		foreach (var ch in value)
		{
			sb.Append(invalid.Contains(ch) ? '_' : ch);
		}
		return sb.ToString();
	}

	private static string Truncate(string value, int maxLength)
	{
		if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
		{
			return value;
		}
		return value[..maxLength] + "...";
	}

}

