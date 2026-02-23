using System.Buffers;
using System.Collections.Concurrent;
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
	private static readonly object _recoveryLock = new();
	private static DateTimeOffset _recoveryLastRefreshedUtc = DateTimeOffset.MinValue;
	private static Dictionary<string, RecoveredRunningState> _recoveredRunningByThreadId = new(StringComparer.Ordinal);
	private static readonly TimeSpan SafeSocketSendTimeout = TimeSpan.FromSeconds(5);
	private string? _activeSessionId;
	private volatile CodexEventVerbosity _uiLogVerbosity = CodexEventVerbosity.Normal;
	private int _sessionListPushQueued = 0;

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
					await StartTurnAsync(GetSessionIdOrActive(root), TryGetString(root, "text"), cwd: null, model: null, effort: null, hasModelOverride: false, hasEffortOverride: false, images: null, cancellationToken);
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
				case "turn_start":
					var hasModelOverride = root.TryGetProperty("model", out _);
					var hasEffortOverride = root.TryGetProperty("effort", out _);
					await StartTurnAsync(
						TryGetString(root, "sessionId"),
						TryGetString(root, "text"),
						TryGetString(root, "cwd"),
						TryGetString(root, "model"),
						TryGetString(root, "effort"),
						hasModelOverride,
						hasEffortOverride,
						TryGetTurnImageInputs(root),
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
		var sessionId = TryGetString(root, "sessionId");
		if (!string.IsNullOrWhiteSpace(sessionId))
		{
			return sessionId;
		}
		return _activeSessionId;
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
		var cwd = TryGetString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetString(request, "codexPath") ?? _defaults.CodexPath;

		var sessionId = Guid.NewGuid().ToString("N");
		await WriteConnectionLogAsync($"[session] creating id={sessionId} cwd={cwd} model={model ?? "(default)"} effort={effort ?? "(default)"}", cancellationToken);

		SessionOrchestrator.SessionCreatedPayload created;
		try
		{
			created = await _orchestrator.CreateSessionAsync(sessionId, model, effort, cwd, codexPath, cancellationToken);
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
			cwd = created.cwd,
			logPath = created.logPath
		}, cancellationToken);

		// Back-compat event.
		await SendEventAsync("session_started", new
		{
			threadId = created.threadId,
			model = created.model,
			reasoningEffort = created.reasoningEffort,
			cwd = created.cwd,
			logPath = created.logPath
		}, cancellationToken);

		await SendSessionListAsync(cancellationToken);
	}

	private async Task AttachSessionAsync(JsonElement request, bool setActive, CancellationToken cancellationToken)
	{
		var requestId = TryGetString(request, "requestId");
		var threadId = TryGetString(request, "threadId") ?? TryGetString(request, "id");
		if (string.IsNullOrWhiteSpace(threadId))
		{
			await SendEventAsync("error", new { message = "threadId is required to attach." }, cancellationToken);
			return;
		}

		var model = TryGetString(request, "model") ?? _defaults.DefaultModel;
		var effort = WebCodexUtils.NormalizeReasoningEffort(TryGetString(request, "effort"));
		var cwd = TryGetString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetString(request, "codexPath") ?? _defaults.CodexPath;

		var existingSessionId = _orchestrator.FindLoadedSessionIdByThreadId(threadId);
		if (!string.IsNullOrWhiteSpace(existingSessionId) && setActive)
		{
			_activeSessionId = existingSessionId;
		}

		if (!string.IsNullOrWhiteSpace(existingSessionId))
		{
			await SendEventAsync("status", new { message = $"Session already loaded for thread {threadId}." }, cancellationToken);
			await SendSessionListAsync(cancellationToken);
			return;
		}

		var sessionId = Guid.NewGuid().ToString("N");
		await WriteConnectionLogAsync($"[session] attaching id={sessionId} threadId={threadId} cwd={cwd} model={model ?? "(default)"} effort={effort ?? "(default)"}", cancellationToken);

		SessionOrchestrator.SessionCreatedPayload attached;
		try
		{
			attached = await _orchestrator.AttachSessionAsync(sessionId, threadId, model, effort, cwd, codexPath, cancellationToken);
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

		await SendEventAsync("session_created", new
		{
			sessionId,
			requestId,
			threadId = attached.threadId,
			model = attached.model,
			reasoningEffort = attached.reasoningEffort,
			cwd = attached.cwd,
			attached = true,
			logPath = attached.logPath
		}, cancellationToken);

		await SendEventAsync("session_attached", new
		{
			sessionId,
			requestId,
			threadId = attached.threadId,
			model = attached.model,
			reasoningEffort = attached.reasoningEffort,
			cwd = attached.cwd,
			logPath = attached.logPath
		}, cancellationToken);

		await SendSessionListAsync(cancellationToken);
	}

	private async Task SendSessionCatalogAsync(CancellationToken cancellationToken)
	{
		var sessions = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: 0);
		var processingByThread = BuildProcessingByThreadMap();
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
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session to set model for." }, cancellationToken);
			return;
		}

		if (!_orchestrator.HasSession(sessionId))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {sessionId}" }, cancellationToken);
			return;
		}

		var snapshotBefore = _orchestrator.GetSessionSnapshots().FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.Ordinal));
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
		_orchestrator.TrySetSessionModel(sessionId, normalizedModel, normalizedEffort);

		var snapshot = _orchestrator.GetSessionSnapshots().FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.Ordinal));
		var threadId = snapshot?.ThreadId ?? "unknown";

		await WriteConnectionLogAsync(
			$"[session] model updated session={sessionId} thread={threadId} model={(normalizedModel ?? "(default)")} effort={(normalizedEffort ?? "(default)")}",
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
		var sessions = _orchestrator.GetSessionSnapshots()
			.Select(s => (object)new
			{
				sessionId = s.SessionId,
				threadId = s.ThreadId,
				cwd = s.Cwd,
				model = s.Model,
				reasoningEffort = s.ReasoningEffort,
				isTurnInFlight = s.IsTurnInFlight,
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
					: null
			})
			.ToList();

		var processingByThread = BuildProcessingByThreadMap();
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

			await SendEventAsync("models_list", new { sessionId, models = payload, error = (string?)null }, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			await SendEventAsync("models_list", new { sessionId, models = Array.Empty<object>(), error = ex.Message }, cancellationToken);
		}
	}

	private async Task StartTurnAsync(
		string? sessionId,
		string? text,
		string? cwd,
		string? model,
		string? effort,
		bool hasModelOverride,
		bool hasEffortOverride,
		IReadOnlyList<CodexUserImageInput>? images,
		CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session. Create/select a session first." }, cancellationToken);
			return;
		}

		var normalizedText = text?.Trim() ?? string.Empty;
		var normalizedCwd = string.IsNullOrWhiteSpace(cwd) ? null : cwd.Trim();
		var normalizedModel = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
		var normalizedEffort = WebCodexUtils.NormalizeReasoningEffort(effort);
		var imageCount = images?.Count ?? 0;
		if (string.IsNullOrWhiteSpace(normalizedText) && imageCount <= 0)
		{
			await SendEventAsync("error", new { message = "Prompt text or at least one image is required." }, cancellationToken);
			return;
		}

		if (!_orchestrator.HasSession(sessionId))
		{
			await SendEventAsync("error", new { message = $"Unknown session: {sessionId}" }, cancellationToken);
			return;
		}

		_orchestrator.QueueTurn(
			sessionId,
			normalizedText,
			normalizedCwd,
			normalizedModel,
			normalizedEffort,
			hasModelOverride,
			hasEffortOverride,
			images);
	}

	private async Task CancelTurnAsync(string? sessionId, CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session to cancel." }, cancellationToken);
			return;
		}

		await _orchestrator.CancelTurnAsync(sessionId, cancellationToken);
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
			_activeSessionId = _orchestrator.GetSessionSnapshots()
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

		var sessionSnapshot = _orchestrator.GetSessionSnapshots().FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.Ordinal));
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
		catch
		{
		}
	}

	private async Task SendSessionListSafeAsync()
	{
		try
		{
			using var timeoutCts = new CancellationTokenSource(SafeSocketSendTimeout);
			await SendSessionListAsync(timeoutCts.Token);
		}
		catch
		{
		}
	}

	private Dictionary<string, bool> BuildProcessingByThreadMap()
	{
		var processingByThread = _orchestrator.GetLiveProcessingByThread();
		var liveThreadIds = new HashSet<string>(processingByThread.Keys, StringComparer.Ordinal);

		var recovered = GetRecoveredRunningByThreadId();
		foreach (var kvp in recovered)
		{
			if (liveThreadIds.Contains(kvp.Key))
			{
				continue;
			}

			processingByThread[kvp.Key] = kvp.Value.IsProcessing;
		}

		return processingByThread;
	}

	private Dictionary<string, RecoveredRunningState> GetRecoveredRunningByThreadId()
	{
		var nowUtc = DateTimeOffset.UtcNow;
		var refreshEvery = TimeSpan.FromSeconds(_defaults.RunningRecoveryRefreshSeconds);
		lock (_recoveryLock)
		{
			if ((nowUtc - _recoveryLastRefreshedUtc) <= refreshEvery)
			{
				return new Dictionary<string, RecoveredRunningState>(_recoveredRunningByThreadId, StringComparer.Ordinal);
			}
		}

		var rebuilt = RebuildRecoveredRunningByThreadId(nowUtc);
		lock (_recoveryLock)
		{
			_recoveredRunningByThreadId = rebuilt;
			_recoveryLastRefreshedUtc = nowUtc;
			return new Dictionary<string, RecoveredRunningState>(_recoveredRunningByThreadId, StringComparer.Ordinal);
		}
	}

	private Dictionary<string, RecoveredRunningState> RebuildRecoveredRunningByThreadId(DateTimeOffset nowUtc)
	{
		var output = new Dictionary<string, RecoveredRunningState>(StringComparer.Ordinal);
		var activeWindow = TimeSpan.FromMinutes(_defaults.RunningRecoveryActiveWindowMinutes);
		var sessions = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: _defaults.RunningRecoveryScanMaxSessions);

		foreach (var session in sessions)
		{
			if (string.IsNullOrWhiteSpace(session.ThreadId) || string.IsNullOrWhiteSpace(session.SessionFilePath))
			{
				continue;
			}

			var path = session.SessionFilePath!;
			if (!File.Exists(path))
			{
				continue;
			}

			if (session.UpdatedAtUtc.HasValue && (nowUtc - session.UpdatedAtUtc.Value) > activeWindow)
			{
				continue;
			}

			JsonlWatchResult tail;
			try
			{
				tail = JsonlFileTailReader.ReadInitial(path, _defaults.RunningRecoveryTailLineLimit);
			}
			catch
			{
				continue;
			}

			var analysis = CodexTaskStateRecovery.AnalyzeJsonLines(tail.Lines);
			if (!CodexTaskStateRecovery.IsLikelyProcessing(analysis, nowUtc, activeWindow))
			{
				continue;
			}

			output[session.ThreadId] = new RecoveredRunningState(
				IsProcessing: true,
				OutstandingTaskCount: analysis.OutstandingTaskCount,
				LastTaskEventAtUtc: analysis.LastTaskEventAtUtc);
		}

		return output;
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

	private sealed record RecoveredRunningState(
		bool IsProcessing,
		int OutstandingTaskCount,
		DateTimeOffset? LastTaskEventAtUtc);

}

