using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

internal sealed class SessionOrchestrator : IAsyncDisposable
{
	private readonly WebRuntimeDefaults _defaults;
	private readonly object _sync = new();
	private readonly object _coreSignalSync = new();
	private readonly Dictionary<string, ManagedSession> _sessions = new(StringComparer.Ordinal);
	private readonly Dictionary<string, string> _lastSessionConfiguredFingerprintBySession = new(StringComparer.Ordinal);
	private readonly Dictionary<string, string> _lastThreadCompactedFingerprintByThread = new(StringComparer.Ordinal);
	private readonly Dictionary<string, string> _lastThreadNameByThread = new(StringComparer.Ordinal);
	private readonly Dictionary<string, RateLimitDispatchState> _rateLimitDispatchBySession = new(StringComparer.Ordinal);
	private static readonly TimeSpan RateLimitCoalesceDelay = TimeSpan.FromMilliseconds(350);

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
		}

		CleanupCoreSignalState(sessionId, removed?.Session.ThreadId);
		return true;
	}

	private void CleanupCoreSignalState(string sessionId, string? threadId)
	{
		lock (_coreSignalSync)
		{
			_lastSessionConfiguredFingerprintBySession.Remove(sessionId);
			_rateLimitDispatchBySession.Remove(sessionId);

			if (string.IsNullOrWhiteSpace(threadId))
			{
				return;
			}

			_lastThreadCompactedFingerprintByThread.Remove(threadId);
			_lastThreadNameByThread.Remove(threadId);
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

		if (TryParseCoreAuxSignals(ev, out var auxSignals))
		{
			var managed = TryGetSession(sessionId);
			if (managed is not null)
			{
				if (auxSignals.SessionConfiguredSignal is { } sessionConfiguredSignal)
				{
					HandleSessionConfiguredSignal(sessionId, managed, sessionConfiguredSignal);
				}

				if (auxSignals.ThreadCompactedSignal is { } threadCompactedSignal)
				{
					HandleThreadCompactedSignal(sessionId, managed, threadCompactedSignal);
				}

				if (auxSignals.ThreadNameUpdatedSignal is { } threadNameUpdatedSignal)
				{
					HandleThreadNameUpdatedSignal(sessionId, managed, threadNameUpdatedSignal);
				}

				if (auxSignals.RateLimitsSignal is { } rateLimitsSignal)
				{
					QueueRateLimitsSignal(sessionId, rateLimitsSignal);
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

	private void HandleSessionConfiguredSignal(string sessionId, ManagedSession managed, CoreSessionConfiguredSignal signal)
	{
		var changed = managed.TryApplySessionConfigured(
			model: signal.Model,
			reasoningEffort: signal.ReasoningEffort,
			approvalPolicy: signal.ApprovalPolicy,
			sandboxPolicy: signal.SandboxPolicy);

		var shouldEmit = false;
		lock (_coreSignalSync)
		{
			if (!_lastSessionConfiguredFingerprintBySession.TryGetValue(sessionId, out var prior) ||
				!string.Equals(prior, signal.Fingerprint, StringComparison.Ordinal))
			{
				_lastSessionConfiguredFingerprintBySession[sessionId] = signal.Fingerprint;
				shouldEmit = true;
			}
		}

		if (changed)
		{
			SessionsChanged?.Invoke();
		}

		if (!shouldEmit)
		{
			return;
		}

		var threadId = string.IsNullOrWhiteSpace(signal.ThreadId) ? managed.Session.ThreadId : signal.ThreadId;
		Broadcast?.Invoke(
			"session_configured",
			new
			{
				sessionId,
				threadId,
				model = signal.Model,
				reasoningEffort = signal.ReasoningEffort,
				cwd = signal.Cwd,
				approvalPolicy = signal.ApprovalPolicy,
				sandboxPolicy = signal.SandboxPolicy,
				source = signal.Source
			});
	}

	private void HandleThreadCompactedSignal(string sessionId, ManagedSession managed, CoreThreadCompactedSignal signal)
	{
		var threadId = string.IsNullOrWhiteSpace(signal.ThreadId) ? managed.Session.ThreadId : signal.ThreadId;
		var dedupeKey = string.IsNullOrWhiteSpace(threadId) ? sessionId : threadId;
		var shouldEmit = false;
		lock (_coreSignalSync)
		{
			if (!_lastThreadCompactedFingerprintByThread.TryGetValue(dedupeKey, out var prior) ||
				!string.Equals(prior, signal.Fingerprint, StringComparison.Ordinal))
			{
				_lastThreadCompactedFingerprintByThread[dedupeKey] = signal.Fingerprint;
				shouldEmit = true;
			}
		}

		if (!shouldEmit)
		{
			return;
		}

		Broadcast?.Invoke(
			"thread_compacted",
			new
			{
				sessionId,
				threadId,
				reclaimedTokens = signal.ReclaimedTokens,
				usedTokensBefore = signal.UsedTokensBefore,
				usedTokensAfter = signal.UsedTokensAfter,
				contextWindow = signal.ContextWindow,
				percentLeft = signal.PercentLeft,
				summary = signal.Summary,
				source = signal.Source
			});
	}

	private void HandleThreadNameUpdatedSignal(string sessionId, ManagedSession managed, CoreThreadNameUpdatedSignal signal)
	{
		var threadId = string.IsNullOrWhiteSpace(signal.ThreadId) ? managed.Session.ThreadId : signal.ThreadId;
		if (string.IsNullOrWhiteSpace(threadId) || string.IsNullOrWhiteSpace(signal.ThreadName))
		{
			return;
		}

		var shouldEmit = false;
		lock (_coreSignalSync)
		{
			if (!_lastThreadNameByThread.TryGetValue(threadId, out var priorName) ||
				!string.Equals(priorName, signal.ThreadName, StringComparison.Ordinal))
			{
				_lastThreadNameByThread[threadId] = signal.ThreadName;
				shouldEmit = true;
			}
		}

		if (!shouldEmit)
		{
			return;
		}

		Broadcast?.Invoke(
			"thread_name_updated",
			new
			{
				sessionId,
				threadId,
				threadName = signal.ThreadName,
				source = signal.Source
			});
	}

	private void QueueRateLimitsSignal(string sessionId, CoreRateLimitsSignal signal)
	{
		var scheduleFlush = false;
		lock (_coreSignalSync)
		{
			if (!_rateLimitDispatchBySession.TryGetValue(sessionId, out var state))
			{
				state = new RateLimitDispatchState();
				_rateLimitDispatchBySession[sessionId] = state;
			}

			state.Pending = signal;
			if (!state.FlushScheduled)
			{
				state.FlushScheduled = true;
				scheduleFlush = true;
			}
		}

		if (!scheduleFlush)
		{
			return;
		}

		_ = Task.Run(async () =>
		{
			try
			{
				await Task.Delay(RateLimitCoalesceDelay);
				FlushRateLimitsSignal(sessionId);
			}
			catch
			{
			}
		});
	}

	private void FlushRateLimitsSignal(string sessionId)
	{
		CoreRateLimitsSignal? signal = null;
		lock (_coreSignalSync)
		{
			if (!_rateLimitDispatchBySession.TryGetValue(sessionId, out var state))
			{
				return;
			}

			signal = state.Pending;
			state.Pending = null;
			state.FlushScheduled = false;

			if (signal is null || string.Equals(state.LastFingerprint, signal.Fingerprint, StringComparison.Ordinal))
			{
				return;
			}

			state.LastFingerprint = signal.Fingerprint;
		}

		if (signal is null || TryGetSession(sessionId) is null)
		{
			return;
		}

		Broadcast?.Invoke(
			"rate_limits_updated",
			new
			{
				sessionId,
				scope = signal.Scope,
				remaining = signal.Remaining,
				limit = signal.Limit,
				used = signal.Used,
				retryAfterSeconds = signal.RetryAfterSeconds,
				resetAtUtc = signal.ResetAtUtc?.ToString("O"),
				summary = signal.Summary,
				source = signal.Source
			});
	}

	private static bool TryParseCoreAuxSignals(CodexCoreEvent ev, out CoreAuxSignals signals)
	{
		signals = default;
		if (ev is null || !string.Equals(ev.Type, "stdout_jsonl", StringComparison.Ordinal))
		{
			return false;
		}

		var line = ev.Message;
		if (string.IsNullOrWhiteSpace(line))
		{
			return false;
		}

		if (line.IndexOf("rateLimits", StringComparison.Ordinal) < 0 &&
			line.IndexOf("rate_limits", StringComparison.Ordinal) < 0 &&
			line.IndexOf("sessionConfigured", StringComparison.Ordinal) < 0 &&
			line.IndexOf("session_configured", StringComparison.Ordinal) < 0 &&
			line.IndexOf("thread/compacted", StringComparison.Ordinal) < 0 &&
			line.IndexOf("thread_compacted", StringComparison.Ordinal) < 0 &&
			line.IndexOf("thread/name/updated", StringComparison.Ordinal) < 0 &&
			line.IndexOf("thread_name_updated", StringComparison.Ordinal) < 0)
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

			CoreRateLimitsSignal? rateLimitsSignal = null;
			CoreSessionConfiguredSignal? sessionConfiguredSignal = null;
			CoreThreadCompactedSignal? threadCompactedSignal = null;
			CoreThreadNameUpdatedSignal? threadNameUpdatedSignal = null;

			if (root.TryGetProperty("method", out var methodElement) && methodElement.ValueKind == JsonValueKind.String)
			{
				var method = methodElement.GetString() ?? string.Empty;
				var paramsElement = root.TryGetProperty("params", out var p) ? p : default;

				rateLimitsSignal = TryParseCoreRateLimitsSignalFromMethod(method, paramsElement);
				sessionConfiguredSignal = TryParseCoreSessionConfiguredSignalFromMethod(method, paramsElement);
				threadCompactedSignal = TryParseCoreThreadCompactedSignalFromMethod(method, paramsElement);
				threadNameUpdatedSignal = TryParseCoreThreadNameUpdatedSignalFromMethod(method, paramsElement);
			}

			if (root.TryGetProperty("type", out var typeElement) &&
				typeElement.ValueKind == JsonValueKind.String &&
				string.Equals(typeElement.GetString(), "event_msg", StringComparison.Ordinal) &&
				root.TryGetProperty("payload", out var payloadElement) &&
				payloadElement.ValueKind == JsonValueKind.Object &&
				payloadElement.TryGetProperty("type", out var payloadTypeElement) &&
				payloadTypeElement.ValueKind == JsonValueKind.String)
			{
				var payloadType = payloadTypeElement.GetString() ?? string.Empty;
				rateLimitsSignal ??= TryParseCoreRateLimitsSignalFromEventPayload(payloadType, payloadElement);
				sessionConfiguredSignal ??= TryParseCoreSessionConfiguredSignalFromEventPayload(payloadType, payloadElement);
				threadCompactedSignal ??= TryParseCoreThreadCompactedSignalFromEventPayload(payloadType, payloadElement);
				threadNameUpdatedSignal ??= TryParseCoreThreadNameUpdatedSignalFromEventPayload(payloadType, payloadElement);
			}

			signals = new CoreAuxSignals(rateLimitsSignal, sessionConfiguredSignal, threadCompactedSignal, threadNameUpdatedSignal);
			return signals.HasAnySignal;
		}
		catch
		{
			return false;
		}
	}

	private static CoreRateLimitsSignal? TryParseCoreRateLimitsSignalFromMethod(string method, JsonElement paramsElement)
	{
		if (!string.Equals(method, "account/rateLimits/updated", StringComparison.Ordinal) &&
			!string.Equals(method, "account/rate_limits/updated", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/account_rate_limits_updated", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildRateLimitsSignal(paramsElement, method);
	}

	private static CoreRateLimitsSignal? TryParseCoreRateLimitsSignalFromEventPayload(string payloadType, JsonElement payloadElement)
	{
		if (!string.Equals(payloadType, "rate_limits_updated", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "rateLimitsUpdated", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "account_rate_limits_updated", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildRateLimitsSignal(payloadElement, $"event_msg:{payloadType}");
	}

	private static CoreSessionConfiguredSignal? TryParseCoreSessionConfiguredSignalFromMethod(string method, JsonElement paramsElement)
	{
		if (!string.Equals(method, "sessionConfigured", StringComparison.Ordinal) &&
			!string.Equals(method, "session/configured", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/session_configured", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildSessionConfiguredSignal(paramsElement, method);
	}

	private static CoreSessionConfiguredSignal? TryParseCoreSessionConfiguredSignalFromEventPayload(string payloadType, JsonElement payloadElement)
	{
		if (!string.Equals(payloadType, "session_configured", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "sessionConfigured", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildSessionConfiguredSignal(payloadElement, $"event_msg:{payloadType}");
	}

	private static CoreThreadCompactedSignal? TryParseCoreThreadCompactedSignalFromMethod(string method, JsonElement paramsElement)
	{
		if (!string.Equals(method, "thread/compacted", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/thread_compacted", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildThreadCompactedSignal(paramsElement, method);
	}

	private static CoreThreadCompactedSignal? TryParseCoreThreadCompactedSignalFromEventPayload(string payloadType, JsonElement payloadElement)
	{
		if (!string.Equals(payloadType, "thread_compacted", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "thread/compacted", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildThreadCompactedSignal(payloadElement, $"event_msg:{payloadType}");
	}

	private static CoreThreadNameUpdatedSignal? TryParseCoreThreadNameUpdatedSignalFromMethod(string method, JsonElement paramsElement)
	{
		if (!string.Equals(method, "thread/name/updated", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/thread_name_updated", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildThreadNameUpdatedSignal(paramsElement, method);
	}

	private static CoreThreadNameUpdatedSignal? TryParseCoreThreadNameUpdatedSignalFromEventPayload(string payloadType, JsonElement payloadElement)
	{
		if (!string.Equals(payloadType, "thread_name_updated", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "thread/name/updated", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildThreadNameUpdatedSignal(payloadElement, $"event_msg:{payloadType}");
	}

	private static CoreRateLimitsSignal BuildRateLimitsSignal(JsonElement root, string source)
	{
		var scope = TryGetAnyPathString(root,
			new[] { "scope" },
			new[] { "name" },
			new[] { "msg", "scope" },
			new[] { "rateLimit", "scope" },
			new[] { "rate_limit", "scope" });
		var remaining = TryGetAnyPathDouble(root,
			new[] { "remaining" },
			new[] { "msg", "remaining" },
			new[] { "limits", "remaining" },
			new[] { "rateLimit", "remaining" },
			new[] { "rate_limit", "remaining" });
		var limit = TryGetAnyPathDouble(root,
			new[] { "limit" },
			new[] { "max" },
			new[] { "msg", "limit" },
			new[] { "limits", "limit" },
			new[] { "rateLimit", "limit" },
			new[] { "rate_limit", "limit" });
		var used = TryGetAnyPathDouble(root,
			new[] { "used" },
			new[] { "msg", "used" },
			new[] { "limits", "used" },
			new[] { "rateLimit", "used" },
			new[] { "rate_limit", "used" });
		var retryAfterSeconds = TryGetAnyPathDouble(root,
			new[] { "retryAfterSeconds" },
			new[] { "retry_after_seconds" },
			new[] { "retry_after" },
			new[] { "msg", "retryAfterSeconds" },
			new[] { "msg", "retry_after_seconds" });
		var resetAtUtc = TryGetAnyPathDate(root,
			new[] { "resetAtUtc" },
			new[] { "resetAt" },
			new[] { "reset_at" },
			new[] { "msg", "resetAtUtc" },
			new[] { "msg", "resetAt" },
			new[] { "msg", "reset_at" });
		var summary = TryGetAnyPathString(root,
			new[] { "summary" },
			new[] { "message" },
			new[] { "msg", "summary" },
			new[] { "msg", "message" });
		if (string.IsNullOrWhiteSpace(summary))
		{
			var parts = new List<string>();
			if (!string.IsNullOrWhiteSpace(scope))
			{
				parts.Add(scope!);
			}
			if (remaining.HasValue && limit.HasValue && limit.Value > 0)
			{
				parts.Add($"{remaining.Value:0.###}/{limit.Value:0.###} remaining");
			}
			else if (remaining.HasValue)
			{
				parts.Add($"{remaining.Value:0.###} remaining");
			}
			if (retryAfterSeconds.HasValue && retryAfterSeconds.Value > 0)
			{
				parts.Add($"retry after {Math.Round(retryAfterSeconds.Value):0}s");
			}
			else if (resetAtUtc.HasValue)
			{
				parts.Add($"resets {resetAtUtc.Value:O}");
			}

			summary = parts.Count > 0 ? string.Join(" | ", parts) : "Rate limits updated";
		}

		var fingerprint = string.Join("|",
			NormalizeForFingerprint(scope),
			NormalizeForFingerprint(remaining),
			NormalizeForFingerprint(limit),
			NormalizeForFingerprint(used),
			NormalizeForFingerprint(retryAfterSeconds),
			NormalizeForFingerprint(resetAtUtc?.ToString("O")),
			NormalizeForFingerprint(summary));
		return new CoreRateLimitsSignal(
			scope,
			remaining,
			limit,
			used,
			retryAfterSeconds,
			resetAtUtc,
			summary!,
			source,
			fingerprint);
	}

	private static CoreSessionConfiguredSignal? BuildSessionConfiguredSignal(JsonElement root, string source)
	{
		var model = TryGetAnyPathString(root,
			new[] { "model" },
			new[] { "selectedModel" },
			new[] { "selected_model" },
			new[] { "session", "model" });
		var effortRaw = TryGetAnyPathString(root,
			new[] { "reasoningEffort" },
			new[] { "reasoning_effort" },
			new[] { "effort" },
			new[] { "session", "reasoningEffort" },
			new[] { "session", "effort" });
		var effortNormalized = WebCodexUtils.NormalizeReasoningEffort(effortRaw);
		var cwd = TryGetAnyPathString(root,
			new[] { "cwd" },
			new[] { "session", "cwd" });
		var approvalPolicy = TryGetAnyPathString(root,
			new[] { "approvalPolicy" },
			new[] { "approval_policy" },
			new[] { "approvalMode" },
			new[] { "approval_mode" },
			new[] { "session", "approvalPolicy" },
			new[] { "session", "approval_policy" });
		var sandboxPolicy = TryGetAnyPathString(root,
			new[] { "sandboxPolicy" },
			new[] { "sandbox_policy" },
			new[] { "sandboxMode" },
			new[] { "sandbox_mode" },
			new[] { "sandbox" },
			new[] { "session", "sandboxPolicy" },
			new[] { "session", "sandbox_policy" });
		var threadId = TryGetAnyPathString(root,
			new[] { "threadId" },
			new[] { "thread_id" },
			new[] { "thread", "id" },
			new[] { "session", "threadId" },
			new[] { "session", "thread_id" });

		if (string.IsNullOrWhiteSpace(model) &&
			string.IsNullOrWhiteSpace(effortNormalized) &&
			string.IsNullOrWhiteSpace(cwd) &&
			string.IsNullOrWhiteSpace(approvalPolicy) &&
			string.IsNullOrWhiteSpace(sandboxPolicy))
		{
			return null;
		}

		var fingerprint = string.Join("|",
			NormalizeForFingerprint(model),
			NormalizeForFingerprint(effortNormalized),
			NormalizeForFingerprint(cwd),
			NormalizeForFingerprint(approvalPolicy),
			NormalizeForFingerprint(sandboxPolicy),
			NormalizeForFingerprint(threadId));

		return new CoreSessionConfiguredSignal(
			model,
			effortNormalized,
			cwd,
			approvalPolicy,
			sandboxPolicy,
			threadId,
			source,
			fingerprint);
	}

	private static CoreThreadCompactedSignal? BuildThreadCompactedSignal(JsonElement root, string source)
	{
		var threadId = TryGetAnyPathString(root,
			new[] { "threadId" },
			new[] { "thread_id" },
			new[] { "thread", "id" },
			new[] { "msg", "thread_id" },
			new[] { "msg", "threadId" });
		var contextWindow = TryGetAnyPathDouble(root,
			new[] { "model_context_window" },
			new[] { "modelContextWindow" },
			new[] { "context_window" },
			new[] { "contextWindow" });
		var usedTokensBefore = TryGetAnyPathDouble(root,
			new[] { "used_tokens_before" },
			new[] { "usedTokensBefore" },
			new[] { "tokens_before" },
			new[] { "tokensBefore" });
		var usedTokensAfter = TryGetAnyPathDouble(root,
			new[] { "used_tokens_after" },
			new[] { "usedTokensAfter" },
			new[] { "tokens_after" },
			new[] { "tokensAfter" },
			new[] { "used_tokens" },
			new[] { "usedTokens" });
		var reclaimedTokens = TryGetAnyPathDouble(root,
			new[] { "reclaimed_tokens" },
			new[] { "reclaimedTokens" },
			new[] { "tokens_reclaimed" },
			new[] { "tokensReclaimed" });

		if (!reclaimedTokens.HasValue && usedTokensBefore.HasValue && usedTokensAfter.HasValue)
		{
			reclaimedTokens = Math.Max(0, usedTokensBefore.Value - usedTokensAfter.Value);
		}

		var percentLeft = TryGetAnyPathDouble(root,
			new[] { "percent_left" },
			new[] { "percentLeft" },
			new[] { "context_percent_left" },
			new[] { "contextPercentLeft" });
		if (!percentLeft.HasValue && contextWindow.HasValue && contextWindow.Value > 0 && usedTokensAfter.HasValue)
		{
			var ratio = Math.Min(1, Math.Max(0, usedTokensAfter.Value / contextWindow.Value));
			percentLeft = Math.Round((1 - ratio) * 100, MidpointRounding.AwayFromZero);
		}

		var summary = TryGetAnyPathString(root,
			new[] { "summary" },
			new[] { "message" });
		if (string.IsNullOrWhiteSpace(summary))
		{
			var parts = new List<string> { "Context compressed" };
			if (reclaimedTokens.HasValue && reclaimedTokens.Value > 0)
			{
				parts.Add($"{Math.Round(reclaimedTokens.Value):0} tokens reclaimed");
			}
			if (percentLeft.HasValue)
			{
				parts.Add($"{Math.Round(percentLeft.Value):0}% context left");
			}
			summary = string.Join(" | ", parts);
		}

		if (!reclaimedTokens.HasValue && !usedTokensAfter.HasValue && !percentLeft.HasValue)
		{
			return null;
		}

		var fingerprint = string.Join("|",
			NormalizeForFingerprint(threadId),
			NormalizeForFingerprint(usedTokensBefore),
			NormalizeForFingerprint(usedTokensAfter),
			NormalizeForFingerprint(reclaimedTokens),
			NormalizeForFingerprint(contextWindow),
			NormalizeForFingerprint(percentLeft),
			NormalizeForFingerprint(summary));
		return new CoreThreadCompactedSignal(
			threadId,
			reclaimedTokens,
			usedTokensBefore,
			usedTokensAfter,
			contextWindow,
			percentLeft,
			summary!,
			source,
			fingerprint);
	}

	private static CoreThreadNameUpdatedSignal? BuildThreadNameUpdatedSignal(JsonElement root, string source)
	{
		var threadId = TryGetAnyPathString(root,
			new[] { "threadId" },
			new[] { "thread_id" },
			new[] { "thread", "id" },
			new[] { "msg", "thread_id" },
			new[] { "msg", "threadId" });
		var threadName = TryGetAnyPathString(root,
			new[] { "threadName" },
			new[] { "thread_name" },
			new[] { "name" },
			new[] { "msg", "threadName" },
			new[] { "msg", "thread_name" },
			new[] { "msg", "name" });

		if (string.IsNullOrWhiteSpace(threadName))
		{
			return null;
		}

		return new CoreThreadNameUpdatedSignal(threadId, threadName, source);
	}

	private static string? TryGetAnyPathString(JsonElement root, params string[][] paths)
	{
		foreach (var path in paths)
		{
			var value = WebCodexUtils.TryGetPathString(root, path);
			if (!string.IsNullOrWhiteSpace(value))
			{
				return value.Trim();
			}
		}

		return null;
	}

	private static double? TryGetAnyPathDouble(JsonElement root, params string[][] paths)
	{
		foreach (var path in paths)
		{
			var raw = WebCodexUtils.TryGetPathString(root, path);
			if (string.IsNullOrWhiteSpace(raw))
			{
				continue;
			}

			if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
			{
				return parsed;
			}
		}

		return null;
	}

	private static DateTimeOffset? TryGetAnyPathDate(JsonElement root, params string[][] paths)
	{
		foreach (var path in paths)
		{
			var raw = WebCodexUtils.TryGetPathString(root, path);
			if (string.IsNullOrWhiteSpace(raw))
			{
				continue;
			}

			if (DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
			{
				return parsed.ToUniversalTime();
			}
		}

		return null;
	}

	private static string NormalizeForFingerprint(object? value)
	{
		if (value is null)
		{
			return string.Empty;
		}

		return value switch
		{
			double d => d.ToString("0.###", CultureInfo.InvariantCulture),
			float f => f.ToString("0.###", CultureInfo.InvariantCulture),
			decimal m => m.ToString("0.###", CultureInfo.InvariantCulture),
			_ => value.ToString()?.Trim() ?? string.Empty
		};
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

	private readonly record struct CoreAuxSignals(
		CoreRateLimitsSignal? RateLimitsSignal,
		CoreSessionConfiguredSignal? SessionConfiguredSignal,
		CoreThreadCompactedSignal? ThreadCompactedSignal,
		CoreThreadNameUpdatedSignal? ThreadNameUpdatedSignal)
	{
		public bool HasAnySignal =>
			RateLimitsSignal is not null ||
			SessionConfiguredSignal is not null ||
			ThreadCompactedSignal is not null ||
			ThreadNameUpdatedSignal is not null;
	}

	private sealed record CoreRateLimitsSignal(
		string? Scope,
		double? Remaining,
		double? Limit,
		double? Used,
		double? RetryAfterSeconds,
		DateTimeOffset? ResetAtUtc,
		string Summary,
		string Source,
		string Fingerprint);

	private sealed record CoreSessionConfiguredSignal(
		string? Model,
		string? ReasoningEffort,
		string? Cwd,
		string? ApprovalPolicy,
		string? SandboxPolicy,
		string? ThreadId,
		string Source,
		string Fingerprint);

	private sealed record CoreThreadCompactedSignal(
		string? ThreadId,
		double? ReclaimedTokens,
		double? UsedTokensBefore,
		double? UsedTokensAfter,
		double? ContextWindow,
		double? PercentLeft,
		string Summary,
		string Source,
		string Fingerprint);

	private sealed record CoreThreadNameUpdatedSignal(
		string? ThreadId,
		string ThreadName,
		string Source);

	private sealed class RateLimitDispatchState
	{
		public string LastFingerprint { get; set; } = string.Empty;
		public bool FlushScheduled { get; set; }
		public CoreRateLimitsSignal? Pending { get; set; }
	}

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
		string? ApprovalPolicy,
		string? SandboxPolicy,
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
		ConcurrentDictionary<string, TaskCompletionSource<string>> PendingApprovals,
		string? ApprovalPolicy = null,
		string? SandboxPolicy = null)
	{
		private readonly CancellationTokenSource _lifetimeCts = new();
		private readonly SemaphoreSlim _turnGate = new(1, 1);
		private readonly object _approvalSync = new();
		private readonly object _turnSync = new();
		private string? _model = string.IsNullOrWhiteSpace(Model) ? null : Model.Trim();
		private string? _reasoningEffort = WebCodexUtils.NormalizeReasoningEffort(ReasoningEffort);
		private string? _approvalPolicy = string.IsNullOrWhiteSpace(ApprovalPolicy) ? null : ApprovalPolicy.Trim();
		private string? _sandboxPolicy = string.IsNullOrWhiteSpace(SandboxPolicy) ? null : SandboxPolicy.Trim();
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

		public string? CurrentApprovalPolicy
		{
			get
			{
				lock (_turnSync)
				{
					return _approvalPolicy;
				}
			}
		}

		public string? CurrentSandboxPolicy
		{
			get
			{
				lock (_turnSync)
				{
					return _sandboxPolicy;
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
				ApprovalPolicy: CurrentApprovalPolicy,
				SandboxPolicy: CurrentSandboxPolicy,
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

		public bool TryApplySessionConfigured(
			string? model,
			string? reasoningEffort,
			string? approvalPolicy,
			string? sandboxPolicy)
		{
			var changed = false;
			lock (_turnSync)
			{
				if (!string.IsNullOrWhiteSpace(model))
				{
					var normalizedModel = model.Trim();
					if (!string.Equals(_model, normalizedModel, StringComparison.Ordinal))
					{
						_model = normalizedModel;
						changed = true;
					}
				}

				if (!string.IsNullOrWhiteSpace(reasoningEffort))
				{
					var normalizedEffort = WebCodexUtils.NormalizeReasoningEffort(reasoningEffort);
					if (!string.IsNullOrWhiteSpace(normalizedEffort) &&
						!string.Equals(_reasoningEffort, normalizedEffort, StringComparison.Ordinal))
					{
						_reasoningEffort = normalizedEffort;
						changed = true;
					}
				}

				if (approvalPolicy is not null)
				{
					var normalizedApproval = string.IsNullOrWhiteSpace(approvalPolicy) ? null : approvalPolicy.Trim();
					if (!string.Equals(_approvalPolicy, normalizedApproval, StringComparison.Ordinal))
					{
						_approvalPolicy = normalizedApproval;
						changed = true;
					}
				}

				if (sandboxPolicy is not null)
				{
					var normalizedSandbox = string.IsNullOrWhiteSpace(sandboxPolicy) ? null : sandboxPolicy.Trim();
					if (!string.Equals(_sandboxPolicy, normalizedSandbox, StringComparison.Ordinal))
					{
						_sandboxPolicy = normalizedSandbox;
						changed = true;
					}
				}
			}

			return changed;
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
