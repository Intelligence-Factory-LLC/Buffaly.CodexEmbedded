using System.Collections.Concurrent;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

internal sealed class SessionOrchestrator : IAsyncDisposable
{
	private readonly WebRuntimeDefaults _defaults;
	private readonly object _sync = new();
	private readonly Dictionary<string, ManagedSession> _sessions = new(StringComparer.Ordinal);

	public event Action? SessionsChanged;
	public event Action<string, object>? Broadcast;

	public SessionOrchestrator(WebRuntimeDefaults defaults)
	{
		_defaults = defaults;
	}

	public bool HasSession(string sessionId)
	{
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		lock (_sync)
		{
			return _sessions.ContainsKey(sessionId);
		}
	}

	public IReadOnlyList<SessionSnapshot> GetSessionSnapshots()
	{
		lock (_sync)
		{
			return _sessions.Values
				.Select(s => s.ToSnapshot())
				.ToList();
		}
	}

	public Dictionary<string, bool> GetLiveProcessingByThread()
	{
		var output = new Dictionary<string, bool>(StringComparer.Ordinal);
		lock (_sync)
		{
			foreach (var s in _sessions.Values)
			{
				var threadId = s.Session.ThreadId;
				if (string.IsNullOrWhiteSpace(threadId))
				{
					continue;
				}

				output[threadId] = s.IsTurnInFlight;
			}
		}

		return output;
	}

	public async Task<SessionCreatedPayload> CreateSessionAsync(
		string sessionId,
		string? model,
		string? effort,
		string? cwd,
		string? codexPath,
		CancellationToken cancellationToken)
	{
		model = string.IsNullOrWhiteSpace(model) ? _defaults.DefaultModel : model.Trim();
		effort = WebCodexUtils.NormalizeReasoningEffort(effort);
		cwd = string.IsNullOrWhiteSpace(cwd) ? _defaults.DefaultCwd : cwd.Trim();
		codexPath = string.IsNullOrWhiteSpace(codexPath) ? _defaults.CodexPath : codexPath.Trim();

		var sessionLogPath = Path.Combine(_defaults.LogRootPath, $"session-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{sessionId}.log");
		var sessionLog = new LocalLogWriter(sessionLogPath);
		var pendingApprovals = new ConcurrentDictionary<string, TaskCompletionSource<string>>(StringComparer.Ordinal);

		CodexClient client;
		CodexSession session;
		try
		{
			var clientOptions = new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = _defaults.CodexHomePath,
				ServerRequestHandler = async (req, ct) =>
				{
					return await HandleServerRequestAsync(sessionId, sessionLog, pendingApprovals, req, ct);
				}
			};

			client = await CodexClient.StartAsync(clientOptions, cancellationToken);
			client.OnEvent += ev =>
			{
				HandleCoreEvent(sessionId, sessionLog, ev);
			};

			session = await client.CreateSessionAsync(new CodexSessionCreateOptions
			{
				Cwd = cwd,
				Model = model
			}, cancellationToken);
		}
		catch
		{
			sessionLog.Dispose();
			throw;
		}

		var managed = new ManagedSession(sessionId, client, session, cwd, model, effort, sessionLog, pendingApprovals);
		lock (_sync)
		{
			_sessions[sessionId] = managed;
		}

		SessionsChanged?.Invoke();

		return new SessionCreatedPayload(
			sessionId: sessionId,
			threadId: session.ThreadId,
			model: model,
			reasoningEffort: effort,
			cwd: cwd,
			logPath: sessionLogPath,
			attached: false);
	}

	public async Task<SessionCreatedPayload> AttachSessionAsync(
		string sessionId,
		string threadId,
		string? model,
		string? effort,
		string? cwd,
		string? codexPath,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(threadId))
		{
			throw new ArgumentException("threadId is required.", nameof(threadId));
		}

		model = string.IsNullOrWhiteSpace(model) ? _defaults.DefaultModel : model.Trim();
		effort = WebCodexUtils.NormalizeReasoningEffort(effort);
		cwd = string.IsNullOrWhiteSpace(cwd) ? _defaults.DefaultCwd : cwd.Trim();
		codexPath = string.IsNullOrWhiteSpace(codexPath) ? _defaults.CodexPath : codexPath.Trim();

		var sessionLogPath = Path.Combine(_defaults.LogRootPath, $"session-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{sessionId}.log");
		var sessionLog = new LocalLogWriter(sessionLogPath);
		var pendingApprovals = new ConcurrentDictionary<string, TaskCompletionSource<string>>(StringComparer.Ordinal);

		CodexClient client;
		CodexSession session;
		try
		{
			var clientOptions = new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = _defaults.CodexHomePath,
				ServerRequestHandler = async (req, ct) =>
				{
					return await HandleServerRequestAsync(sessionId, sessionLog, pendingApprovals, req, ct);
				}
			};

			client = await CodexClient.StartAsync(clientOptions, cancellationToken);
			client.OnEvent += ev =>
			{
				HandleCoreEvent(sessionId, sessionLog, ev);
			};

			session = await client.AttachToSessionAsync(new CodexSessionAttachOptions
			{
				ThreadId = threadId,
				Cwd = cwd,
				Model = model
			}, cancellationToken);
		}
		catch
		{
			sessionLog.Dispose();
			throw;
		}

		var managed = new ManagedSession(sessionId, client, session, cwd, model, effort, sessionLog, pendingApprovals);
		lock (_sync)
		{
			_sessions[sessionId] = managed;
		}

		SessionsChanged?.Invoke();

		return new SessionCreatedPayload(
			sessionId: sessionId,
			threadId: session.ThreadId,
			model: model,
			reasoningEffort: effort,
			cwd: cwd,
			logPath: sessionLogPath,
			attached: true);
	}

	public string? FindLoadedSessionIdByThreadId(string threadId)
	{
		if (string.IsNullOrWhiteSpace(threadId))
		{
			return null;
		}

		lock (_sync)
		{
			var existing = _sessions.Values.FirstOrDefault(x => string.Equals(x.Session.ThreadId, threadId, StringComparison.Ordinal));
			return existing?.SessionId;
		}
	}

	public bool TryGetTurnState(string sessionId, out bool isTurnInFlight)
	{
		isTurnInFlight = false;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		lock (_sync)
		{
			if (!_sessions.TryGetValue(sessionId, out var s))
			{
				return false;
			}

			isTurnInFlight = s.IsTurnInFlight;
			return true;
		}
	}

	public bool TrySetSessionModel(string sessionId, string? model, string? effort)
	{
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		lock (_sync)
		{
			if (!_sessions.TryGetValue(sessionId, out var s))
			{
				return false;
			}

			if (model is not null)
			{
				s.SetModel(model);
			}
			if (effort is not null)
			{
				s.SetReasoningEffort(effort);
			}
			return true;
		}
	}

	public async Task<IReadOnlyList<CodexModelInfo>> ListModelsAsync(string? sessionId, CancellationToken cancellationToken)
	{
		CodexClient? existingClient = null;
		if (!string.IsNullOrWhiteSpace(sessionId))
		{
			lock (_sync)
			{
				if (_sessions.TryGetValue(sessionId, out var s))
				{
					existingClient = s.Client;
				}
			}
		}

		if (existingClient is not null)
		{
			return await existingClient.ListModelsAsync(cancellationToken: cancellationToken);
		}

		await using var client = await CodexClient.StartAsync(new CodexClientOptions
		{
			CodexPath = _defaults.CodexPath,
			WorkingDirectory = _defaults.DefaultCwd,
			CodexHomePath = _defaults.CodexHomePath
		}, cancellationToken);

		return await client.ListModelsAsync(cancellationToken: cancellationToken);
	}

	public bool TryResolveApproval(string sessionId, string? approvalId, string decision)
	{
		if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(decision))
		{
			return false;
		}

		ManagedSession? session;
		lock (_sync)
		{
			_sessions.TryGetValue(sessionId, out session);
		}
		if (session is null)
		{
			return false;
		}

		var pendingId = string.IsNullOrWhiteSpace(approvalId) ? session.PendingApprovalId : approvalId;
		if (string.IsNullOrWhiteSpace(pendingId))
		{
			return false;
		}

		if (session.PendingApprovals.TryRemove(pendingId, out var tcs))
		{
			tcs.TrySetResult(decision);
			session.ClearPendingApproval(pendingId);
			SessionsChanged?.Invoke();
			Broadcast?.Invoke("approval_resolved", new { sessionId, approvalId = pendingId, decision });
			return true;
		}

		return false;
	}

	public bool TryRemoveSession(string sessionId, out ManagedSession? removed)
	{
		removed = null;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		lock (_sync)
		{
			if (!_sessions.TryGetValue(sessionId, out removed))
			{
				removed = null;
				return false;
			}

			_sessions.Remove(sessionId);
			return true;
		}
	}

	public ManagedSession? TryGetSession(string sessionId)
	{
		lock (_sync)
		{
			return _sessions.TryGetValue(sessionId, out var s) ? s : null;
		}
	}

	public void NotifySessionsChanged()
	{
		SessionsChanged?.Invoke();
	}

	public void QueueTurn(
		string sessionId,
		string normalizedText,
		string? normalizedCwd,
		string? normalizedModel,
		string? normalizedEffort,
		bool hasModelOverride,
		bool hasEffortOverride,
		IReadOnlyList<CodexUserImageInput>? images)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			Broadcast?.Invoke("error", new { message = $"Unknown session: {sessionId}" });
			return;
		}

		if (hasModelOverride)
		{
			session.SetModel(normalizedModel);
		}
		if (hasEffortOverride)
		{
			session.SetReasoningEffort(normalizedEffort);
		}

		_ = Task.Run(async () =>
		{
			var lockTaken = false;
			var completionPublished = false;
			CancellationTokenSource? timeoutCts = null;
			CancellationTokenSource? turnCts = null;

			try
			{
				var lockAcquired = await WaitForTurnSlotWithTimeoutAsync(sessionId, session);
				if (!lockAcquired)
				{
					var waitSeconds = _defaults.TurnSlotWaitTimeoutSeconds;
					session.Log.Write($"[turn_gate] wait timed out after {waitSeconds}s");
					Broadcast?.Invoke(
						"turn_complete",
						new
						{
							sessionId,
							status = "queueTimedOut",
							errorMessage = $"Timed out waiting {waitSeconds}s for previous turn to release."
						});
					Broadcast?.Invoke(
						"status",
						new
						{
							sessionId,
							message = $"Turn did not start because queue wait timed out ({waitSeconds}s)."
						});
					return;
				}

				lockTaken = true;

				timeoutCts = new CancellationTokenSource();
				timeoutCts.CancelAfter(TimeSpan.FromSeconds(_defaults.TurnTimeoutSeconds));
				turnCts = CancellationTokenSource.CreateLinkedTokenSource(session.LifetimeToken, timeoutCts.Token);
				var turnToken = turnCts.Token;
				if (session.TryMarkTurnStarted(turnCts))
				{
					Broadcast?.Invoke("turn_started", new { sessionId });
					SessionsChanged?.Invoke();
				}
				else
				{
					session.Log.Write("[turn_state] suppressed duplicate turn_started emit");
				}

				Broadcast?.Invoke("status", new { sessionId, message = "Turn started." });
				var effectiveModel = session.ResolveTurnModel(_defaults.DefaultModel);
				var effectiveEffort = session.CurrentReasoningEffort;
				var imageCount = images?.Count ?? 0;
				session.Log.Write($"[prompt] {(string.IsNullOrWhiteSpace(normalizedText) ? "(no text)" : normalizedText)} images={imageCount} cwd={normalizedCwd ?? session.Cwd ?? "(default)"} model={effectiveModel ?? "(default)"} effort={effectiveEffort ?? "(default)"}");
				Broadcast?.Invoke("assistant_response_started", new { sessionId });

				var turnOptions = new CodexTurnOptions
				{
					Cwd = normalizedCwd,
					Model = effectiveModel,
					ReasoningEffort = effectiveEffort
				};
				var result = await session.Session.SendMessageAsync(
					normalizedText,
					images: images,
					options: turnOptions,
					progress: null,
					cancellationToken: turnToken);

				Broadcast?.Invoke("assistant_done", new { sessionId, text = result.Text });
				completionPublished = TryPublishTurnComplete(
					sessionId,
					session,
					result.Status,
					result.ErrorMessage);
			}
			catch (OperationCanceledException)
			{
				if (session.LifetimeToken.IsCancellationRequested && !lockTaken)
				{
					return;
				}

				if (timeoutCts?.IsCancellationRequested == true)
				{
					completionPublished = TryPublishTurnComplete(
						sessionId,
						session,
						status: "timedOut",
						errorMessage: "Timed out.");
				}
				else
				{
					completionPublished = TryPublishTurnComplete(
						sessionId,
						session,
						status: "interrupted",
						errorMessage: "Turn canceled.");
				}
			}
			catch (Exception ex)
			{
				Logs.LogError(ex);
				session.Log.Write($"[turn_error] {ex.Message}");
				completionPublished = TryPublishTurnComplete(
					sessionId,
					session,
					status: "failed",
					errorMessage: ex.Message);
			}
			finally
			{
				if (lockTaken)
				{
					if (!completionPublished)
					{
						completionPublished = TryPublishTurnComplete(
							sessionId,
							session,
							status: "unknown",
							errorMessage: "Turn finished without an explicit completion signal.");
					}

					if (!completionPublished)
					{
						session.ReleaseTurnSlot();
					}
				}

				turnCts?.Dispose();
				timeoutCts?.Dispose();
			}
		}, CancellationToken.None);
	}

	public async Task<(bool InterruptSent, bool LocalCanceled, string? Error)> CancelTurnAsync(string sessionId, CancellationToken cancellationToken)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			Broadcast?.Invoke("error", new { message = $"Unknown session: {sessionId}" });
			return (false, false, "Unknown session.");
		}

		if (!session.IsTurnInFlight)
		{
			Broadcast?.Invoke("status", new { sessionId, message = "No running turn to cancel." });
			return (false, false, null);
		}

		var interruptSent = false;
		string? fallbackReason = null;

		try
		{
			interruptSent = await session.Session.InterruptTurnAsync(waitForTurnStart: TimeSpan.FromSeconds(2), cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			fallbackReason = ex.Message;
		}

		var localCanceled = false;
		if (!interruptSent)
		{
			localCanceled = session.CancelActiveTurn();
			if (!localCanceled && string.IsNullOrWhiteSpace(fallbackReason))
			{
				fallbackReason = "No active turn token.";
			}
		}

		if (!interruptSent && !localCanceled)
		{
			Broadcast?.Invoke("status", new { sessionId, message = "No running turn to cancel." });
			return (false, false, fallbackReason);
		}

		if (interruptSent)
		{
			session.Log.Write("[turn_cancel] requested by user; sent turn/interrupt");
		}
		else
		{
			session.Log.Write($"[turn_cancel] requested by user; interrupt unavailable, canceled local wait ({fallbackReason ?? "no details"})");
		}

		Broadcast?.Invoke("turn_cancel_requested", new { sessionId, interruptSent });
		Broadcast?.Invoke(
			"status",
			new { sessionId, message = interruptSent ? "Cancel requested (interrupt sent)." : "Cancel requested (local fallback)." });
		SessionsChanged?.Invoke();

		return (interruptSent, localCanceled, fallbackReason);
	}

	public async Task StopSessionAsync(string sessionId, CancellationToken cancellationToken)
	{
		if (!TryRemoveSession(sessionId, out var session) || session is null)
		{
			return;
		}

		try
		{
			session.CancelLifetime();
			await session.Client.DisposeAsync();
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
		}
		finally
		{
			try { session.Log.Dispose(); } catch { }
		}

		SessionsChanged?.Invoke();
		Broadcast?.Invoke("session_stopped", new { sessionId, message = "Session stopped." });
	}

	private async Task<object?> HandleServerRequestAsync(
		string sessionId,
		LocalLogWriter log,
		ConcurrentDictionary<string, TaskCompletionSource<string>> approvals,
		CodexServerRequest req,
		CancellationToken cancellationToken)
	{
		switch (req.Method)
		{
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval":
			{
				var requestType = req.Method.StartsWith("item/commandExecution", StringComparison.Ordinal)
					? "command"
					: "fileChange";

				var key = Guid.NewGuid().ToString("N");
				var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
				approvals[key] = tcs;

				var cwd = WebCodexUtils.TryGetPathString(req.Params, "cwd");
				var reason = WebCodexUtils.TryGetPathString(req.Params, "reason");
				var actions = WebCodexUtils.GetCommandActionSummaries(req.Params);
				var summary = requestType == "command"
					? "Command execution requested."
					: "File change requested.";

				log.Write($"[approval_request] session={sessionId} approvalId={key} method={req.Method} cwd={cwd ?? "(n/a)"} reason={reason ?? "(n/a)"}");

				var managed = TryGetSession(sessionId);
				managed?.SetPendingApproval(new PendingApprovalSnapshot(
					ApprovalId: key,
					RequestType: requestType,
					Summary: summary,
					Reason: reason,
					Cwd: cwd,
					Actions: actions,
					CreatedAtUtc: DateTimeOffset.UtcNow));
				SessionsChanged?.Invoke();

				Broadcast?.Invoke("approval_request", new
				{
					sessionId,
					approvalId = key,
					requestType,
					summary,
					reason,
					cwd,
					actions,
					options = new[] { "accept", "acceptForSession", "decline", "cancel" }
				});

				try
				{
					var decision = await tcs.Task.WaitAsync(cancellationToken);
					log.Write($"[approval_response] session={sessionId} approvalId={key} decision={decision}");
					return new { decision };
				}
				catch (OperationCanceledException)
				{
					return new { decision = "cancel" };
				}
				finally
				{
					managed?.ClearPendingApproval(key);
					SessionsChanged?.Invoke();
				}
			}
			case "item/tool/requestUserInput":
				return new { answers = new Dictionary<string, object>() };
			case "item/tool/call":
				return new
				{
					success = false,
					contentItems = new object[] { new { type = "inputText", text = "Dynamic tool calls not supported by web wrapper." } }
				};
			default:
				return new { };
		}
	}

	private void HandleCoreEvent(string sessionId, LocalLogWriter sessionLog, CodexCoreEvent ev)
	{
		sessionLog.Write(CodexEventLogging.Format(ev, includeTimestamp: false));

		if (TryParseCoreTurnSignal(ev, out var signal))
		{
			var managed = TryGetSession(sessionId);
			if (managed is not null)
			{
				if (signal.Kind == CoreTurnSignalKind.Started)
				{
					if (managed.TryMarkTurnStartedFromCoreSignal())
					{
						sessionLog.Write($"[turn_recovery] marked started from core signal ({signal.Source})");
						Broadcast?.Invoke("turn_started", new { sessionId });
						SessionsChanged?.Invoke();
					}
				}
				else if (TryPublishTurnComplete(
					sessionId,
					managed,
					signal.Status ?? "completed",
					signal.ErrorMessage))
				{
					sessionLog.Write($"[turn_recovery] marked complete from core signal ({signal.Source})");
				}
			}
		}

		CoreEvent?.Invoke(sessionId, ev);
	}

	private bool TryPublishTurnComplete(
		string sessionId,
		ManagedSession session,
		string? status,
		string? errorMessage)
	{
		if (!session.TryMarkTurnCompletedFromCoreSignal())
		{
			return false;
		}

		var normalizedStatus = string.IsNullOrWhiteSpace(status) ? "unknown" : status!;
		Broadcast?.Invoke("turn_complete", new { sessionId, status = normalizedStatus, errorMessage });
		SessionsChanged?.Invoke();
		return true;
	}

	private static bool TryParseCoreTurnSignal(CodexCoreEvent ev, out CoreTurnSignal signal)
	{
		signal = default;
		if (ev is null || string.IsNullOrWhiteSpace(ev.Type) || !string.Equals(ev.Type, "stdout_jsonl", StringComparison.Ordinal))
		{
			return false;
		}

		var line = ev.Message;
		if (string.IsNullOrWhiteSpace(line))
		{
			return false;
		}

		if (line.IndexOf("turn/started", StringComparison.Ordinal) < 0 &&
			line.IndexOf("task_started", StringComparison.Ordinal) < 0 &&
			line.IndexOf("\"turn_started\"", StringComparison.Ordinal) < 0 &&
			line.IndexOf("turn/completed", StringComparison.Ordinal) < 0 &&
			line.IndexOf("task_complete", StringComparison.Ordinal) < 0 &&
			line.IndexOf("\"turn_complete\"", StringComparison.Ordinal) < 0)
		{
			return false;
		}

		try
		{
			using var doc = JsonDocument.Parse(line);
			var root = doc.RootElement;

			if (root.ValueKind != JsonValueKind.Object)
			{
				return false;
			}

			if (root.TryGetProperty("method", out var methodElement) &&
				methodElement.ValueKind == JsonValueKind.String)
			{
				var method = methodElement.GetString();
				if (string.Equals(method, "turn/started", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/task_started", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/turn_started", StringComparison.Ordinal))
				{
					signal = new CoreTurnSignal(
						Kind: CoreTurnSignalKind.Started,
						Status: null,
						ErrorMessage: null,
						Source: method ?? "unknown_method");
					return true;
				}

				if (string.Equals(method, "turn/completed", StringComparison.Ordinal))
				{
					var status = WebCodexUtils.TryGetPathString(root, "params", "turn", "status")
						?? WebCodexUtils.TryGetPathString(root, "params", "status")
						?? "unknown";
					var errorMessage = WebCodexUtils.TryGetPathString(root, "params", "turn", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "errorMessage");
					signal = new CoreTurnSignal(
						Kind: CoreTurnSignalKind.Completed,
						Status: status,
						ErrorMessage: errorMessage,
						Source: method ?? "unknown_method");
					return true;
				}

				if (string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/turn_complete", StringComparison.Ordinal))
				{
					var status = WebCodexUtils.TryGetPathString(root, "params", "msg", "status")
						?? WebCodexUtils.TryGetPathString(root, "params", "status");
					if (string.IsNullOrWhiteSpace(status))
					{
						status = string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal)
							? "completed"
							: "unknown";
					}

					var errorMessage = WebCodexUtils.TryGetPathString(root, "params", "msg", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "msg", "errorMessage")
						?? WebCodexUtils.TryGetPathString(root, "params", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "errorMessage");
					signal = new CoreTurnSignal(
						Kind: CoreTurnSignalKind.Completed,
						Status: status,
						ErrorMessage: errorMessage,
						Source: method ?? "unknown_method");
					return true;
				}

				return false;
			}

			if (!root.TryGetProperty("type", out var typeElement) ||
				typeElement.ValueKind != JsonValueKind.String ||
				!string.Equals(typeElement.GetString(), "event_msg", StringComparison.Ordinal))
			{
				return false;
			}

			if (!root.TryGetProperty("payload", out var payloadElement) || payloadElement.ValueKind != JsonValueKind.Object)
			{
				return false;
			}

			if (!payloadElement.TryGetProperty("type", out var payloadTypeElement) || payloadTypeElement.ValueKind != JsonValueKind.String)
			{
				return false;
			}

			var payloadType = payloadTypeElement.GetString();
			if (string.Equals(payloadType, "task_started", StringComparison.Ordinal) ||
				string.Equals(payloadType, "turn_started", StringComparison.Ordinal))
			{
				signal = new CoreTurnSignal(
					Kind: CoreTurnSignalKind.Started,
					Status: null,
					ErrorMessage: null,
					Source: $"event_msg:{payloadType}");
				return true;
			}

			if (string.Equals(payloadType, "task_complete", StringComparison.Ordinal) ||
				string.Equals(payloadType, "turn_complete", StringComparison.Ordinal))
			{
				var status = WebCodexUtils.TryGetPathString(payloadElement, "status");
				if (string.IsNullOrWhiteSpace(status))
				{
					status = string.Equals(payloadType, "task_complete", StringComparison.Ordinal)
						? "completed"
						: "unknown";
				}

				var errorMessage = WebCodexUtils.TryGetPathString(payloadElement, "error", "message")
					?? WebCodexUtils.TryGetPathString(payloadElement, "errorMessage");
				signal = new CoreTurnSignal(
					Kind: CoreTurnSignalKind.Completed,
					Status: status,
					ErrorMessage: errorMessage,
					Source: $"event_msg:{payloadType}");
				return true;
			}

			return false;
		}
		catch
		{
			return false;
		}
	}

	private enum CoreTurnSignalKind
	{
		Started,
		Completed
	}

	private readonly record struct CoreTurnSignal(
		CoreTurnSignalKind Kind,
		string? Status,
		string? ErrorMessage,
		string Source);

	public event Action<string, CodexCoreEvent>? CoreEvent;

	private async Task<bool> WaitForTurnSlotWithTimeoutAsync(string sessionId, ManagedSession session)
	{
		if (session.TryRecoverTurnSlotIfIdle())
		{
			session.Log.Write("[turn_gate] recovered stuck idle gate");
			return true;
		}

		if (await session.TryWaitForTurnSlotAsync(timeout: TimeSpan.Zero, cancellationToken: session.LifetimeToken))
		{
			return true;
		}

		Broadcast?.Invoke("status", new { sessionId, message = "Turn queued: waiting for previous turn to finish." });

		var overallTimeout = TimeSpan.FromSeconds(_defaults.TurnSlotWaitTimeoutSeconds);
		var pollInterval = TimeSpan.FromSeconds(Math.Clamp(_defaults.TurnSlotWaitPollSeconds, 1, 30));
		var deadline = DateTimeOffset.UtcNow.Add(overallTimeout);

		while (DateTimeOffset.UtcNow < deadline && !session.LifetimeToken.IsCancellationRequested)
		{
			if (session.TryRecoverTurnSlotIfIdle())
			{
				session.Log.Write("[turn_gate] recovered stuck idle gate");
				return true;
			}

			var remaining = deadline - DateTimeOffset.UtcNow;
			var slice = remaining <= pollInterval ? remaining : pollInterval;
			if (slice <= TimeSpan.Zero)
			{
				break;
			}

			if (await session.TryWaitForTurnSlotAsync(timeout: slice, cancellationToken: session.LifetimeToken))
			{
				return true;
			}
		}

		return false;
	}

	public async ValueTask DisposeAsync()
	{
		ManagedSession[] sessions;
		lock (_sync)
		{
			sessions = _sessions.Values.ToArray();
			_sessions.Clear();
		}

		foreach (var s in sessions)
		{
			try
			{
				s.CancelLifetime();
				await s.Client.DisposeAsync();
			}
			catch
			{
			}
			finally
			{
				try { s.Log.Dispose(); } catch { }
			}
		}
	}

	internal sealed record SessionCreatedPayload(
		string sessionId,
		string threadId,
		string? model,
		string? reasoningEffort,
		string? cwd,
		string logPath,
		bool attached);

	internal sealed record SessionSnapshot(
		string SessionId,
		string ThreadId,
		string? Cwd,
		string? Model,
		string? ReasoningEffort,
		bool IsTurnInFlight,
		PendingApprovalSnapshot? PendingApproval);

	internal sealed record PendingApprovalSnapshot(
		string ApprovalId,
		string RequestType,
		string Summary,
		string? Reason,
		string? Cwd,
		IReadOnlyList<string> Actions,
		DateTimeOffset CreatedAtUtc);

	internal sealed record ManagedSession(
		string SessionId,
		CodexClient Client,
		CodexSession Session,
		string? Cwd,
		string? Model,
		string? ReasoningEffort,
		LocalLogWriter Log,
		ConcurrentDictionary<string, TaskCompletionSource<string>> PendingApprovals)
	{
		private readonly CancellationTokenSource _lifetimeCts = new();
		private readonly SemaphoreSlim _turnGate = new(1, 1);
		private readonly object _approvalSync = new();
		private readonly object _turnSync = new();
		private string? _model = string.IsNullOrWhiteSpace(Model) ? null : Model.Trim();
		private string? _reasoningEffort = WebCodexUtils.NormalizeReasoningEffort(ReasoningEffort);
		private CancellationTokenSource? _activeTurnCts;
		private bool _turnInFlight;
		private bool _turnSlotHeld;
		private PendingApprovalSnapshot? _pendingApproval;

		public string? PendingApprovalId => PendingApprovals.Keys.FirstOrDefault();
		public CancellationToken LifetimeToken => _lifetimeCts.Token;

		public string? CurrentModel
		{
			get
			{
				lock (_turnSync)
				{
					return _model;
				}
			}
		}

		public string? CurrentReasoningEffort
		{
			get
			{
				lock (_turnSync)
				{
					return _reasoningEffort;
				}
			}
		}

		public bool IsTurnInFlight
		{
			get
			{
				lock (_turnSync)
				{
					return _turnInFlight;
				}
			}
		}

		public SessionSnapshot ToSnapshot()
		{
			return new SessionSnapshot(
				SessionId,
				ThreadId: Session.ThreadId,
				Cwd,
				Model: CurrentModel,
				ReasoningEffort: CurrentReasoningEffort,
				IsTurnInFlight: IsTurnInFlight,
				PendingApproval: GetPendingApproval());
		}

		public void SetModel(string? model)
		{
			lock (_turnSync)
			{
				_model = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
			}
		}

		public void SetReasoningEffort(string? effort)
		{
			lock (_turnSync)
			{
				_reasoningEffort = WebCodexUtils.NormalizeReasoningEffort(effort);
			}
		}

		public string? ResolveTurnModel(string? defaultModel)
		{
			var model = CurrentModel;
			return string.IsNullOrWhiteSpace(model) ? defaultModel : model;
		}

		public async Task<bool> TryWaitForTurnSlotAsync(TimeSpan timeout, CancellationToken cancellationToken)
		{
			var waitingOnRecoveredExternalTurn = false;
			lock (_turnSync)
			{
				// External signal recovery can mark a turn as active without owning the semaphore slot.
				// Keep queueing blocked until a matching completion signal clears in-flight state.
				if (_turnInFlight && !_turnSlotHeld)
				{
					waitingOnRecoveredExternalTurn = true;
				}
			}

			if (waitingOnRecoveredExternalTurn)
			{
				if (timeout > TimeSpan.Zero)
				{
					await Task.Delay(timeout, cancellationToken);
				}

				return false;
			}

			if (timeout <= TimeSpan.Zero)
			{
				return await _turnGate.WaitAsync(0, cancellationToken);
			}

			return await _turnGate.WaitAsync(timeout, cancellationToken);
		}

		public void ReleaseTurnSlot()
		{
			var shouldRelease = false;
			lock (_turnSync)
			{
				if (_turnSlotHeld)
				{
					_turnSlotHeld = false;
					shouldRelease = true;
				}
			}

			if (!shouldRelease)
			{
				return;
			}

			try
			{
				_turnGate.Release();
			}
			catch
			{
			}
		}

		public bool TryRecoverTurnSlotIfIdle()
		{
			lock (_turnSync)
			{
				if (_turnInFlight)
				{
					return false;
				}

				if (_turnGate.CurrentCount > 0)
				{
					return false;
				}
			}

			try
			{
				_turnGate.Release();
				return true;
			}
			catch
			{
				return false;
			}
		}

		public bool TryMarkTurnStarted(CancellationTokenSource turnCts)
		{
			lock (_turnSync)
			{
				_activeTurnCts = turnCts;
				_turnSlotHeld = true;
				if (_turnInFlight)
				{
					return false;
				}

				_turnInFlight = true;
				return true;
			}
		}

		public bool TryMarkTurnStartedFromCoreSignal()
		{
			lock (_turnSync)
			{
				if (_turnInFlight)
				{
					return false;
				}

				_turnInFlight = true;
				return true;
			}
		}

		public bool TryMarkTurnCompletedFromCoreSignal()
		{
			var shouldRelease = false;
			lock (_turnSync)
			{
				if (!_turnInFlight)
				{
					return false;
				}

				_activeTurnCts = null;
				_turnInFlight = false;
				if (_turnSlotHeld)
				{
					_turnSlotHeld = false;
					shouldRelease = true;
				}
			}

			if (shouldRelease)
			{
				try
				{
					_turnGate.Release();
				}
				catch
				{
				}
			}

			return true;
		}

		public bool CancelActiveTurn()
		{
			CancellationTokenSource? turnCts;
			lock (_turnSync)
			{
				turnCts = _activeTurnCts;
			}

			if (turnCts is null)
			{
				return false;
			}

			try
			{
				turnCts.Cancel();
				return true;
			}
			catch
			{
				return false;
			}
		}

		public void CancelLifetime()
		{
			try { _lifetimeCts.Cancel(); } catch { }
		}

		public PendingApprovalSnapshot? GetPendingApproval()
		{
			lock (_approvalSync)
			{
				return _pendingApproval;
			}
		}

		public void SetPendingApproval(PendingApprovalSnapshot snapshot)
		{
			lock (_approvalSync)
			{
				_pendingApproval = snapshot;
			}
		}

		public void ClearPendingApproval(string approvalId)
		{
			lock (_approvalSync)
			{
				if (_pendingApproval is null)
				{
					return;
				}

				if (string.Equals(_pendingApproval.ApprovalId, approvalId, StringComparison.Ordinal))
				{
					_pendingApproval = null;
				}
			}
		}
	}
}
