using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

internal sealed class SessionOrchestrator : IAsyncDisposable
{
	private const int WatchToolOutputTextMaxChars = 6000;
	private const int WatchToolCallTextMaxChars = 3000;
	private const int WatchGeneralTextSafetyMaxChars = 200000;
	private const int WatchActiveDetailMaxIntermediateEntries = 24;
	private readonly WebRuntimeDefaults _defaults;
	private readonly TimelineProjectionService _timelineProjection;
	private readonly ReviewStore _reviewStore;
	private readonly object _sync = new();
	private readonly object _coreSignalSync = new();
	private readonly object _turnCacheSync = new();
	private readonly Dictionary<string, ManagedSession> _sessions = new(StringComparer.Ordinal);
	private readonly Dictionary<string, ThreadTurnCacheState> _turnCacheByThread = new(StringComparer.Ordinal);
	private readonly Dictionary<string, string> _lastSessionConfiguredFingerprintBySession = new(StringComparer.Ordinal);
	private readonly Dictionary<string, string> _lastThreadCompactedFingerprintByThread = new(StringComparer.Ordinal);
	private readonly Dictionary<string, string> _lastThreadNameByThread = new(StringComparer.Ordinal);
	private readonly Dictionary<string, RateLimitDispatchState> _rateLimitDispatchBySession = new(StringComparer.Ordinal);
	private static readonly TimeSpan RateLimitCoalesceDelay = TimeSpan.FromMilliseconds(350);
	private static readonly TimeSpan ModelsListCacheTtl = TimeSpan.FromMinutes(10);
	private const int MaxCoreStdoutJsonlParseChars = 250_000;

	public event Action? SessionsChanged;
	public event Action<string, object>? Broadcast;

	public SessionOrchestrator(WebRuntimeDefaults defaults, TimelineProjectionService timelineProjection, ReviewStore reviewStore)
	{
		_defaults = defaults;
		_timelineProjection = timelineProjection;
		_reviewStore = reviewStore;
	}

	private static void WriteOrchestratorAudit(string message)
	{
		Logs.DebugLog.WriteEvent("Audit.Orchestrator", message);
	}

	private static string SummarizeTextForAudit(string? text, int imageCount)
	{
		var count = string.IsNullOrWhiteSpace(text) ? 0 : text.Trim().Length;
		return $"chars={count} images={imageCount}";
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

	public IReadOnlyList<SessionSnapshot> GetSessionSnapshots(bool includeTurnCacheStats = true)
	{
		List<ManagedSession> loadedSessions;
		lock (_sync)
		{
			loadedSessions = _sessions.Values.ToList();
		}

		var stalePendingStartAfter = GetPendingTurnStartStaleAfter();
		var staleStartedLocalAfter = GetStartedLocalTurnStaleAfter();
		foreach (var session in loadedSessions)
		{
			TryExpireStalePendingTurnStart(session.SessionId, session, stalePendingStartAfter);
			TryExpireStaleStartedLocalTurn(session.SessionId, session, staleStartedLocalAfter);
		}

		var turnStatsByThread = new Dictionary<string, (int TurnCountInMemory, bool IsTurnInFlightInferredFromLogs)>(StringComparer.Ordinal);
		if (includeTurnCacheStats)
		{
			EnsureTurnCacheForSessions(loadedSessions, maxEntries: 6000);

			lock (_turnCacheSync)
			{
				turnStatsByThread = _turnCacheByThread.ToDictionary(
					x => x.Key,
					x => (
						TurnCountInMemory: x.Value.Turns.Count,
						IsTurnInFlightInferredFromLogs: x.Value.LastInferredTurnInFlightFromLogs),
					StringComparer.Ordinal);
			}
		}

		return loadedSessions
			.Select(s =>
			{
				var turnCountInMemory = 0;
				var inferredFromLogs = false;
				if (includeTurnCacheStats && turnStatsByThread.TryGetValue(s.Session.ThreadId, out var stats))
				{
					turnCountInMemory = stats.TurnCountInMemory;
					inferredFromLogs = stats.IsTurnInFlightInferredFromLogs;
				}

				return s.ToSnapshot(
					turnCountInMemory: turnCountInMemory,
					isTurnInFlightInferredFromLogs: inferredFromLogs,
					isTurnInFlightLogOnly: s.IsTurnInFlightRecoveredFromLogs);
			})
			.ToList();
	}

	public IReadOnlyList<SessionRateLimitSnapshot> GetLatestRateLimitSnapshots()
	{
		List<ManagedSession> loadedSessions;
		lock (_sync)
		{
			loadedSessions = _sessions.Values.ToList();
		}

		return loadedSessions
			.Select(s => s.GetLatestRateLimitSnapshot())
			.Where(x => x is not null)
			.Select(x => x!)
			.OrderByDescending(x => x.UpdatedAtUtc)
			.ThenBy(x => x.SessionId, StringComparer.Ordinal)
			.ToList();
	}

	public TurnWatchSnapshot WatchTurns(
		string threadId,
		int maxEntries,
		bool initial,
		long? cursor,
		bool includeActiveTurnDetail = true)
	{
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			throw new InvalidOperationException("threadId is required.");
		}

		var sessionCatalogEntry = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: 0)
			.FirstOrDefault(x => string.Equals(x.ThreadId, normalizedThreadId, StringComparison.Ordinal));
		if (sessionCatalogEntry is null || string.IsNullOrWhiteSpace(sessionCatalogEntry.SessionFilePath))
		{
			throw new FileNotFoundException($"No session file found for threadId '{normalizedThreadId}'.");
		}

		var sessionFilePath = Path.GetFullPath(sessionCatalogEntry.SessionFilePath);
		if (!File.Exists(sessionFilePath))
		{
			throw new FileNotFoundException($"Session file does not exist: '{sessionFilePath}'.");
		}

		var fileInfo = new FileInfo(sessionFilePath);
		var fileLength = fileInfo.Length;
		var lastWriteUtc = fileInfo.LastWriteTimeUtc;

		var rebuild = false;
		lock (_turnCacheSync)
		{
			if (!_turnCacheByThread.TryGetValue(normalizedThreadId, out var state))
			{
				rebuild = true;
			}
			else
			{
				rebuild =
					initial ||
					!string.Equals(state.SessionFilePath, sessionFilePath, StringComparison.Ordinal) ||
					state.FileLength != fileLength ||
					state.FileLastWriteUtc != lastWriteUtc ||
					state.MaxEntries != maxEntries;
			}
		}

		if (rebuild)
		{
			RebuildThreadTurnCache(normalizedThreadId, sessionFilePath, maxEntries, fileLength, lastWriteUtc);
		}

		var isTurnInFlight = IsTurnInFlightForThread(normalizedThreadId);
		lock (_turnCacheSync)
		{
			if (!_turnCacheByThread.TryGetValue(normalizedThreadId, out var state))
			{
				throw new InvalidOperationException($"Turn cache is unavailable for thread '{normalizedThreadId}'.");
			}

			var inFlightChanged = state.LastIsTurnInFlight != isTurnInFlight;
			if (inFlightChanged)
			{
				state.Turns = ApplyInFlightFlag(state.Turns, isTurnInFlight);
				state.LastIsTurnInFlight = isTurnInFlight;
				state.Version += 1;
			}

			var version = state.Version;
			var cursorAhead = cursor.HasValue && cursor.Value > version;
			var shouldSendFull =
				initial ||
				cursor is null ||
				cursorAhead ||
				cursor.Value != version;
			var snapshotMode = shouldSendFull ? "full" : "noop";

			var turns = shouldSendFull
				? state.Turns.Select(ToSummaryTurn).ToArray()
				: Array.Empty<ConsolidatedTurnSnapshot>();
			ConsolidatedTurnSnapshot? activeTurnDetail = null;
			if (shouldSendFull && includeActiveTurnDetail && state.Turns.Count > 0)
			{
				var latest = state.Turns[^1];
				if (latest.IsInFlight || latest.Intermediate.Count > 0)
				{
					activeTurnDetail = ToWatchActiveTurnDetail(latest);
				}
			}

			return new TurnWatchSnapshot(
				ThreadId: normalizedThreadId,
				ThreadName: sessionCatalogEntry.ThreadName,
				SessionFilePath: sessionFilePath,
				UpdatedAtUtc: sessionCatalogEntry.UpdatedAtUtc,
				Mode: snapshotMode,
				Cursor: cursor ?? version,
				NextCursor: version,
				Reset: initial || cursorAhead,
				Truncated: state.Truncated,
				TurnCountInMemory: state.Turns.Count,
				ContextUsage: state.ContextUsage,
				Permission: state.Permission,
				ReasoningSummary: state.ReasoningSummary,
				Turns: turns,
				ActiveTurnDetail: activeTurnDetail);
		}
	}

	public ConsolidatedTurnSnapshot GetTurnDetail(string threadId, string turnId, int maxEntries)
	{
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			throw new InvalidOperationException("threadId is required.");
		}

		var normalizedTurnId = turnId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedTurnId))
		{
			throw new InvalidOperationException("turnId is required.");
		}

		// Ensure the in-memory turn cache is hydrated for this thread and window.
		WatchTurns(normalizedThreadId, maxEntries, initial: false, cursor: null, includeActiveTurnDetail: false);

		lock (_turnCacheSync)
		{
			if (!_turnCacheByThread.TryGetValue(normalizedThreadId, out var state))
			{
				throw new FileNotFoundException($"No turn cache found for threadId '{normalizedThreadId}'.");
			}

			var match = state.Turns.FirstOrDefault(x => string.Equals(x.TurnId, normalizedTurnId, StringComparison.Ordinal));
			if (match is null)
			{
				throw new KeyNotFoundException($"No turn found for turnId '{normalizedTurnId}'.");
			}

			var detail = match.Clone();
			detail.IntermediateLoaded = true;
			detail.HasIntermediate = detail.Intermediate.Count > 0;
			detail.IntermediateCount = detail.Intermediate.Count;
			return detail;
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

	private void RebuildThreadTurnCache(
		string threadId,
		string sessionFilePath,
		int maxEntries,
		long fileLength,
		DateTime lastWriteUtc)
	{
		var watch = JsonlFileTailReader.ReadInitial(sessionFilePath, maxEntries);
		var projected = _timelineProjection.Project(threadId, watch, initial: true);
		var inFlight = IsTurnInFlightForThread(threadId);
		var rebuiltTurns = BuildConsolidatedTurns(threadId, projected.Entries, inFlight);
		var inferredTurnInFlightFromLogs = InferTurnInFlightFromLogs(projected.Entries, rebuiltTurns);

		lock (_turnCacheSync)
		{
			if (!_turnCacheByThread.TryGetValue(threadId, out var state))
			{
				state = new ThreadTurnCacheState();
				_turnCacheByThread[threadId] = state;
			}

			state.SessionFilePath = sessionFilePath;
			state.FileLength = fileLength;
			state.FileLastWriteUtc = lastWriteUtc;
			state.MaxEntries = maxEntries;
			state.Truncated = watch.Truncated;
			state.ContextUsage = projected.ContextUsage is null
				? null
				: new TurnContextUsageSnapshot(
					UsedTokens: projected.ContextUsage.UsedTokens,
					ContextWindow: projected.ContextUsage.ContextWindow,
					PercentLeft: projected.ContextUsage.PercentLeft);
			state.Permission = projected.Permission is null
				? null
				: new TurnPermissionInfoSnapshot(
					Approval: projected.Permission.Approval,
					Sandbox: projected.Permission.Sandbox);
			state.ReasoningSummary = projected.ReasoningSummary;
			state.LastIsTurnInFlight = inFlight;
			state.LastInferredTurnInFlightFromLogs = inferredTurnInFlightFromLogs;
			state.Turns = rebuiltTurns;
			state.Version += 1;
		}
	}

	private void EnsureTurnCacheForSessions(IReadOnlyList<ManagedSession> sessions, int maxEntries)
	{
		if (sessions.Count == 0)
		{
			return;
		}

		var uniqueThreadIds = sessions
			.Select(x => x.Session.ThreadId)
			.Where(x => !string.IsNullOrWhiteSpace(x))
			.Distinct(StringComparer.Ordinal)
			.ToArray();
		if (uniqueThreadIds.Length == 0)
		{
			return;
		}

		var catalogByThread = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: 0)
			.Where(x => !string.IsNullOrWhiteSpace(x.ThreadId) && !string.IsNullOrWhiteSpace(x.SessionFilePath))
			.GroupBy(x => x.ThreadId, StringComparer.Ordinal)
			.ToDictionary(
				x => x.Key,
				x => x
					.OrderByDescending(item => item.UpdatedAtUtc ?? DateTimeOffset.MinValue)
					.First(),
				StringComparer.Ordinal);

		foreach (var threadId in uniqueThreadIds)
		{
			if (!catalogByThread.TryGetValue(threadId, out var session) || string.IsNullOrWhiteSpace(session.SessionFilePath))
			{
				continue;
			}

			var sessionFilePath = Path.GetFullPath(session.SessionFilePath);
			if (!File.Exists(sessionFilePath))
			{
				continue;
			}

			try
			{
				var info = new FileInfo(sessionFilePath);
				var rebuild = false;
				lock (_turnCacheSync)
				{
					if (!_turnCacheByThread.TryGetValue(threadId, out var existing))
					{
						rebuild = true;
					}
					else
					{
						rebuild =
							!string.Equals(existing.SessionFilePath, sessionFilePath, StringComparison.Ordinal) ||
							existing.FileLength != info.Length ||
							existing.FileLastWriteUtc != info.LastWriteTimeUtc ||
							existing.MaxEntries != maxEntries;
					}
				}

				if (rebuild)
				{
					RebuildThreadTurnCache(threadId, sessionFilePath, maxEntries, info.Length, info.LastWriteTimeUtc);
				}
			}
			catch
			{
			}
		}
	}

	private static bool InferTurnInFlightFromLogs(
		IReadOnlyList<TimelineProjectedEntry> entries,
		IReadOnlyList<ConsolidatedTurnSnapshot> turns)
	{
		var lastBoundaryDirection = 0; // 1=start, -1=end, 0=none
		foreach (var entry in entries)
		{
			if (entry is null)
			{
				continue;
			}

			var rawType = entry.RawType ?? string.Empty;
			var boundary = entry.TaskBoundary ?? string.Empty;
			if (string.Equals(boundary, "start", StringComparison.Ordinal) ||
				string.Equals(rawType, "task_started", StringComparison.Ordinal) ||
				string.Equals(rawType, "turn_started", StringComparison.Ordinal))
			{
				lastBoundaryDirection = 1;
				continue;
			}

			if (string.Equals(boundary, "end", StringComparison.Ordinal) ||
				string.Equals(rawType, "task_complete", StringComparison.Ordinal) ||
				string.Equals(rawType, "turn_complete", StringComparison.Ordinal))
			{
				lastBoundaryDirection = -1;
			}
		}

		// When the newest explicit boundary is completion, treat the turn as complete.
		if (lastBoundaryDirection < 0)
		{
			return false;
		}

		if (lastBoundaryDirection > 0)
		{
			return true;
		}

		if (turns.Count == 0)
		{
			return false;
		}

		var lastTurn = turns[^1];
		return lastTurn.AssistantFinal is null && lastTurn.Intermediate.Count > 0;
	}

	private bool IsTurnInFlightForThread(string threadId)
	{
		lock (_sync)
		{
			foreach (var session in _sessions.Values)
			{
				if (!string.Equals(session.Session.ThreadId, threadId, StringComparison.Ordinal))
				{
					continue;
				}

				if (session.IsTurnInFlight)
				{
					return true;
				}
			}
		}

		return false;
	}

	private static List<ConsolidatedTurnSnapshot> BuildConsolidatedTurns(
		string threadId,
		IReadOnlyList<TimelineProjectedEntry> entries,
		bool inFlight)
	{
		var turns = new List<ConsolidatedTurnBuilder>();
		ConsolidatedTurnBuilder? current = null;

		foreach (var entry in entries)
		{
			if (entry is null)
			{
				continue;
			}

			var entryTaskId = entry.TaskId?.Trim();
			var isTopLevelTaskStart =
				string.Equals(entry.TaskBoundary, "start", StringComparison.Ordinal) &&
				entry.TaskDepth == 1 &&
				string.Equals(entry.RawType, "task_started", StringComparison.Ordinal);
			if (isTopLevelTaskStart && !string.Equals(entry.Role, "user", StringComparison.Ordinal))
			{
				var shouldOpenInferredTurn =
					current is null ||
					!current.IsInferredUserAnchor ||
					current.FinalAssistant is not null ||
					current.Intermediate.Count > 0;
				if (shouldOpenInferredTurn)
				{
					var inferredUserEntry = new TimelineProjectedEntry
					{
						Role = "user",
						Title = "Turn",
						Text = string.Empty,
						Timestamp = entry.Timestamp,
						RawType = "turn_window_anchor",
						Compact = true,
						TaskId = entryTaskId
					};
					current = new ConsolidatedTurnBuilder(inferredUserEntry, entryTaskId, isInferredUserAnchor: true);
					turns.Add(current);
				}
			}

			if (string.Equals(entry.Role, "user", StringComparison.Ordinal))
			{
				if (current is not null &&
					current.IsInferredUserAnchor &&
					current.FinalAssistant is null &&
					current.Intermediate.Count <= 1)
				{
					current.ReplaceInferredUser(entry, entryTaskId);
					continue;
				}

				current = new ConsolidatedTurnBuilder(entry, entryTaskId);
				turns.Add(current);
				continue;
			}

			if (current is null)
			{
				continue;
			}

			if (string.Equals(entry.Role, "assistant", StringComparison.Ordinal))
			{
				if (current.FinalAssistant is not null)
				{
					current.Intermediate.Add(ToTurnEntry(current.FinalAssistant));
				}

				current.FinalAssistant = entry.Clone();
				continue;
			}

			current.Intermediate.Add(ToTurnEntry(entry));
		}

		if (turns.Count > 0 && inFlight)
		{
			turns[^1].IsInFlight = true;
		}

		return turns.Select((turn, idx) => turn.ToSnapshot(threadId, idx + 1)).ToList();
	}

	private static List<ConsolidatedTurnSnapshot> ApplyInFlightFlag(
		IReadOnlyList<ConsolidatedTurnSnapshot> prior,
		bool inFlight)
	{
		if (prior.Count == 0)
		{
			return new List<ConsolidatedTurnSnapshot>();
		}

		var next = prior.Select(x => x.Clone()).ToList();
		for (var i = 0; i < next.Count; i += 1)
		{
			next[i].IsInFlight = false;
		}

		if (inFlight)
		{
			next[^1].IsInFlight = true;
		}

		return next;
	}

	private static ConsolidatedTurnSnapshot ToSummaryTurn(ConsolidatedTurnSnapshot source)
	{
		var summary = new ConsolidatedTurnSnapshot
		{
			TurnId = source.TurnId,
			User = ToWatchEntry(source.User),
			AssistantFinal = source.AssistantFinal is null ? null : ToWatchEntry(source.AssistantFinal),
			Intermediate = new List<TurnEntrySnapshot>(),
			IsInFlight = source.IsInFlight,
			HasIntermediate = source.Intermediate.Count > 0,
			IntermediateCount = source.Intermediate.Count,
			IntermediateLoaded = false
		};

		return summary;
	}

	private static ConsolidatedTurnSnapshot ToWatchActiveTurnDetail(ConsolidatedTurnSnapshot source)
	{
		var totalIntermediateCount = source.Intermediate.Count;
		var maxIntermediateCount = Math.Max(1, WatchActiveDetailMaxIntermediateEntries);
		var skippedIntermediateCount = Math.Max(0, totalIntermediateCount - maxIntermediateCount);
		var visibleIntermediate = skippedIntermediateCount > 0
			? source.Intermediate.Skip(skippedIntermediateCount)
			: source.Intermediate.AsEnumerable();

		var detail = new ConsolidatedTurnSnapshot
		{
			TurnId = source.TurnId,
			User = ToWatchEntry(source.User),
			AssistantFinal = source.AssistantFinal is null ? null : ToWatchEntry(source.AssistantFinal),
			Intermediate = visibleIntermediate.Select(ToWatchEntry).ToList(),
			IsInFlight = source.IsInFlight,
			HasIntermediate = totalIntermediateCount > 0,
			IntermediateCount = totalIntermediateCount,
			IntermediateLoaded = skippedIntermediateCount == 0
		};

		return detail;
	}

	private static TurnEntrySnapshot ToWatchEntry(TurnEntrySnapshot source)
	{
		var text = ClipWatchEntryText(source);
		return new TurnEntrySnapshot(
			source.Role,
			source.Title,
			text,
			source.Timestamp,
			source.RawType,
			source.Compact,
			source.Images ?? Array.Empty<string>());
	}

	private static string ClipWatchEntryText(TurnEntrySnapshot source)
	{
		var text = source.Text ?? string.Empty;
		if (text.Length == 0)
		{
			return text;
		}

		var rawType = source.RawType ?? string.Empty;
		var role = source.Role ?? string.Empty;
		var isToolRole = string.Equals(role, "tool", StringComparison.OrdinalIgnoreCase);
		var isToolOutput =
			string.Equals(rawType, "function_call_output", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(rawType, "custom_tool_call_output", StringComparison.OrdinalIgnoreCase) ||
			rawType.IndexOf("tool_call_output", StringComparison.OrdinalIgnoreCase) >= 0;
		var isToolCall =
			string.Equals(rawType, "function_call", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(rawType, "custom_tool_call", StringComparison.OrdinalIgnoreCase) ||
			rawType.IndexOf("tool_call", StringComparison.OrdinalIgnoreCase) >= 0;

		var maxChars = WatchGeneralTextSafetyMaxChars;
		if (isToolOutput)
		{
			maxChars = WatchToolOutputTextMaxChars;
		}
		else if (isToolCall)
		{
			maxChars = WatchToolCallTextMaxChars;
		}
		else if (isToolRole)
		{
			maxChars = WatchToolOutputTextMaxChars;
		}

		return ClipMiddle(text, maxChars);
	}

	private static string ClipMiddle(string text, int maxChars)
	{
		if (string.IsNullOrEmpty(text))
		{
			return string.Empty;
		}

		var boundedMax = Math.Max(256, maxChars);
		if (text.Length <= boundedMax)
		{
			return text;
		}

		const string marker = "\n... (truncated middle) ...\n";
		var available = boundedMax - marker.Length;
		if (available <= 32)
		{
			return text.Substring(0, Math.Max(32, boundedMax));
		}

		var headChars = (int)Math.Floor(available * 0.7);
		var tailChars = available - headChars;
		if (tailChars < 32)
		{
			tailChars = 32;
			headChars = available - tailChars;
		}
		if (headChars < 32)
		{
			headChars = 32;
			tailChars = available - headChars;
		}

		var head = text.Substring(0, headChars);
		var tail = text.Substring(text.Length - tailChars, tailChars);
		return head + marker + tail;
	}

	private static TurnEntrySnapshot ToTurnEntry(TimelineProjectedEntry source)
	{
		return new TurnEntrySnapshot(
			source.Role,
			source.Title,
			source.Text,
			source.Timestamp,
			source.RawType,
			source.Compact,
			source.Images?.ToArray() ?? Array.Empty<string>());
	}

	public async Task<SessionCreatedPayload> CreateSessionAsync(
		string sessionId,
		string? model,
		string? effort,
		string? approvalPolicy,
		string? sandboxMode,
		string? cwd,
		string? codexPath,
		CancellationToken cancellationToken)
	{
		model = string.IsNullOrWhiteSpace(model) ? _defaults.DefaultModel : model.Trim();
		effort = WebCodexUtils.NormalizeReasoningEffort(effort);
		approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy);
		sandboxMode = WebCodexUtils.NormalizeSandboxMode(sandboxMode);
		cwd = string.IsNullOrWhiteSpace(cwd) ? _defaults.DefaultCwd : cwd.Trim();
		codexPath = string.IsNullOrWhiteSpace(codexPath) ? _defaults.CodexPath : codexPath.Trim();

		return await StartManagedSessionAsync(
			sessionId,
			model,
			effort,
			approvalPolicy,
			sandboxMode,
			cwd,
			codexPath,
			attached: false,
			(client, ct) => client.CreateSessionAsync(new CodexSessionCreateOptions
			{
				Cwd = cwd,
				Model = model,
				ApprovalPolicy = approvalPolicy,
				SandboxMode = sandboxMode
			}, ct),
			cancellationToken);
	}

	public async Task<SessionCreatedPayload> AttachSessionAsync(
		string sessionId,
		string threadId,
		string? model,
		string? effort,
		string? approvalPolicy,
		string? sandboxMode,
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
		approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy);
		sandboxMode = WebCodexUtils.NormalizeSandboxMode(sandboxMode);
		cwd = string.IsNullOrWhiteSpace(cwd) ? _defaults.DefaultCwd : cwd.Trim();
		codexPath = string.IsNullOrWhiteSpace(codexPath) ? _defaults.CodexPath : codexPath.Trim();

		return await StartManagedSessionAsync(
			sessionId,
			model,
			effort,
			approvalPolicy,
			sandboxMode,
			cwd,
			codexPath,
			attached: true,
			(client, ct) => client.AttachToSessionAsync(new CodexSessionAttachOptions
			{
				ThreadId = threadId,
				Cwd = cwd,
				Model = model,
				ApprovalPolicy = approvalPolicy,
				SandboxMode = sandboxMode
			}, ct),
			cancellationToken);
	}

	private async Task<SessionCreatedPayload> StartManagedSessionAsync(
		string sessionId,
		string? model,
		string? effort,
		string? approvalPolicy,
		string? sandboxMode,
		string? cwd,
		string? codexPath,
		bool attached,
		Func<CodexClient, CancellationToken, Task<CodexSession>> openSessionAsync,
		CancellationToken cancellationToken,
		bool appServerRecovering = false)
	{
		var effectiveCodexPath = codexPath ?? _defaults.CodexPath;
		var effectiveCwd = cwd ?? _defaults.DefaultCwd;
		var startupAuthState = CodexAuthStateReader.Read(_defaults.CodexHomePath);
		var sessionLogPath = Path.Combine(_defaults.LogRootPath, $"session-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{sessionId}.log");
		var sessionLog = new LocalLogWriter(sessionLogPath);
		var pendingApprovals = new ConcurrentDictionary<string, TaskCompletionSource<string>>(StringComparer.Ordinal);
		var pendingToolUserInputs = new ConcurrentDictionary<string, TaskCompletionSource<Dictionary<string, object?>>>(StringComparer.Ordinal);

		CodexClient? client = null;
		CodexSession? session = null;
		CancellationTokenSource? appServerLifetimeCts = null;
		try
		{
			var startupTimeoutSeconds = Math.Clamp(_defaults.TurnTimeoutSeconds, 30, 1200);
			WriteOrchestratorAudit(
				$"event=appserver_session_start_requested sessionId={sessionId} attached={attached} recovering={appServerRecovering} cwd={effectiveCwd} model={model ?? "(default)"} startupToken=caller runtimeToken=session_lifetime startupTimeoutSeconds={startupTimeoutSeconds} callerTokenCanBeCanceled={cancellationToken.CanBeCanceled}");
			var clientOptions = new CodexClientOptions
			{
				CodexPath = effectiveCodexPath,
				WorkingDirectory = effectiveCwd,
				CodexHomePath = _defaults.CodexHomePath,
				ServerRequestHandler = async (req, ct) =>
				{
					return await HandleServerRequestAsync(sessionId, sessionLog, pendingApprovals, pendingToolUserInputs, req, ct);
				}
			};

			appServerLifetimeCts = new CancellationTokenSource();
			using var startupTimeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(startupTimeoutSeconds));
			using var startupCts = CancellationTokenSource.CreateLinkedTokenSource(
				appServerLifetimeCts.Token,
				startupTimeoutCts.Token,
				cancellationToken);
			client = await CodexClient.StartAsync(clientOptions, startupCts.Token, appServerLifetimeCts.Token);
			client.OnEvent += ev =>
			{
				HandleCoreEvent(sessionId, sessionLog, ev);
			};

			session = await openSessionAsync(client, startupCts.Token);
			WriteOrchestratorAudit(
				$"event=appserver_session_started sessionId={sessionId} threadId={session.ThreadId} approval={session.ApprovalPolicy ?? approvalPolicy ?? "(default)"} sandbox={session.SandboxMode ?? sandboxMode ?? "(default)"}");
		}
		catch (OperationCanceledException ex)
		{
			if (client is not null)
			{
				try
				{
					await client.DisposeAsync();
				}
				catch
				{
				}
			}

			try
			{
				appServerLifetimeCts?.Cancel();
			}
			catch
			{
			}
			appServerLifetimeCts?.Dispose();
			WriteOrchestratorAudit(
				$"event=appserver_session_start_canceled sessionId={sessionId} attached={attached} recovering={appServerRecovering} detail={ex.Message} callerTokenCanceled={cancellationToken.IsCancellationRequested}");
			sessionLog.Dispose();
			throw;
		}
		catch
		{
			if (client is not null)
			{
				try
				{
					await client.DisposeAsync();
				}
				catch
				{
				}
			}

			try
			{
				appServerLifetimeCts?.Cancel();
			}
			catch
			{
			}
			appServerLifetimeCts?.Dispose();
			WriteOrchestratorAudit(
				$"event=appserver_session_start_failed sessionId={sessionId} attached={attached} recovering={appServerRecovering}");
			sessionLog.Dispose();
			throw;
		}

		if (client is null || session is null || appServerLifetimeCts is null)
		{
			throw new InvalidOperationException("App-server session startup did not initialize expected state.");
		}

		var managed = new ManagedSession(
			sessionId,
			client,
			session,
			cwd,
			effectiveCodexPath,
			model,
			effort,
			sessionLog,
			pendingApprovals,
			pendingToolUserInputs,
			ApprovalPolicy: session.ApprovalPolicy ?? approvalPolicy,
			SandboxPolicy: session.SandboxMode ?? sandboxMode,
			StartupAuthIdentityKey: NormalizeAuthIdentityKey(startupAuthState.IdentityKey),
			StartupAuthLabel: NormalizeAuthLabel(startupAuthState.DisplayLabel),
			AppServerRecovering: appServerRecovering,
			ClientLifetimeCts: appServerLifetimeCts);
		lock (_sync)
		{
			_sessions[sessionId] = managed;
		}

		try
		{
			WatchTurns(session.ThreadId, maxEntries: 6000, initial: true, cursor: null);
		}
		catch
		{
		}

		SessionsChanged?.Invoke();

		return new SessionCreatedPayload(
			sessionId: sessionId,
			threadId: session.ThreadId,
			model: model,
			reasoningEffort: effort,
			approvalPolicy: managed.CurrentApprovalPolicy,
			sandboxPolicy: managed.CurrentSandboxPolicy,
			cwd: cwd,
			logPath: sessionLogPath,
			attached: attached);
	}

	public LoadedSessionAttachResolution ResolveLoadedSessionForAttach(string threadId)
	{
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			return new LoadedSessionAttachResolution(
				Kind: LoadedSessionAttachResolutionKind.Unavailable,
				SessionId: null,
				ThreadId: null,
				Cwd: null,
				Model: null,
				ReasoningEffort: null,
				ApprovalPolicy: null,
				SandboxPolicy: null,
				Reason: "threadId is required to attach.",
				CandidateSessionIds: Array.Empty<string>());
		}

		lock (_sync)
		{
			var matches = _sessions.Values
				.Where(x => string.Equals(x.Session.ThreadId, normalizedThreadId, StringComparison.Ordinal))
				.ToList();

			if (matches.Count == 0)
			{
				return new LoadedSessionAttachResolution(
					Kind: LoadedSessionAttachResolutionKind.NotLoaded,
					SessionId: null,
					ThreadId: normalizedThreadId,
					Cwd: null,
					Model: null,
					ReasoningEffort: null,
					ApprovalPolicy: null,
					SandboxPolicy: null,
					Reason: null,
					CandidateSessionIds: Array.Empty<string>());
			}

			if (matches.Count > 1)
			{
				var candidateIds = matches
					.Select(x => x.SessionId)
					.Where(x => !string.IsNullOrWhiteSpace(x))
					.Distinct(StringComparer.Ordinal)
					.OrderBy(x => x, StringComparer.Ordinal)
					.ToArray();
				return new LoadedSessionAttachResolution(
					Kind: LoadedSessionAttachResolutionKind.Ambiguous,
					SessionId: null,
					ThreadId: normalizedThreadId,
					Cwd: null,
					Model: null,
					ReasoningEffort: null,
					ApprovalPolicy: null,
					SandboxPolicy: null,
					Reason: $"Multiple loaded sessions match thread '{normalizedThreadId}'.",
					CandidateSessionIds: candidateIds);
			}

			var match = matches[0];
			if (match.LifetimeToken.IsCancellationRequested)
			{
				return new LoadedSessionAttachResolution(
					Kind: LoadedSessionAttachResolutionKind.Unavailable,
					SessionId: match.SessionId,
					ThreadId: match.Session.ThreadId,
					Cwd: match.Cwd,
					Model: match.CurrentModel,
					ReasoningEffort: match.CurrentReasoningEffort,
					ApprovalPolicy: match.CurrentApprovalPolicy,
					SandboxPolicy: match.CurrentSandboxPolicy,
					Reason: $"Loaded session '{match.SessionId}' is stopping; retry attach after it is fully stopped.",
					CandidateSessionIds: new[] { match.SessionId });
			}

			return new LoadedSessionAttachResolution(
				Kind: LoadedSessionAttachResolutionKind.Resolved,
				SessionId: match.SessionId,
				ThreadId: match.Session.ThreadId,
				Cwd: match.Cwd,
				Model: match.CurrentModel,
				ReasoningEffort: match.CurrentReasoningEffort,
				ApprovalPolicy: match.CurrentApprovalPolicy,
				SandboxPolicy: match.CurrentSandboxPolicy,
				Reason: null,
				CandidateSessionIds: new[] { match.SessionId });
		}
	}

	public bool TryGetTurnState(string sessionId, out bool isTurnInFlight)
	{
		isTurnInFlight = false;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		ManagedSession? session;
		lock (_sync)
		{
			if (!_sessions.TryGetValue(sessionId, out session))
			{
				return false;
			}
		}

		RecoverTurnStateFromClientIfNeeded(sessionId, session);
		isTurnInFlight = session.IsTurnInFlight;
		return true;
	}

	public bool TryGetSessionRecoveryState(string sessionId, out bool isAppServerRecovering)
	{
		isAppServerRecovering = false;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return false;
		}

		isAppServerRecovering = session.IsAppServerRecovering;
		return true;
	}

	public bool TryGetTurnSteerability(string sessionId, out bool canSteer)
	{
		canSteer = false;
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return false;
		}

		if (!session.IsTurnInFlight || session.IsTurnInFlightRecoveredFromLogs)
		{
			canSteer = false;
			return true;
		}

		canSteer = !string.IsNullOrWhiteSpace(session.ResolveActiveTurnId());
		return true;
	}

	public bool TrySetSessionModel(string sessionId, string? model, string? effort)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return false;
		}

		if (model is not null)
		{
			session.SetModel(model);
		}
		if (effort is not null)
		{
			session.SetReasoningEffort(effort);
		}
		return true;
	}

	public bool TrySetSessionPermissions(
		string sessionId,
		string? approvalPolicy,
		string? sandboxPolicy,
		bool hasApprovalOverride,
		bool hasSandboxOverride)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return false;
		}

		if (hasApprovalOverride)
		{
			session.SetApprovalPolicy(approvalPolicy);
		}

		if (hasSandboxOverride)
		{
			session.SetSandboxPolicy(sandboxPolicy);
		}

		return true;
	}

	public async Task<IReadOnlyList<CodexModelInfo>> ListModelsAsync(string? sessionId, CancellationToken cancellationToken)
	{
		var existingSession = TryGetSession(sessionId ?? string.Empty);
		var existingClient = existingSession?.Client;

		if (existingClient is not null)
		{
			var sessionWithClient = existingSession!;
			var inFlightAtStart = sessionWithClient.IsTurnInFlight;
			var stopwatch = Stopwatch.StartNew();
			try
			{
				if (sessionWithClient.TryGetCachedModels(out var freshCachedModels, ModelsListCacheTtl))
				{
					WriteOrchestratorAudit(
						$"event=models_list_from_cache sessionId={sessionId} reason=ttl_fresh maxAgeSec={Math.Round(ModelsListCacheTtl.TotalSeconds)} modelCount={freshCachedModels.Count} threadId={sessionWithClient.Session.ThreadId}");
					return freshCachedModels;
				}

				if (sessionWithClient.IsAppServerRecovering)
				{
					if (sessionWithClient.TryGetCachedModels(out var recoveringCachedModels))
					{
						WriteOrchestratorAudit(
							$"event=models_list_from_cache sessionId={sessionId} reason=session_recovering modelCount={recoveringCachedModels.Count} threadId={sessionWithClient.Session.ThreadId}");
						return recoveringCachedModels;
					}

					WriteOrchestratorAudit(
						$"event=models_list_deferred sessionId={sessionId} reason=session_recovering_no_cache threadId={sessionWithClient.Session.ThreadId}");
					throw new InvalidOperationException("Session is recovering; model list is temporarily unavailable.");
				}

				if (sessionWithClient.IsLocalTurnAwaitingStartStale(TimeSpan.Zero, out var pendingStartAge))
				{
					if (sessionWithClient.TryGetCachedModels(out var pendingStartCachedModels))
					{
						WriteOrchestratorAudit(
							$"event=models_list_from_cache sessionId={sessionId} reason=turn_start_pending pendingMs={Math.Round(pendingStartAge.TotalMilliseconds)} modelCount={pendingStartCachedModels.Count} threadId={sessionWithClient.Session.ThreadId} {sessionWithClient.BuildRpcDebugSummary()}");
						return pendingStartCachedModels;
					}

					WriteOrchestratorAudit(
						$"event=models_list_deferred sessionId={sessionId} reason=turn_start_pending_no_cache pendingMs={Math.Round(pendingStartAge.TotalMilliseconds)} threadId={sessionWithClient.Session.ThreadId} {sessionWithClient.BuildRpcDebugSummary()}");
					throw new InvalidOperationException("Turn is starting and model list is deferred until start is acknowledged.");
				}

				if (inFlightAtStart)
				{
					if (sessionWithClient.TryGetCachedModels(out var inFlightCachedModels))
					{
						WriteOrchestratorAudit(
							$"event=models_list_from_cache sessionId={sessionId} reason=turn_in_flight modelCount={inFlightCachedModels.Count} threadId={sessionWithClient.Session.ThreadId} {sessionWithClient.BuildTurnDebugSummary()}");
						return inFlightCachedModels;
					}

					WriteOrchestratorAudit(
						$"event=models_list_during_turn sessionId={sessionId} threadId={sessionWithClient.Session.ThreadId} {sessionWithClient.BuildTurnDebugSummary()}");
				}

				var models = await existingSession!.QueryModelsSerializedAsync(
					ct => existingClient.ListModelsAsync(cancellationToken: ct),
					cancellationToken,
					ModelsListCacheTtl);
				stopwatch.Stop();
				if (inFlightAtStart || stopwatch.ElapsedMilliseconds >= 1000)
				{
					WriteOrchestratorAudit(
						$"event=models_list_completed sessionId={sessionId} threadId={existingSession?.Session.ThreadId ?? "(none)"} elapsedMs={stopwatch.ElapsedMilliseconds} modelCount={models.Count} inFlightAtStart={inFlightAtStart} {(existingSession is null ? string.Empty : existingSession.BuildTurnDebugSummary())}".Trim());
				}

				return models;
			}
			catch (OperationCanceledException)
			{
				stopwatch.Stop();
				WriteOrchestratorAudit(
					$"event=models_list_canceled sessionId={sessionId} threadId={existingSession?.Session.ThreadId ?? "(none)"} elapsedMs={stopwatch.ElapsedMilliseconds} inFlightAtStart={inFlightAtStart} {(existingSession is null ? string.Empty : existingSession.BuildTurnDebugSummary())}".Trim());
				throw;
			}
			catch (Exception ex)
			{
				stopwatch.Stop();
				WriteOrchestratorAudit(
					$"event=models_list_failed sessionId={sessionId} threadId={existingSession?.Session.ThreadId ?? "(none)"} elapsedMs={stopwatch.ElapsedMilliseconds} inFlightAtStart={inFlightAtStart} error={ex.Message} {(existingSession is null ? string.Empty : existingSession.BuildTurnDebugSummary())}".Trim());
				throw;
			}
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

		var session = TryGetSession(sessionId);
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

	public bool TryResolveToolUserInput(string sessionId, string? requestId, IReadOnlyDictionary<string, string> answersByQuestionId)
	{
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return false;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return false;
		}

		var pendingId = string.IsNullOrWhiteSpace(requestId) ? session.PendingToolUserInputId : requestId.Trim();
		if (string.IsNullOrWhiteSpace(pendingId))
		{
			return false;
		}

		if (session.PendingToolUserInputs.TryRemove(pendingId, out var tcs))
		{
			var answers = BuildToolUserInputAnswersPayload(answersByQuestionId);
			tcs.TrySetResult(answers);
			SessionsChanged?.Invoke();
			return true;
		}

		return false;
	}

	public bool TryResolveRecoveryOfferDecision(
		string sessionId,
		string? offerId,
		bool recover,
		out string? errorMessage)
	{
		errorMessage = null;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			errorMessage = "sessionId is required.";
			return false;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			errorMessage = $"Unknown session: {sessionId}";
			return false;
		}

		var normalizedOfferId = string.IsNullOrWhiteSpace(offerId) ? null : offerId.Trim();
		if (recover)
		{
			if (!session.TryConsumeRecoveryOffer(normalizedOfferId, out var offeredRecovery) || offeredRecovery is null)
			{
				errorMessage = "No pending recovery prompt was found.";
				return false;
			}

			var pendingAge = TimeSpan.FromSeconds(Math.Max(0, offeredRecovery.PendingSeconds));
			var roundedSeconds = Math.Round(pendingAge.TotalSeconds);
			WriteOrchestratorAudit(
				$"event=recovery_decision_received sessionId={sessionId} threadId={session.Session.ThreadId} offerId={offeredRecovery.OfferId} decision=recover reason={offeredRecovery.Reason} pendingSeconds={roundedSeconds:0}");

			if (!session.TryBeginAppServerRecovery())
			{
				session.Log.Write($"[session_recovery] decision accepted offerId={offeredRecovery.OfferId} but session was already recovering");
				SessionsChanged?.Invoke();
				return true;
			}

			var collaborationMode = session.GetActiveCollaborationMode();
			var isPlanTurn = string.Equals(collaborationMode, "plan", StringComparison.Ordinal);
			var reset = session.ForceResetTurnState(clearQueuedTurns: false, preserveRecoverableTurn: true);
			if (reset.HadTurnInFlight)
			{
				Broadcast?.Invoke(
					"turn_complete",
					new
					{
						sessionId,
						cwd = session.Cwd ?? string.Empty,
						status = "interrupted",
						errorMessage = offeredRecovery.Message,
						isPlanTurn,
						collaborationMode
					});
			}

			session.Log.Write(
				$"[session_recovery] decision accepted offerId={offeredRecovery.OfferId} reason={offeredRecovery.Reason} pendingSeconds={roundedSeconds:0}");
			Broadcast?.Invoke(
				"session_recovery_state",
				new
				{
					sessionId,
					state = "recovering",
					reason = offeredRecovery.Reason,
					offerId = offeredRecovery.OfferId,
					pendingSeconds = roundedSeconds
				});
			Broadcast?.Invoke("status", new { sessionId, message = "Recovery accepted. Restarting session app-server." });
			WriteOrchestratorAudit(
				$"event=appserver_recovery_requested sessionId={sessionId} threadId={session.Session.ThreadId} pendingSeconds={roundedSeconds:0} reason={offeredRecovery.Reason} queuedTurns={session.GetQueuedTurnsSnapshot().Count}");
			SessionsChanged?.Invoke();
			_ = Task.Run(() => RecoverSessionAfterStaleTurnStartAsync(sessionId, session, pendingAge), CancellationToken.None);
			return true;
		}

		if (!session.TryDismissRecoveryOffer(normalizedOfferId, out var dismissedRecovery) || dismissedRecovery is null)
		{
			errorMessage = "No pending recovery prompt was found.";
			return false;
		}

		var dismissedSeconds = Math.Round(Math.Max(0, dismissedRecovery.PendingSeconds));
		session.Log.Write(
			$"[session_recovery] decision dismissed offerId={dismissedRecovery.OfferId} reason={dismissedRecovery.Reason} pendingSeconds={dismissedSeconds:0}");
		WriteOrchestratorAudit(
			$"event=recovery_decision_received sessionId={sessionId} threadId={session.Session.ThreadId} offerId={dismissedRecovery.OfferId} decision=dismiss reason={dismissedRecovery.Reason} pendingSeconds={dismissedSeconds:0}");
		Broadcast?.Invoke(
			"session_recovery_offer",
			new
			{
				sessionId,
				state = "dismissed",
				offerId = dismissedRecovery.OfferId,
				reason = dismissedRecovery.Reason
			});
		Broadcast?.Invoke("status", new { sessionId, message = "Recovery prompt dismissed. Session remains stalled." });
		SessionsChanged?.Invoke();
		return true;
	}

	public bool TryResolveTurnRetryDecision(
		string sessionId,
		string? offerId,
		bool retry,
		out string? errorMessage)
	{
		errorMessage = null;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			errorMessage = "sessionId is required.";
			return false;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			errorMessage = $"Unknown session: {sessionId}";
			return false;
		}

		var normalizedOfferId = string.IsNullOrWhiteSpace(offerId) ? null : offerId.Trim();
		if (retry)
		{
			if (session.IsAppServerRecovering)
			{
				errorMessage = "Session is still recovering. Wait for recovery to finish, then retry.";
				return false;
			}

			if (session.IsTurnInFlight)
			{
				errorMessage = "A turn is already running for this session.";
				return false;
			}

			if (!session.TryConsumeTurnRetryOffer(normalizedOfferId, out var retryOffer, out var replay) ||
				retryOffer is null ||
				replay is null)
			{
				errorMessage = "No pending retry prompt was found.";
				return false;
			}

			var request = new TurnExecutionRequest(
				Text: replay.Text,
				Cwd: replay.Cwd,
				Images: replay.Images,
				CollaborationMode: replay.CollaborationMode,
				QueueItemId: null,
				ModelOverride: replay.Model,
				ReasoningEffortOverride: replay.ReasoningEffort,
				ApprovalPolicyOverride: replay.ApprovalPolicy,
				SandboxPolicyOverride: replay.SandboxPolicy,
				ReplaySource: "stale_turn_retry");
			WriteOrchestratorAudit(
				$"event=turn_retry_decision_received sessionId={sessionId} threadId={session.Session.ThreadId} offerId={retryOffer.OfferId} decision=retry dispatchId={retryOffer.DispatchId ?? "(none)"} text={SummarizeTextForAudit(request.Text, request.Images.Count)}");
			session.Log.Write(
				$"[turn_retry] decision accepted offerId={retryOffer.OfferId} dispatchId={retryOffer.DispatchId ?? "(none)"} text={BuildQueuedTurnPreview(request.Text, request.Images.Count)}");
			Broadcast?.Invoke("status", new { sessionId, message = "Retry accepted. Resending last prompt." });
			SessionsChanged?.Invoke();
			LaunchTurnExecution(sessionId, session, request, fromQueue: false);
			return true;
		}

		if (!session.TryDismissTurnRetryOffer(normalizedOfferId, out var dismissedOffer) || dismissedOffer is null)
		{
			errorMessage = "No pending retry prompt was found.";
			return false;
		}

		WriteOrchestratorAudit(
			$"event=turn_retry_decision_received sessionId={sessionId} threadId={session.Session.ThreadId} offerId={dismissedOffer.OfferId} decision=dismiss dispatchId={dismissedOffer.DispatchId ?? "(none)"}");
		session.Log.Write($"[turn_retry] decision dismissed offerId={dismissedOffer.OfferId}");
		Broadcast?.Invoke(
			"turn_retry_offer",
			new
			{
				sessionId,
				state = "dismissed",
				offerId = dismissedOffer.OfferId
			});
		Broadcast?.Invoke("status", new { sessionId, message = "Retry prompt dismissed." });
		SessionsChanged?.Invoke();
		return true;
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
		CleanupTurnCacheStateForThreadIfUnused(removed?.Session.ThreadId);
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

	private void CleanupTurnCacheStateForThreadIfUnused(string? threadId)
	{
		if (string.IsNullOrWhiteSpace(threadId))
		{
			return;
		}

		var stillLoaded = false;
		lock (_sync)
		{
			stillLoaded = _sessions.Values.Any(x => string.Equals(x.Session.ThreadId, threadId, StringComparison.Ordinal));
		}

		if (stillLoaded)
		{
			return;
		}

		lock (_turnCacheSync)
		{
			_turnCacheByThread.Remove(threadId);
		}
	}

	public ManagedSession? TryGetSession(string sessionId)
	{
		lock (_sync)
		{
			return _sessions.TryGetValue(sessionId, out var s) ? s : null;
		}
	}

	public void StartTurn(
		string sessionId,
		string normalizedText,
		string? normalizedCwd,
		string? normalizedModel,
		string? normalizedEffort,
		string? normalizedApprovalPolicy,
		string? normalizedSandboxPolicy,
		CodexCollaborationMode? normalizedCollaborationMode,
		bool hasModelOverride,
		bool hasEffortOverride,
		bool hasApprovalOverride,
		bool hasSandboxOverride,
		IReadOnlyList<CodexUserImageInput>? images)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			WriteOrchestratorAudit($"event=turn_send_rejected sessionId={sessionId} reason=unknown_session");
			Broadcast?.Invoke("error", new { message = $"Unknown session: {sessionId}" });
			return;
		}

		if (TryGuardAgainstAuthAccountSwitch(sessionId, session, operation: "turn_start", out var authErrorMessage))
		{
			WriteOrchestratorAudit($"event=turn_send_rejected sessionId={sessionId} reason=auth_account_switched");
			Broadcast?.Invoke("error", new { message = authErrorMessage });
			return;
		}

		ApplySessionTurnOverrides(
			session,
			normalizedModel,
			normalizedEffort,
			normalizedApprovalPolicy,
			normalizedSandboxPolicy,
			hasModelOverride,
			hasEffortOverride,
			hasApprovalOverride,
			hasSandboxOverride);

		var request = new TurnExecutionRequest(
			Text: normalizedText,
			Cwd: normalizedCwd,
			Images: images is null ? Array.Empty<CodexUserImageInput>() : images.ToArray(),
			CollaborationMode: normalizedCollaborationMode,
			QueueItemId: null);
		WriteOrchestratorAudit(
			$"event=turn_send_requested sessionId={sessionId} threadId={session.Session.ThreadId} fromQueue=False mode={WebCodexUtils.NormalizeCollaborationMode(normalizedCollaborationMode?.Mode) ?? "default"} text={SummarizeTextForAudit(normalizedText, request.Images.Count)}");
		LaunchTurnExecution(sessionId, session, request, fromQueue: false);
	}

	public bool TryEnqueueTurn(
		string sessionId,
		string normalizedText,
		string? normalizedCwd,
		string? normalizedModel,
		string? normalizedEffort,
		string? normalizedApprovalPolicy,
		string? normalizedSandboxPolicy,
		CodexCollaborationMode? normalizedCollaborationMode,
		bool hasModelOverride,
		bool hasEffortOverride,
		bool hasApprovalOverride,
		bool hasSandboxOverride,
		IReadOnlyList<CodexUserImageInput>? images,
		out string? queueItemId,
		out string? errorMessage)
	{
		queueItemId = null;
		errorMessage = null;
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			errorMessage = $"Unknown session: {sessionId}";
			return false;
		}

		if (TryGuardAgainstAuthAccountSwitch(sessionId, session, operation: "turn_queue_add", out var authErrorMessage))
		{
			errorMessage = authErrorMessage;
			Broadcast?.Invoke("error", new { message = authErrorMessage });
			return false;
		}

		var safeImages = images?.ToList() ?? new List<CodexUserImageInput>();
		if (string.IsNullOrWhiteSpace(normalizedText) && safeImages.Count == 0)
		{
			errorMessage = "Prompt text or at least one image is required.";
			return false;
		}

		ApplySessionTurnOverrides(
			session,
			normalizedModel,
			normalizedEffort,
			normalizedApprovalPolicy,
			normalizedSandboxPolicy,
			hasModelOverride,
			hasEffortOverride,
			hasApprovalOverride,
			hasSandboxOverride);

		var nextQueueItemId = Guid.NewGuid().ToString("N");
		session.EnqueueQueuedTurn(new QueuedTurn(
			QueueItemId: nextQueueItemId,
			Text: normalizedText,
			Cwd: normalizedCwd,
			Images: safeImages,
			CollaborationMode: normalizedCollaborationMode,
			CreatedAtUtc: DateTimeOffset.UtcNow));
		queueItemId = nextQueueItemId;

		var preview = BuildQueuedTurnPreview(normalizedText, safeImages.Count);
		session.Log.Write($"[queue] enqueued item={nextQueueItemId} text={preview}");
		Broadcast?.Invoke("status", new { sessionId, message = "Prompt queued." });
		SessionsChanged?.Invoke();
		EnsureQueueDispatcher(sessionId, session);
		return true;
	}

	private static void ApplySessionTurnOverrides(
		ManagedSession session,
		string? normalizedModel,
		string? normalizedEffort,
		string? normalizedApprovalPolicy,
		string? normalizedSandboxPolicy,
		bool hasModelOverride,
		bool hasEffortOverride,
		bool hasApprovalOverride,
		bool hasSandboxOverride)
	{
		if (hasModelOverride)
		{
			session.SetModel(normalizedModel);
		}
		if (hasEffortOverride)
		{
			session.SetReasoningEffort(normalizedEffort);
		}
		if (hasApprovalOverride)
		{
			session.SetApprovalPolicy(normalizedApprovalPolicy);
		}
		if (hasSandboxOverride)
		{
			session.SetSandboxPolicy(normalizedSandboxPolicy);
		}
	}

	public bool TryRemoveQueuedTurn(string sessionId, string queueItemId, out string? errorMessage)
	{
		errorMessage = null;
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			errorMessage = $"Unknown session: {sessionId}";
			return false;
		}

		var normalizedQueueItemId = queueItemId?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedQueueItemId))
		{
			errorMessage = "queueItemId is required.";
			return false;
		}

		if (!session.TryRemoveQueuedTurn(normalizedQueueItemId, out _))
		{
			errorMessage = $"Queued prompt not found: {normalizedQueueItemId}";
			return false;
		}

		session.Log.Write($"[queue] removed item={normalizedQueueItemId}");
		SessionsChanged?.Invoke();
		return true;
	}

	public bool TryPopQueuedTurnForEditing(
		string sessionId,
		string queueItemId,
		out QueuedTurnEditPayload? payload,
		out string? errorMessage)
	{
		payload = null;
		errorMessage = null;
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			errorMessage = $"Unknown session: {sessionId}";
			return false;
		}

		var normalizedQueueItemId = queueItemId?.Trim();
		if (string.IsNullOrWhiteSpace(normalizedQueueItemId))
		{
			errorMessage = "queueItemId is required.";
			return false;
		}

		if (!session.TryPopQueuedTurn(normalizedQueueItemId, out var queuedTurn) || queuedTurn is null)
		{
			errorMessage = $"Queued prompt not found: {normalizedQueueItemId}";
			return false;
		}

		payload = new QueuedTurnEditPayload(
			QueueItemId: queuedTurn.QueueItemId,
			Text: queuedTurn.Text,
			Images: queuedTurn.Images
				.Where(x => x is not null && !string.IsNullOrWhiteSpace(x.Url))
				.Select(x => new QueuedTurnImagePayload(x.Url))
				.ToArray());

		session.Log.Write($"[queue] popped item={normalizedQueueItemId} for edit");
		SessionsChanged?.Invoke();
		return true;
	}

	public async Task<SteerTurnResult> SteerTurnAsync(
		string sessionId,
		string normalizedText,
		IReadOnlyList<CodexUserImageInput>? images,
		CancellationToken cancellationToken)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return new SteerTurnResult(false, $"Unknown session: {sessionId}", TurnSubmitFallback.None);
		}

		if (TryGuardAgainstAuthAccountSwitch(sessionId, session, operation: "turn_steer", out var authErrorMessage))
		{
			return new SteerTurnResult(false, authErrorMessage, TurnSubmitFallback.None);
		}

		var safeImages = images?.ToList() ?? new List<CodexUserImageInput>();
		if (string.IsNullOrWhiteSpace(normalizedText) && safeImages.Count == 0)
		{
			return new SteerTurnResult(false, "Prompt text or at least one image is required.", TurnSubmitFallback.None);
		}

		if (!session.IsTurnInFlight)
		{
			return new SteerTurnResult(false, "No running turn is available to steer. Resend as a new message.", TurnSubmitFallback.StartTurn);
		}

		var expectedTurnId = session.ResolveActiveTurnId();
		if (string.IsNullOrWhiteSpace(expectedTurnId))
		{
			var fallback = session.IsTurnInFlightRecoveredFromLogs
				? TurnSubmitFallback.QueueTurn
				: TurnSubmitFallback.None;
			return new SteerTurnResult(false, "Unable to steer because the active turn id is unavailable. Prompt was not sent.", fallback);
		}

		try
		{
			await session.Session.SteerTurnAsync(expectedTurnId, normalizedText, safeImages, cancellationToken);
			session.Log.Write($"[turn_steer] expectedTurnId={expectedTurnId} text={BuildQueuedTurnPreview(normalizedText, safeImages.Count)}");
			Broadcast?.Invoke("status", new { sessionId, message = "Steer message sent to active turn." });
			return new SteerTurnResult(true, null, TurnSubmitFallback.None);
		}
		catch (Exception ex)
		{
			if (IsSteerPreconditionMismatch(ex, out var detailed))
			{
				var message = string.IsNullOrWhiteSpace(detailed)
					? "Steer was rejected because the active turn changed. Edit and resend your message."
					: $"Steer was rejected because the active turn changed ({detailed}). Edit and resend your message.";
				session.Log.Write($"[turn_steer] precondition mismatch expectedTurnId={expectedTurnId} detail={detailed ?? "(none)"}");
				return new SteerTurnResult(false, message, TurnSubmitFallback.QueueTurn);
			}

			var simplified = SimplifyRpcErrorMessage(ex.Message) ?? ex.Message;
			session.Log.Write($"[turn_steer] failed expectedTurnId={expectedTurnId} error={simplified}");
			return new SteerTurnResult(false, $"Failed to steer active turn: {simplified}", TurnSubmitFallback.None);
		}
	}

	private void LaunchTurnExecution(
		string sessionId,
		ManagedSession session,
		TurnExecutionRequest request,
		bool fromQueue)
	{
		_ = Task.Run(async () =>
		{
			try
			{
				await RunTurnExecutionAsync(sessionId, session, request, fromQueue);
			}
			catch
			{
			}
		}, CancellationToken.None);
	}

	private async Task<TurnExecutionOutcome> RunTurnExecutionAsync(
		string sessionId,
		ManagedSession session,
		TurnExecutionRequest request,
		bool fromQueue)
	{
		var effectiveCollaborationMode = request.CollaborationMode;
		var collaborationModeKind = WebCodexUtils.NormalizeCollaborationMode(effectiveCollaborationMode?.Mode);
		if (string.IsNullOrWhiteSpace(collaborationModeKind))
		{
			collaborationModeKind = "default";
			effectiveCollaborationMode = new CodexCollaborationMode
			{
				Mode = collaborationModeKind
			};
		}
		var isPlanTurn = string.Equals(collaborationModeKind, "plan", StringComparison.Ordinal);
		var dispatchId = Guid.NewGuid().ToString("N")[..10];
		var lockTaken = false;
		var completionPublished = false;
		CancellationTokenSource? timeoutCts = null;
		CancellationTokenSource? turnCts = null;

		try
		{
			WriteOrchestratorAudit(
				$"event=turn_send_dispatching sessionId={sessionId} threadId={session.Session.ThreadId} dispatchId={dispatchId} fromQueue={fromQueue} mode={collaborationModeKind} text={SummarizeTextForAudit(request.Text, request.Images?.Count ?? 0)}");
			if (TryGuardAgainstAuthAccountSwitch(sessionId, session, operation: fromQueue ? "turn_queue_dispatch" : "turn_dispatch", out var authErrorMessage))
			{
				Broadcast?.Invoke("error", new { message = authErrorMessage });
				return TurnExecutionOutcome.AccountMismatch;
			}
			var lockAcquired = await WaitForTurnSlotWithTimeoutAsync(sessionId, session);
			if (!lockAcquired)
			{
				var waitSeconds = _defaults.TurnSlotWaitTimeoutSeconds;
				_reviewStore.TryCompleteFromPromptText(
					request.Text,
					sessionId,
					session.Session.ThreadId,
					turnId: null,
					resultStatus: "queueTimedOut",
					assistantText: null);
				session.Log.Write($"[turn_gate] wait timed out after {waitSeconds}s");
				Broadcast?.Invoke(
					"turn_complete",
					new
					{
						sessionId,
						cwd = session.Cwd ?? request.Cwd ?? string.Empty,
						turnId = session.ResolveActiveTurnId(),
						status = "queueTimedOut",
						errorMessage = $"Timed out waiting {waitSeconds}s for previous turn to release.",
						isPlanTurn,
						collaborationMode = collaborationModeKind
					});
				Broadcast?.Invoke(
					"status",
					new
					{
						sessionId,
						message = $"Turn did not start because queue wait timed out ({waitSeconds}s)."
					});
				WriteOrchestratorAudit($"event=turn_send_queue_timeout sessionId={sessionId} dispatchId={dispatchId} waitSeconds={waitSeconds} fromQueue={fromQueue}");
				return TurnExecutionOutcome.QueueTimedOut;
			}

			lockTaken = true;

			timeoutCts = new CancellationTokenSource();
			timeoutCts.CancelAfter(TimeSpan.FromSeconds(_defaults.TurnTimeoutSeconds));
			turnCts = CancellationTokenSource.CreateLinkedTokenSource(session.LifetimeToken, timeoutCts.Token);
			var turnToken = turnCts.Token;
			if (session.TryMarkTurnStarted(turnCts, collaborationModeKind, dispatchId))
			{
				var activeTurnId = session.ResolveActiveTurnId();
				_reviewStore.TryMarkRunningFromPromptText(
					request.Text,
					sessionId,
					session.Session.ThreadId,
					activeTurnId);
				Broadcast?.Invoke("turn_started", new { sessionId, cwd = session.Cwd ?? request.Cwd ?? string.Empty, turnId = activeTurnId, isPlanTurn, collaborationMode = collaborationModeKind });
				SessionsChanged?.Invoke();
			}
			else
			{
				session.Log.Write($"[turn_state] suppressed duplicate turn_started emit dispatchId={dispatchId}");
			}
			session.Log.Write($"[turn_dispatch] dispatchId={dispatchId} start fromQueue={fromQueue} mode={collaborationModeKind}");

			if (fromQueue && !string.IsNullOrWhiteSpace(request.QueueItemId))
			{
				session.Log.Write($"[queue] dequeued item={request.QueueItemId}");
			}

			Broadcast?.Invoke("status", new { sessionId, message = "Turn started." });
			var effectiveModel = string.IsNullOrWhiteSpace(request.ModelOverride)
				? session.ResolveTurnModel(_defaults.DefaultModel)
				: request.ModelOverride;
			var effectiveEffort = string.IsNullOrWhiteSpace(request.ReasoningEffortOverride)
				? session.CurrentReasoningEffort
				: request.ReasoningEffortOverride;
			var effectiveApproval = string.IsNullOrWhiteSpace(request.ApprovalPolicyOverride)
				? session.CurrentApprovalPolicy
				: request.ApprovalPolicyOverride;
			var effectiveSandbox = string.IsNullOrWhiteSpace(request.SandboxPolicyOverride)
				? session.CurrentSandboxPolicy
				: request.SandboxPolicyOverride;
			var imageCount = request.Images?.Count ?? 0;
			session.Log.Write(
				$"[prompt] {(string.IsNullOrWhiteSpace(request.Text) ? "(no text)" : request.Text)} images={imageCount} cwd={request.Cwd ?? session.Cwd ?? "(default)"} model={effectiveModel ?? "(default)"} effort={effectiveEffort ?? "(default)"} approval={effectiveApproval ?? "(default)"} sandbox={effectiveSandbox ?? "(default)"} collaboration={collaborationModeKind ?? "(default)"}");
			Broadcast?.Invoke("assistant_response_started", new { sessionId });
			session.RememberRecoverableTurn(
				dispatchId,
				request.Text,
				request.Cwd,
				request.Images,
				request.CollaborationMode,
				effectiveModel,
				effectiveEffort,
				effectiveApproval,
				effectiveSandbox);

			var turnOptions = new CodexTurnOptions
			{
				Cwd = request.Cwd,
				Model = effectiveModel,
				ReasoningEffort = effectiveEffort,
				ApprovalPolicy = effectiveApproval,
				SandboxMode = effectiveSandbox,
				CollaborationMode = effectiveCollaborationMode
			};
			var turnRpcStopwatch = Stopwatch.StartNew();
			WriteOrchestratorAudit(
				$"event=turn_rpc_start sessionId={sessionId} threadId={session.Session.ThreadId} dispatchId={dispatchId} fromQueue={fromQueue} mode={collaborationModeKind} {session.BuildTurnDebugSummary()}");
			var result = await session.Session.SendMessageAsync(
				request.Text,
				images: request.Images,
				options: turnOptions,
				progress: null,
				cancellationToken: turnToken);
			turnRpcStopwatch.Stop();
			WriteOrchestratorAudit(
				$"event=turn_rpc_result sessionId={sessionId} threadId={session.Session.ThreadId} dispatchId={dispatchId} elapsedMs={turnRpcStopwatch.ElapsedMilliseconds} status={result.Status ?? "unknown"} hasError={!string.IsNullOrWhiteSpace(result.ErrorMessage)} {session.BuildTurnDebugSummary()}");

			Broadcast?.Invoke("assistant_done", new { sessionId, cwd = session.Cwd ?? request.Cwd ?? string.Empty, turnId = result.TurnId, text = result.Text });
			_reviewStore.TryCompleteFromPromptText(
				request.Text,
				sessionId,
				session.Session.ThreadId,
				result.TurnId,
				result.Status,
				result.Text);
			completionPublished = TryPublishTurnComplete(
				sessionId,
				session,
				result.Status,
				result.ErrorMessage,
				result.TurnId,
				result.Text);
			session.ClearRecoverableTurn(dispatchId);
			WriteOrchestratorAudit(
				$"event=turn_send_completed sessionId={sessionId} dispatchId={dispatchId} status={result.Status ?? "unknown"} hasError={!string.IsNullOrWhiteSpace(result.ErrorMessage)}");
		}
		catch (OperationCanceledException)
		{
			var timedOut = timeoutCts?.IsCancellationRequested == true;
			var lifetimeCanceled = session.LifetimeToken.IsCancellationRequested;
			var staleStartCanceled =
				!timedOut &&
				!lifetimeCanceled &&
				session.TryMarkRecoverableTurnStaleStartCanceled(dispatchId, out _);
			WriteOrchestratorAudit(
				$"event=turn_rpc_canceled sessionId={sessionId} threadId={session.Session.ThreadId} dispatchId={dispatchId} timeout={timedOut} lifetimeCanceled={lifetimeCanceled} staleStartCanceled={staleStartCanceled} {session.BuildTurnDebugSummary()} {session.BuildRpcDebugSummary()}");
			WriteOrchestratorAudit(
				$"event=turn_send_operation_canceled sessionId={sessionId} dispatchId={dispatchId} lifetimeCanceled={lifetimeCanceled}");
			session.Log.Write(
				$"[turn_dispatch] dispatchId={dispatchId} canceled timeout={timedOut} lifetimeCanceled={lifetimeCanceled} staleStartCanceled={staleStartCanceled}");
			if (lifetimeCanceled && !lockTaken)
			{
				return TurnExecutionOutcome.CanceledByLifetime;
			}

			if (timedOut)
			{
				_reviewStore.TryCompleteFromPromptText(
					request.Text,
					sessionId,
					session.Session.ThreadId,
					turnId: session.ResolveActiveTurnId(),
					resultStatus: "timedOut",
					assistantText: null);
				completionPublished = TryPublishTurnComplete(
					sessionId,
					session,
					status: "timedOut",
					errorMessage: "Timed out.",
					turnId: session.ResolveActiveTurnId());
			}
			else
			{
				_reviewStore.TryCompleteFromPromptText(
					request.Text,
					sessionId,
					session.Session.ThreadId,
					turnId: session.ResolveActiveTurnId(),
					resultStatus: "interrupted",
					assistantText: null);
				completionPublished = TryPublishTurnComplete(
					sessionId,
					session,
					status: "interrupted",
					errorMessage: staleStartCanceled
						? "Turn start did not acknowledge before recovery."
						: "Turn canceled.",
					turnId: session.ResolveActiveTurnId());
			}

			if (!completionPublished && staleStartCanceled)
			{
				var fallbackReset = session.ForceResetTurnState(clearQueuedTurns: false, preserveRecoverableTurn: true);
				Broadcast?.Invoke(
					"turn_complete",
					new
					{
						sessionId,
						cwd = session.Cwd ?? request.Cwd ?? string.Empty,
						turnId = session.ResolveActiveTurnId(),
						status = "interrupted",
						errorMessage = "Turn start did not acknowledge before recovery.",
						isPlanTurn,
						collaborationMode = collaborationModeKind
					});
				WriteOrchestratorAudit(
					$"event=turn_completion_fallback_published sessionId={sessionId} dispatchId={dispatchId} reason=stale_turn_start_cancel hadTurnInFlight={fallbackReset.HadTurnInFlight}");
				completionPublished = true;
			}

			if (!staleStartCanceled)
			{
				session.ClearRecoverableTurn(dispatchId);
			}
			WriteOrchestratorAudit(
				$"event=turn_send_canceled sessionId={sessionId} dispatchId={dispatchId} timeout={timedOut} staleStartCanceled={staleStartCanceled}");
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			session.Log.Write($"[turn_error] {ex.Message}");
			WriteOrchestratorAudit(
				$"event=turn_rpc_failed sessionId={sessionId} threadId={session.Session.ThreadId} dispatchId={dispatchId} error={ex.Message} {session.BuildTurnDebugSummary()}");
			WriteOrchestratorAudit($"event=turn_send_failed sessionId={sessionId} dispatchId={dispatchId} error={ex.Message}");
			_reviewStore.TryCompleteFromPromptText(
				request.Text,
				sessionId,
				session.Session.ThreadId,
				turnId: session.ResolveActiveTurnId(),
				resultStatus: "failed",
				assistantText: null);
			completionPublished = TryPublishTurnComplete(
				sessionId,
				session,
				status: "failed",
				errorMessage: ex.Message,
				turnId: session.ResolveActiveTurnId());
			session.ClearRecoverableTurn(dispatchId);
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

			if (fromQueue)
			{
				EnsureQueueDispatcher(sessionId, session);
			}
		}

		return TurnExecutionOutcome.Finished;
	}

	private static string BuildQueuedTurnPreview(string text, int imageCount)
	{
		var normalized = (text ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
		if (normalized.Length > 90)
		{
			normalized = normalized[..90] + "...";
		}

		if (string.IsNullOrWhiteSpace(normalized))
		{
			normalized = imageCount > 0 ? "(image only)" : "(empty)";
		}

		return normalized;
	}

	public async Task<(bool InterruptSent, bool LocalCanceled, string? Error)> CancelTurnAsync(string sessionId, CancellationToken cancellationToken)
	{
		var session = TryGetSession(sessionId);
		if (session is null)
		{
			WriteOrchestratorAudit($"event=turn_cancel_rejected sessionId={sessionId} reason=unknown_session");
			Broadcast?.Invoke("error", new { message = $"Unknown session: {sessionId}" });
			return (false, false, "Unknown session.");
		}

		var activeMode = session.GetActiveCollaborationMode();
		var isPlanTurn = string.Equals(activeMode, "plan", StringComparison.Ordinal);
		var hadTurnInFlightAtRequest = session.IsTurnInFlight;
		WriteOrchestratorAudit(
			$"event=turn_cancel_requested sessionId={sessionId} hadTurnInFlight={hadTurnInFlightAtRequest} queuedTurns={session.GetQueuedTurnsSnapshot().Count}");
		var interruptSent = false;
		string? fallbackReason = null;
		var forcedResetApplied = false;
		var clearedQueuedTurnCount = 0;

		// Apply local reset first so cancel always unblocks the UI/session even if interrupt hangs.
		var localCanceled = session.CancelActiveTurn();
		var forcedResetResult = session.ForceResetTurnState(clearQueuedTurns: true);
		forcedResetApplied = forcedResetResult.HadTurnInFlight;
		clearedQueuedTurnCount = forcedResetResult.ClearedQueuedTurnCount;
		localCanceled = localCanceled || forcedResetResult.HadActiveTurnToken || forcedResetResult.HadTurnInFlight;

		if (hadTurnInFlightAtRequest)
		{
			try
			{
				using var interruptCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
				interruptCts.CancelAfter(TimeSpan.FromSeconds(2));
				interruptSent = await session.Session.InterruptTurnAsync(waitForTurnStart: TimeSpan.FromSeconds(2), interruptCts.Token);
			}
			catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
			{
				fallbackReason = "interrupt timeout";
			}
			catch (Exception ex)
			{
				Logs.LogError(ex);
				fallbackReason = ex.Message;
			}
		}

		if (!interruptSent && !localCanceled && clearedQueuedTurnCount == 0)
		{
			WriteOrchestratorAudit($"event=turn_cancel_noop sessionId={sessionId}");
			Broadcast?.Invoke("status", new { sessionId, message = "No running turn to cancel." });
			return (false, false, fallbackReason);
		}

		if (forcedResetApplied)
		{
			var resetMessage = clearedQueuedTurnCount > 0
				? $"Canceled in-flight turn and cleared {clearedQueuedTurnCount} queued prompt(s)."
				: "Canceled in-flight turn via forced local clear.";
			Broadcast?.Invoke(
				"turn_complete",
				new
				{
					sessionId,
					status = "interrupted",
					errorMessage = resetMessage,
					isPlanTurn,
					collaborationMode = activeMode
				});
		}

		if (interruptSent)
		{
			session.Log.Write("[turn_cancel] requested by user; sent turn/interrupt and force-reset local state");
		}
		else if (forcedResetApplied)
		{
			session.Log.Write("[turn_cancel] requested by user; forced clear of in-flight turn state");
		}
		else
		{
			session.Log.Write($"[turn_cancel] requested by user; fallback local clear ({fallbackReason ?? "no details"})");
		}

		Broadcast?.Invoke(
			"turn_cancel_requested",
			new
			{
				sessionId,
				interruptSent,
				hadTurnInFlight = hadTurnInFlightAtRequest,
				forcedReset = forcedResetApplied,
				clearedQueuedTurnCount
			});
		Broadcast?.Invoke(
			"status",
			new
			{
				sessionId,
				message = forcedResetApplied
					? clearedQueuedTurnCount > 0
						? $"Cancel override applied. Cleared {clearedQueuedTurnCount} queued prompt(s)."
						: "Cancel override applied."
					: clearedQueuedTurnCount > 0
						? $"Cleared {clearedQueuedTurnCount} queued prompt(s)."
						: "Cancel requested."
			});
		SessionsChanged?.Invoke();
		if (session.HasQueuedTurns())
		{
			EnsureQueueDispatcher(sessionId, session);
		}
		WriteOrchestratorAudit(
			$"event=turn_cancel_completed sessionId={sessionId} interruptSent={interruptSent} localCanceled={localCanceled} forcedReset={forcedResetApplied} clearedQueuedTurns={clearedQueuedTurnCount} fallback={fallbackReason ?? "(none)"}");

		return (interruptSent, localCanceled, fallbackReason);
	}

	public bool TryResetThreadSession(string sessionId, out string? errorMessage)
	{
		errorMessage = null;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			errorMessage = "sessionId is required.";
			return false;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			errorMessage = $"Unknown session: {sessionId}";
			return false;
		}

		if (!session.TryBeginAppServerRecovery())
		{
			errorMessage = "Session is already recovering.";
			return false;
		}

		var mode = session.GetActiveCollaborationMode();
		var isPlanTurn = string.Equals(mode, "plan", StringComparison.Ordinal);
		var reset = session.ForceResetTurnState(clearQueuedTurns: false, preserveRecoverableTurn: true);
		if (reset.HadTurnInFlight)
		{
			Broadcast?.Invoke(
				"turn_complete",
				new
				{
					sessionId,
					cwd = session.Cwd ?? string.Empty,
					status = "interrupted",
					errorMessage = "Turn was interrupted by a manual thread reset.",
					isPlanTurn,
					collaborationMode = mode
				});
		}

		session.Log.Write("[session_recovery] manual thread reset requested");
		Broadcast?.Invoke(
			"session_recovery_state",
			new
			{
				sessionId,
				state = "recovering",
				reason = "manual_reset",
				pendingSeconds = 0
			});
		Broadcast?.Invoke("status", new { sessionId, message = "Manual thread reset requested. Restarting app-server session." });
		SessionsChanged?.Invoke();

		_ = Task.Run(() => RecoverSessionAfterStaleTurnStartAsync(sessionId, session, TimeSpan.Zero), CancellationToken.None);
		return true;
	}

	public Task StopSessionAsync(string sessionId, CancellationToken cancellationToken)
	{
		_ = cancellationToken;
		if (!TryRemoveSession(sessionId, out var session) || session is null)
		{
			WriteOrchestratorAudit($"event=session_stop_noop sessionId={sessionId}");
			return Task.CompletedTask;
		}
		WriteOrchestratorAudit($"event=session_stop_requested sessionId={sessionId} threadId={session.Session.ThreadId}");

		var stopMode = session.GetActiveCollaborationMode();
		var stopIsPlanTurn = string.Equals(stopMode, "plan", StringComparison.Ordinal);
		var stopReset = session.ForceResetTurnState(clearQueuedTurns: true);
		session.CancelLifetime();

		if (stopReset.HadTurnInFlight)
		{
			Broadcast?.Invoke(
				"turn_complete",
				new
				{
					sessionId,
					cwd = session.Cwd ?? string.Empty,
					status = "interrupted",
					errorMessage = "Session stopped while a turn was in flight.",
					isPlanTurn = stopIsPlanTurn,
					collaborationMode = stopMode
				});
		}

		SessionsChanged?.Invoke();
		Broadcast?.Invoke(
			"session_stopped",
			new
			{
				sessionId,
				message = "Session stopped.",
				clearedQueuedTurnCount = stopReset.ClearedQueuedTurnCount
			});
		WriteOrchestratorAudit(
			$"event=session_stop_completed sessionId={sessionId} clearedQueuedTurns={stopReset.ClearedQueuedTurnCount} hadTurnInFlight={stopReset.HadTurnInFlight}");

		_ = Task.Run(async () =>
		{
			try
			{
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
		});

		return Task.CompletedTask;
	}

	private void EnsureQueueDispatcher(string sessionId, ManagedSession session)
	{
		if (!session.TryMarkQueueDispatchStarted())
		{
			return;
		}

		_ = Task.Run(async () =>
		{
			try
			{
				await RunQueueDispatcherAsync(sessionId, session);
			}
			catch
			{
			}
			finally
			{
				session.MarkQueueDispatchStopped();
				if (!session.LifetimeToken.IsCancellationRequested && session.HasQueuedTurns())
				{
					EnsureQueueDispatcher(sessionId, session);
				}
			}
		}, CancellationToken.None);
	}

	private async Task RunQueueDispatcherAsync(string sessionId, ManagedSession session)
	{
		while (!session.LifetimeToken.IsCancellationRequested)
		{
			if (session.IsAppServerRecovering)
			{
				await Task.Delay(250, session.LifetimeToken);
				continue;
			}

			if (session.IsTurnInFlight)
			{
				await Task.Delay(200, session.LifetimeToken);
				continue;
			}

			if (!session.TryPopNextQueuedTurn(out var queuedTurn) || queuedTurn is null)
			{
				return;
			}

			SessionsChanged?.Invoke();

			var request = new TurnExecutionRequest(
				Text: queuedTurn.Text,
				Cwd: queuedTurn.Cwd,
				Images: queuedTurn.Images,
				CollaborationMode: queuedTurn.CollaborationMode,
				QueueItemId: queuedTurn.QueueItemId);

			var outcome = await RunTurnExecutionAsync(sessionId, session, request, fromQueue: true);
			if (outcome == TurnExecutionOutcome.QueueTimedOut)
			{
				session.RequeueQueuedTurnFront(queuedTurn);
				SessionsChanged?.Invoke();
				return;
			}
			if (outcome == TurnExecutionOutcome.AccountMismatch)
			{
				session.RequeueQueuedTurnFront(queuedTurn);
				SessionsChanged?.Invoke();
				return;
			}
		}
	}

	private static bool IsSteerPreconditionMismatch(Exception ex, out string? detail)
	{
		detail = SimplifyRpcErrorMessage(ex.Message);
		var inspect = (detail ?? ex.Message ?? string.Empty).ToLowerInvariant();
		if (string.IsNullOrWhiteSpace(inspect))
		{
			return false;
		}

		return inspect.Contains("expectedturnid", StringComparison.Ordinal) ||
			inspect.Contains("precondition", StringComparison.Ordinal) ||
			(inspect.Contains("active turn", StringComparison.Ordinal) &&
				inspect.Contains("match", StringComparison.Ordinal));
	}

	private static string? SimplifyRpcErrorMessage(string? message)
	{
		if (string.IsNullOrWhiteSpace(message))
		{
			return null;
		}

		var trimmed = message.Trim();
		if (!trimmed.StartsWith("{", StringComparison.Ordinal))
		{
			return trimmed;
		}

		try
		{
			using var doc = JsonDocument.Parse(trimmed);
			var root = doc.RootElement;
			var errorMessage =
				WebCodexUtils.TryGetPathString(root, "message")
				?? WebCodexUtils.TryGetPathString(root, "error", "message")
				?? WebCodexUtils.TryGetPathString(root, "data", "message")
				?? WebCodexUtils.TryGetPathString(root, "error", "data", "message");
			return string.IsNullOrWhiteSpace(errorMessage) ? trimmed : errorMessage.Trim();
		}
		catch
		{
			return trimmed;
		}
	}

	private async Task<object?> HandleServerRequestAsync(
		string sessionId,
		LocalLogWriter log,
		ConcurrentDictionary<string, TaskCompletionSource<string>> approvals,
		ConcurrentDictionary<string, TaskCompletionSource<Dictionary<string, object?>>> pendingToolUserInputs,
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
			case "item/tool/request_user_input":
			{
				var requestId = Guid.NewGuid().ToString("N");
				var tcs = new TaskCompletionSource<Dictionary<string, object?>>(TaskCreationOptions.RunContinuationsAsynchronously);
				pendingToolUserInputs[requestId] = tcs;
				var questions = ParseToolUserInputQuestions(req.Params);
				log.Write($"[tool_user_input_request] session={sessionId} requestId={requestId} questions={questions.Count}");
				Broadcast?.Invoke("tool_user_input_request", new
				{
					sessionId,
					requestId,
					questions
				});
				SessionsChanged?.Invoke();
				try
				{
					var answers = await tcs.Task.WaitAsync(cancellationToken);
					log.Write($"[tool_user_input_response] session={sessionId} requestId={requestId} answers={answers.Count}");
					return new { answers };
				}
				catch (OperationCanceledException)
				{
					return new { answers = new Dictionary<string, object?>() };
				}
				finally
				{
					pendingToolUserInputs.TryRemove(requestId, out _);
					Broadcast?.Invoke("tool_user_input_resolved", new { sessionId, requestId });
					SessionsChanged?.Invoke();
				}
			}
			case "account/chatgptAuthTokens/refresh":
			{
				var authState = CodexAuthStateReader.Read(_defaults.CodexHomePath);
				if (!authState.HasRefreshTokenPayload)
				{
					log.Write($"[auth_refresh] session={sessionId} unavailable account={MaskAccountId(authState.AccountId)}");
					return new { };
				}

				log.Write($"[auth_refresh] session={sessionId} account={MaskAccountId(authState.AccountId)}");
				return new
				{
					accessToken = authState.AccessToken,
					chatgptAccountId = authState.AccountId,
					chatgptPlanType = authState.ChatGptPlanType
				};
			}
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

	private static string MaskAccountId(string? accountId)
	{
		if (string.IsNullOrWhiteSpace(accountId))
		{
			return "(none)";
		}

		var trimmed = accountId.Trim();
		if (trimmed.Length <= 8)
		{
			return trimmed;
		}

		return $"{trimmed[..8]}...";
	}

	private static string NormalizeAuthIdentityKey(string? identityKey)
	{
		var normalized = identityKey?.Trim() ?? string.Empty;
		return string.IsNullOrWhiteSpace(normalized) ? string.Empty : normalized;
	}

	private static string NormalizeAuthLabel(string? label)
	{
		var normalized = label?.Trim() ?? string.Empty;
		return string.IsNullOrWhiteSpace(normalized) ? "unavailable" : normalized;
	}

	private bool TryGuardAgainstAuthAccountSwitch(string sessionId, ManagedSession session, string operation, out string errorMessage)
	{
		errorMessage = string.Empty;
		var startupKey = NormalizeAuthIdentityKey(session.StartupAuthIdentityKey);
		if (string.IsNullOrWhiteSpace(startupKey))
		{
			return false;
		}

		var currentAuthState = CodexAuthStateReader.Read(_defaults.CodexHomePath);
		var currentKey = NormalizeAuthIdentityKey(currentAuthState.IdentityKey);
		if (string.IsNullOrWhiteSpace(currentKey) || string.Equals(startupKey, currentKey, StringComparison.Ordinal))
		{
			return false;
		}

		var startedLabel = NormalizeAuthLabel(session.StartupAuthLabel);
		var currentLabel = NormalizeAuthLabel(currentAuthState.DisplayLabel);
		errorMessage = $"Codex account changed for this running session ({startedLabel} -> {currentLabel}). Stop and re-attach this thread, or create a new session.";
		session.Log.Write($"[auth_guard] operation={operation} startedAccount={startedLabel} currentAccount={currentLabel}");
		WriteOrchestratorAudit(
			$"event=auth_account_switched sessionId={sessionId} threadId={session.Session.ThreadId} operation={operation} started={NormalizeAuditValue(startedLabel, 80)} current={NormalizeAuditValue(currentLabel, 80)}");

		var shouldBroadcast = session.ShouldBroadcastCoreIssue("auth.account_switched", TimeSpan.FromSeconds(15));
		if (shouldBroadcast)
		{
			Broadcast?.Invoke(
				"appserver_error",
				new
				{
					sessionId,
					code = "auth.account_switched",
					severity = "error",
					message = "Codex account switched after this session started.",
					detail = $"Started account: {startedLabel}. Current account: {currentLabel}.",
					recommendedAction = "Stop and re-attach this session so it runs under the new account.",
					isAuthError = true,
					isTransient = false,
					eventType = "auth/account_switched",
					occurredAtUtc = DateTimeOffset.UtcNow.ToString("O")
				});
		}

		return true;
	}

	private void HandleCoreEvent(string sessionId, LocalLogWriter sessionLog, CodexCoreEvent ev)
	{
		sessionLog.Write(CodexEventLogging.Format(ev, includeTimestamp: false));
		var managedSession = TryGetSession(sessionId);
		managedSession?.MarkCoreEventObserved(ev.Type, ev.Message);

		if (TryClassifyCoreIssue(ev, out var issue))
		{
			var shouldBroadcast = managedSession?.ShouldBroadcastCoreIssue(issue.DedupeKey, TimeSpan.FromSeconds(20)) ?? true;
			WriteOrchestratorAudit(
				$"event=core_issue_detected sessionId={sessionId} code={issue.Code} severity={issue.Severity} type={ev.Type} detail={NormalizeAuditValue(issue.Detail, 180)}");
			if (shouldBroadcast)
			{
				Broadcast?.Invoke(
					"appserver_error",
					new
					{
						sessionId,
						code = issue.Code,
						severity = issue.Severity,
						message = issue.UserMessage,
						detail = issue.Detail,
						recommendedAction = issue.RecommendedAction,
						isAuthError = issue.IsAuthError,
						isTransient = issue.IsTransient,
						eventType = ev.Type,
						occurredAtUtc = DateTimeOffset.UtcNow.ToString("O")
					});
			}
		}

		if (string.Equals(ev.Type, "rpc_wait_canceled", StringComparison.Ordinal) ||
			string.Equals(ev.Type, "rpc_wait_failed", StringComparison.Ordinal) ||
			string.Equals(ev.Type, "rpc_response_unmatched", StringComparison.Ordinal))
		{
			var rpcDebug = managedSession is null ? string.Empty : $" {managedSession.BuildRpcDebugSummary()}";
			WriteOrchestratorAudit($"event=core_rpc_warning sessionId={sessionId} type={ev.Type} message={ev.Message ?? "(none)"}{rpcDebug}");

			if (string.Equals(ev.Type, "rpc_wait_failed", StringComparison.Ordinal))
			{
				TryOfferRecoveryForRpcWaitFailure(sessionId, managedSession, ev);
			}
		}

		if (IsCoreTransportPumpFailure(ev))
		{
			WriteOrchestratorAudit($"event=core_transport_failure sessionId={sessionId} type={ev.Type} message={ev.Message ?? "(none)"}");
			if (managedSession is not null && managedSession.IsTurnInFlight)
			{
				var errorMessage = string.IsNullOrWhiteSpace(ev.Message)
					? "Core transport pump failed while a turn was active."
					: $"Core transport pump failed while a turn was active: {ev.Message}";
				if (TryPublishTurnComplete(sessionId, managedSession, status: "interrupted", errorMessage: errorMessage))
				{
					sessionLog.Write($"[turn_recovery] closed in-flight turn after core transport failure ({ev.Type})");
					WriteOrchestratorAudit($"event=turn_recovery_after_transport_failure sessionId={sessionId} type={ev.Type}");
					Broadcast?.Invoke(
						"status",
						new
						{
							sessionId,
							message = "Core transport failed; in-flight turn was reset for recovery."
						});
				}
			}
		}

		if (TryParseCoreTurnSignal(ev, out var signal))
		{
			Logs.DebugLog.WriteEvent(
				"Audit.Core",
				$"event=turn_signal sessionId={sessionId} kind={signal.Kind} status={signal.Status ?? "(none)"} source={signal.Source} turnId={signal.TurnId ?? "(none)"}");
			var managed = TryGetSession(sessionId);
			if (managed is not null)
			{
				if (signal.Kind == CoreTurnSignalKind.Started)
				{
					if (!string.IsNullOrWhiteSpace(signal.TurnId) &&
						managed.TryMarkTurnStartedFromCoreSignal(signal.TurnId))
					{
						sessionLog.Write($"[turn_recovery] marked started from core signal ({signal.Source})");
						WriteOrchestratorAudit($"event=turn_started_from_core_signal sessionId={sessionId} source={signal.Source} turnId={signal.TurnId ?? "(none)"}");
						_reviewStore.TryBindTurnToNextActiveReview(sessionId, managed.Session.ThreadId, signal.TurnId);
						var collaborationMode = managed.GetActiveCollaborationMode();
						Broadcast?.Invoke(
							"turn_started",
							new
							{
								sessionId,
								turnId = signal.TurnId,
								isPlanTurn = string.Equals(collaborationMode, "plan", StringComparison.Ordinal),
								collaborationMode
							});
						SessionsChanged?.Invoke();
					}
				}
				else if (TryPublishTurnComplete(
					sessionId,
					managed,
					signal.Status ?? "completed",
					signal.ErrorMessage,
					signal.TurnId))
				{
					sessionLog.Write($"[turn_recovery] marked complete from core signal ({signal.Source})");
					WriteOrchestratorAudit(
						$"event=turn_completed_from_core_signal sessionId={sessionId} source={signal.Source} status={signal.Status ?? "completed"} hasError={!string.IsNullOrWhiteSpace(signal.ErrorMessage)}");
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

		if (TryParseCorePlanSignal(ev, out var planSignal))
		{
			var managed = TryGetSession(sessionId);
			if (managed is not null)
			{
				HandlePlanSignal(sessionId, managed, planSignal);
			}
		}

		CoreEvent?.Invoke(sessionId, ev);
	}

	private bool TryOfferRecoveryForRpcWaitFailure(string sessionId, ManagedSession? managedSession, CodexCoreEvent ev)
	{
		if (managedSession is null || managedSession.IsAppServerRecovering || !managedSession.IsTurnInFlight)
		{
			return false;
		}

		var coreMessage = NormalizeCoreIssueMessage(ev.Message, maxLength: 180);
		var message = string.IsNullOrWhiteSpace(coreMessage)
			? "RPC wait failed while a turn was active. Codex may be disconnected."
			: $"RPC wait failed while a turn was active ({coreMessage}). Codex may be disconnected.";

		return TryCreateRecoveryOfferForStaleTurn(
			sessionId,
			managedSession,
			reason: "rpc_wait_failed",
			message: message,
			pendingAge: TimeSpan.Zero,
			detectedEventName: "rpc_wait_failed_recovery_offer");
	}

	private static bool IsCoreTransportPumpFailure(CodexCoreEvent ev)
	{
		if (ev is null || string.IsNullOrWhiteSpace(ev.Type))
		{
			return false;
		}

		return string.Equals(ev.Type, "stdout_pump_failed", StringComparison.Ordinal) ||
			string.Equals(ev.Type, "stderr_pump_failed", StringComparison.Ordinal);
	}

	private static bool TryClassifyCoreIssue(CodexCoreEvent ev, out CoreIssueSignal issue)
	{
		issue = default!;
		if (ev is null)
		{
			return false;
		}

		var level = (ev.Level ?? string.Empty).Trim();
		var type = (ev.Type ?? string.Empty).Trim();
		var message = NormalizeCoreIssueMessage(ev.Message, maxLength: 320);

		if (ContainsIgnoreCase(message, "refresh token was already used") ||
			ContainsIgnoreCase(message, "please log out and sign in again"))
		{
			issue = new CoreIssueSignal(
				Code: "auth.refresh_token_reused",
				Severity: "error",
				UserMessage: "Codex authentication failed because the refresh token was already used.",
				Detail: message,
				RecommendedAction: "Run 'codex logout', then 'codex login', then retry the turn.",
				IsAuthError: true,
				IsTransient: false);
			return true;
		}

		if (ContainsIgnoreCase(message, "failed to refresh token") ||
			(ContainsIgnoreCase(message, "401 unauthorized") && ContainsIgnoreCase(message, "auth")))
		{
			issue = new CoreIssueSignal(
				Code: "auth.refresh_failed",
				Severity: "error",
				UserMessage: "Codex authentication refresh failed.",
				Detail: message,
				RecommendedAction: "Re-authenticate with 'codex logout' and 'codex login', then retry.",
				IsAuthError: true,
				IsTransient: false);
			return true;
		}

		if (IsCoreTransportPumpFailure(ev))
		{
			issue = new CoreIssueSignal(
				Code: "core.transport_failed",
				Severity: "error",
				UserMessage: "Codex app-server transport failed while processing events.",
				Detail: string.IsNullOrWhiteSpace(message) ? type : message,
				RecommendedAction: "Retry the turn. If this repeats, restart the affected session.",
				IsAuthError: false,
				IsTransient: true);
			return true;
		}

		if (string.Equals(type, "rpc_wait_failed", StringComparison.Ordinal))
		{
			issue = new CoreIssueSignal(
				Code: "core.rpc_wait_failed",
				Severity: "warn",
				UserMessage: "Codex app-server reported an RPC wait failure.",
				Detail: string.IsNullOrWhiteSpace(message) ? type : message,
				RecommendedAction: "Retry the action. If failures persist, restart the session.",
				IsAuthError: false,
				IsTransient: true);
			return true;
		}

		if (string.Equals(level, "error", StringComparison.OrdinalIgnoreCase))
		{
			issue = new CoreIssueSignal(
				Code: string.IsNullOrWhiteSpace(type) ? "core.error" : $"core.{type}",
				Severity: "error",
				UserMessage: "Codex app-server reported an error.",
				Detail: string.IsNullOrWhiteSpace(message) ? type : message,
				RecommendedAction: "Open logs for details. Retry the turn or restart the session if needed.",
				IsAuthError: false,
				IsTransient: false);
			return true;
		}

		return false;
	}

	private static string NormalizeCoreIssueMessage(string? message, int maxLength)
	{
		if (string.IsNullOrWhiteSpace(message))
		{
			return string.Empty;
		}

		var normalized = message
			.Replace("\u001b", string.Empty, StringComparison.Ordinal)
			.Replace('\r', ' ')
			.Replace('\n', ' ')
			.Trim();
		if (normalized.Length > maxLength)
		{
			normalized = normalized[..maxLength] + "...";
		}

		return normalized;
	}

	private static bool ContainsIgnoreCase(string value, string needle)
	{
		if (string.IsNullOrWhiteSpace(value) || string.IsNullOrWhiteSpace(needle))
		{
			return false;
		}

		return value.Contains(needle, StringComparison.OrdinalIgnoreCase);
	}

	private static string NormalizeAuditValue(string? value, int maxLength)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return "(none)";
		}

		var normalized = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
		if (normalized.Length > maxLength)
		{
			normalized = normalized[..maxLength] + "...";
		}

		return normalized.Replace(' ', '_');
	}

	private bool TryPublishTurnComplete(
		string sessionId,
		ManagedSession session,
		string? status,
		string? errorMessage,
		string? turnId = null,
		string? assistantText = null)
	{
		var collaborationMode = session.GetActiveCollaborationMode();
		var isPlanTurn = string.Equals(collaborationMode, "plan", StringComparison.Ordinal);
		if (!session.TryMarkTurnCompletedFromCoreSignal())
		{
			return false;
		}

		var normalizedStatus = string.IsNullOrWhiteSpace(status) ? "unknown" : status!;
		var effectiveTurnId = string.IsNullOrWhiteSpace(turnId) ? session.ResolveActiveTurnId() : turnId;
		_reviewStore.TryCompleteByTurn(sessionId, session.Session.ThreadId, effectiveTurnId, normalizedStatus, assistantText);
		Broadcast?.Invoke("turn_complete", new { sessionId, cwd = session.Cwd ?? string.Empty, turnId = effectiveTurnId, status = normalizedStatus, errorMessage, isPlanTurn, collaborationMode });
		WriteOrchestratorAudit(
			$"event=turn_completion_published sessionId={sessionId} status={normalizedStatus} hasError={!string.IsNullOrWhiteSpace(errorMessage)}");
		SessionsChanged?.Invoke();
		EnsureQueueDispatcher(sessionId, session);
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

	private void HandlePlanSignal(string sessionId, ManagedSession managed, CorePlanSignal signal)
	{
		if (!string.IsNullOrWhiteSpace(signal.CollaborationMode))
		{
			managed.TrySetActiveCollaborationModeIfInFlight(signal.CollaborationMode);
		}
		else
		{
			managed.TrySetActiveCollaborationModeIfInFlight("plan");
		}

		if (signal.Kind == CorePlanSignalKind.Delta)
		{
			if (string.IsNullOrWhiteSpace(signal.Text))
			{
				return;
			}

			Broadcast?.Invoke(
				"plan_delta",
				new
				{
					sessionId,
					text = signal.Text,
					source = signal.Source,
					collaborationMode = "plan",
					isPlanTurn = true
				});
			return;
		}

		Broadcast?.Invoke(
			"plan_updated",
			new
			{
				sessionId,
				text = signal.Text,
				source = signal.Source,
				collaborationMode = "plan",
				isPlanTurn = true
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
		ManagedSession? loadedSession = null;
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

		if (signal is null)
		{
			return;
		}

		loadedSession = TryGetSession(sessionId);
		if (loadedSession is null)
		{
			return;
		}

		var snapshot = new SessionRateLimitSnapshot(
			SessionId: sessionId,
			ThreadId: loadedSession.Session.ThreadId,
			Scope: signal.Scope,
			Remaining: signal.Remaining,
			Limit: signal.Limit,
			Used: signal.Used,
			RetryAfterSeconds: signal.RetryAfterSeconds,
			ResetAtUtc: signal.ResetAtUtc,
			Primary: signal.Primary is null
				? null
				: new SessionRateLimitWindowSnapshot(
					UsedPercent: signal.Primary.UsedPercent,
					RemainingPercent: signal.Primary.RemainingPercent,
					WindowMinutes: signal.Primary.WindowMinutes,
					ResetsAtUtc: signal.Primary.ResetsAtUtc),
			Secondary: signal.Secondary is null
				? null
				: new SessionRateLimitWindowSnapshot(
					UsedPercent: signal.Secondary.UsedPercent,
					RemainingPercent: signal.Secondary.RemainingPercent,
					WindowMinutes: signal.Secondary.WindowMinutes,
					ResetsAtUtc: signal.Secondary.ResetsAtUtc),
			PlanType: signal.PlanType,
			HasCredits: signal.HasCredits,
			UnlimitedCredits: signal.UnlimitedCredits,
			CreditBalance: signal.CreditBalance,
			Summary: signal.Summary,
			Source: signal.Source,
			UpdatedAtUtc: DateTimeOffset.UtcNow);
		loadedSession.SetLatestRateLimitSnapshot(snapshot);

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
				primary = signal.Primary is null
					? null
					: new
					{
						usedPercent = signal.Primary.UsedPercent,
						remainingPercent = signal.Primary.RemainingPercent,
						windowMinutes = signal.Primary.WindowMinutes,
						resetsAtUtc = signal.Primary.ResetsAtUtc?.ToString("O")
					},
				secondary = signal.Secondary is null
					? null
					: new
					{
						usedPercent = signal.Secondary.UsedPercent,
						remainingPercent = signal.Secondary.RemainingPercent,
						windowMinutes = signal.Secondary.WindowMinutes,
						resetsAtUtc = signal.Secondary.ResetsAtUtc?.ToString("O")
					},
				planType = signal.PlanType,
				credits = new
				{
					hasCredits = signal.HasCredits,
					unlimited = signal.UnlimitedCredits,
					balance = signal.CreditBalance
				},
				summary = signal.Summary,
				source = signal.Source
			});
	}

	private static bool TryOpenStdoutJsonlDocument(
		CodexCoreEvent ev,
		Func<string, bool>? shouldParseLine,
		out JsonDocument? document,
		out JsonElement root)
	{
		document = null;
		root = default;
		if (ev is null || !string.Equals(ev.Type, "stdout_jsonl", StringComparison.Ordinal))
		{
			return false;
		}

		var line = ev.Message;
		if (string.IsNullOrWhiteSpace(line))
		{
			return false;
		}

		// Some core frames (notably thread/resume snapshots) can embed very large historical payloads.
		// They are not signal-oriented and can stall JSON parsing, so skip parsing for oversized frames.
		if (line.Length > MaxCoreStdoutJsonlParseChars)
		{
			return false;
		}

		if (shouldParseLine is not null && !shouldParseLine(line))
		{
			return false;
		}

		try
		{
			var parsed = JsonDocument.Parse(line);
			var parsedRoot = parsed.RootElement;
			if (parsedRoot.ValueKind != JsonValueKind.Object)
			{
				parsed.Dispose();
				return false;
			}

			document = parsed;
			root = parsedRoot;
			return true;
		}
		catch
		{
			return false;
		}
	}

	private static bool TryGetCoreMethodParams(JsonElement root, out string method, out JsonElement paramsElement)
	{
		method = string.Empty;
		paramsElement = default;
		if (!root.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String)
		{
			return false;
		}

		method = methodElement.GetString() ?? string.Empty;
		paramsElement = root.TryGetProperty("params", out var p) ? p : default;
		return true;
	}

	private static bool TryGetCoreEventPayload(JsonElement root, out string payloadType, out JsonElement payloadElement)
	{
		payloadType = string.Empty;
		payloadElement = default;
		if (!root.TryGetProperty("type", out var typeElement) ||
			typeElement.ValueKind != JsonValueKind.String ||
			!string.Equals(typeElement.GetString(), "event_msg", StringComparison.Ordinal) ||
			!root.TryGetProperty("payload", out payloadElement) ||
			payloadElement.ValueKind != JsonValueKind.Object ||
			!payloadElement.TryGetProperty("type", out var payloadTypeElement) ||
			payloadTypeElement.ValueKind != JsonValueKind.String)
		{
			return false;
		}

		payloadType = payloadTypeElement.GetString() ?? string.Empty;
		return true;
	}

	private static bool ShouldParseCoreAuxLine(string line)
	{
		return line.IndexOf("rateLimits", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("rate_limits", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("sessionConfigured", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("session_configured", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("thread/compacted", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("thread_compacted", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("thread/name/updated", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("thread_name_updated", StringComparison.Ordinal) >= 0;
	}

	private static bool ShouldParseCorePlanLine(string line)
	{
		return line.IndexOf("plan", StringComparison.OrdinalIgnoreCase) >= 0;
	}

	private static bool ShouldParseCoreTurnLine(string line)
	{
		return line.IndexOf("turn/started", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("codex/event/turn_started", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("\"turn_started\"", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("turn/completed", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("codex/event/task_complete", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("codex/event/turn_complete", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("\"turn_complete\"", StringComparison.Ordinal) >= 0 ||
			line.IndexOf("\"task_complete\"", StringComparison.Ordinal) >= 0;
	}

	private static bool TryParseCoreAuxSignals(CodexCoreEvent ev, out CoreAuxSignals signals)
	{
		signals = default;
		if (!TryOpenStdoutJsonlDocument(ev, ShouldParseCoreAuxLine, out var document, out var root) ||
			document is null)
		{
			return false;
		}

		using (document)
		{
			CoreRateLimitsSignal? rateLimitsSignal = null;
			CoreSessionConfiguredSignal? sessionConfiguredSignal = null;
			CoreThreadCompactedSignal? threadCompactedSignal = null;
			CoreThreadNameUpdatedSignal? threadNameUpdatedSignal = null;

			if (TryGetCoreMethodParams(root, out var method, out var paramsElement))
			{
				rateLimitsSignal = TryParseCoreRateLimitsSignalFromMethod(method, paramsElement);
				sessionConfiguredSignal = TryParseCoreSessionConfiguredSignalFromMethod(method, paramsElement);
				threadCompactedSignal = TryParseCoreThreadCompactedSignalFromMethod(method, paramsElement);
				threadNameUpdatedSignal = TryParseCoreThreadNameUpdatedSignalFromMethod(method, paramsElement);
			}

			if (TryGetCoreEventPayload(root, out var payloadType, out var payloadElement))
			{
				rateLimitsSignal ??= TryParseCoreRateLimitsSignalFromEventPayload(payloadType, payloadElement);
				sessionConfiguredSignal ??= TryParseCoreSessionConfiguredSignalFromEventPayload(payloadType, payloadElement);
				threadCompactedSignal ??= TryParseCoreThreadCompactedSignalFromEventPayload(payloadType, payloadElement);
				threadNameUpdatedSignal ??= TryParseCoreThreadNameUpdatedSignalFromEventPayload(payloadType, payloadElement);
			}

			signals = new CoreAuxSignals(rateLimitsSignal, sessionConfiguredSignal, threadCompactedSignal, threadNameUpdatedSignal);
			return signals.HasAnySignal;
		}
	}

	private static bool TryParseCorePlanSignal(CodexCoreEvent ev, out CorePlanSignal signal)
	{
		signal = default;
		if (!TryOpenStdoutJsonlDocument(ev, ShouldParseCorePlanLine, out var document, out var root) ||
			document is null)
		{
			return false;
		}

		using (document)
		{
			if (TryGetCoreMethodParams(root, out var method, out var paramsElement) &&
				TryParseCorePlanSignalFromMethod(method, paramsElement, out signal))
			{
				return true;
			}

			if (TryGetCoreEventPayload(root, out var payloadType, out var payloadElement) &&
				TryParseCorePlanSignalFromEventPayload(payloadType, payloadElement, out signal))
			{
				return true;
			}

			return false;
		}
	}

	private static bool TryParseCorePlanSignalFromMethod(string method, JsonElement paramsElement, out CorePlanSignal signal)
	{
		signal = default;
		if (string.Equals(method, "item/plan/delta", StringComparison.Ordinal) ||
			string.Equals(method, "codex/event/plan_delta", StringComparison.Ordinal))
		{
			return TryBuildCorePlanDeltaSignal(paramsElement, method, out signal);
		}

		if (string.Equals(method, "turn/plan/updated", StringComparison.Ordinal))
		{
			return TryBuildCorePlanUpdatedSignal(paramsElement, method, out signal);
		}

		return false;
	}

	private static bool TryParseCorePlanSignalFromEventPayload(string payloadType, JsonElement payloadElement, out CorePlanSignal signal)
	{
		signal = default;
		if (string.Equals(payloadType, "plan_delta", StringComparison.Ordinal) ||
			string.Equals(payloadType, "planDelta", StringComparison.Ordinal))
		{
			return TryBuildCorePlanDeltaSignal(payloadElement, $"event_msg:{payloadType}", out signal);
		}

		if (string.Equals(payloadType, "plan_update", StringComparison.Ordinal) ||
			string.Equals(payloadType, "plan_updated", StringComparison.Ordinal) ||
			string.Equals(payloadType, "planUpdate", StringComparison.Ordinal) ||
			string.Equals(payloadType, "planUpdated", StringComparison.Ordinal))
		{
			return TryBuildCorePlanUpdatedSignal(payloadElement, $"event_msg:{payloadType}", out signal);
		}

		return false;
	}

	private static bool TryBuildCorePlanDeltaSignal(JsonElement root, string source, out CorePlanSignal signal)
	{
		signal = default;
		var text = TryGetAnyPathString(root,
			new[] { "delta" },
			new[] { "text" },
			new[] { "msg", "delta" },
			new[] { "msg", "text" },
			new[] { "item", "delta" },
			new[] { "item", "text" });
		if (string.IsNullOrWhiteSpace(text))
		{
			return false;
		}

		var mode = WebCodexUtils.NormalizeCollaborationMode(
			TryGetAnyPathString(root,
				new[] { "collaboration_mode_kind" },
				new[] { "collaborationModeKind" },
				new[] { "mode" },
				new[] { "msg", "collaboration_mode_kind" },
				new[] { "msg", "collaborationModeKind" }));
		signal = new CorePlanSignal(CorePlanSignalKind.Delta, text.Trim(), mode, source);
		return true;
	}

	private static bool TryBuildCorePlanUpdatedSignal(JsonElement root, string source, out CorePlanSignal signal)
	{
		signal = default;
		var text = TryGetAnyPathString(root,
			new[] { "plan" },
			new[] { "text" },
			new[] { "summary" },
			new[] { "msg", "plan" },
			new[] { "msg", "text" },
			new[] { "msg", "summary" });
		var mode = WebCodexUtils.NormalizeCollaborationMode(
			TryGetAnyPathString(root,
				new[] { "collaboration_mode_kind" },
				new[] { "collaborationModeKind" },
				new[] { "mode" },
				new[] { "msg", "collaboration_mode_kind" },
				new[] { "msg", "collaborationModeKind" }));

		if (string.IsNullOrWhiteSpace(text) && string.IsNullOrWhiteSpace(mode))
		{
			return false;
		}

		signal = new CorePlanSignal(CorePlanSignalKind.Updated, string.IsNullOrWhiteSpace(text) ? null : text.Trim(), mode, source);
		return true;
	}

	private static CoreRateLimitsSignal? TryParseCoreRateLimitsSignalFromMethod(string method, JsonElement paramsElement)
	{
		if (!string.Equals(method, "account/rateLimits/updated", StringComparison.Ordinal) &&
			!string.Equals(method, "account/rate_limits/updated", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/account_rate_limits_updated", StringComparison.Ordinal) &&
			!string.Equals(method, "token_count", StringComparison.Ordinal) &&
			!string.Equals(method, "codex/event/token_count", StringComparison.Ordinal))
		{
			return null;
		}

		return BuildRateLimitsSignal(paramsElement, method);
	}

	private static CoreRateLimitsSignal? TryParseCoreRateLimitsSignalFromEventPayload(string payloadType, JsonElement payloadElement)
	{
		if (!string.Equals(payloadType, "rate_limits_updated", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "rateLimitsUpdated", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "account_rate_limits_updated", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "token_count", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "tokenCount", StringComparison.Ordinal))
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
		var rateLimitsRoot = ResolveRateLimitsRoot(root);
		var primary = TryBuildRateLimitWindow(rateLimitsRoot, "primary", "primary");
		var secondary = TryBuildRateLimitWindow(rateLimitsRoot, "secondary", "secondary");
		var scope = TryGetAnyPathString(rateLimitsRoot,
			new[] { "scope" },
			new[] { "name" },
			new[] { "limit_id" },
			new[] { "limitId" },
			new[] { "limit_name" },
			new[] { "limitName" },
			new[] { "msg", "scope" },
			new[] { "rateLimit", "scope" },
			new[] { "rate_limit", "scope" })
			?? TryGetAnyPathString(root,
			new[] { "scope" },
			new[] { "name" },
			new[] { "msg", "scope" },
			new[] { "rateLimit", "scope" },
			new[] { "rate_limit", "scope" });
		var remaining = TryGetAnyPathDouble(rateLimitsRoot,
			new[] { "remaining" },
			new[] { "msg", "remaining" },
			new[] { "limits", "remaining" },
			new[] { "rateLimit", "remaining" },
			new[] { "rate_limit", "remaining" })
			?? TryGetAnyPathDouble(root,
			new[] { "remaining" },
			new[] { "msg", "remaining" },
			new[] { "limits", "remaining" },
			new[] { "rateLimit", "remaining" },
			new[] { "rate_limit", "remaining" });
		var limit = TryGetAnyPathDouble(rateLimitsRoot,
			new[] { "limit" },
			new[] { "max" },
			new[] { "msg", "limit" },
			new[] { "limits", "limit" },
			new[] { "rateLimit", "limit" },
			new[] { "rate_limit", "limit" })
			?? TryGetAnyPathDouble(root,
			new[] { "limit" },
			new[] { "max" },
			new[] { "msg", "limit" },
			new[] { "limits", "limit" },
			new[] { "rateLimit", "limit" },
			new[] { "rate_limit", "limit" });
		var used = TryGetAnyPathDouble(rateLimitsRoot,
			new[] { "used" },
			new[] { "msg", "used" },
			new[] { "limits", "used" },
			new[] { "rateLimit", "used" },
			new[] { "rate_limit", "used" })
			?? TryGetAnyPathDouble(root,
			new[] { "used" },
			new[] { "msg", "used" },
			new[] { "limits", "used" },
			new[] { "rateLimit", "used" },
			new[] { "rate_limit", "used" });
		var retryAfterSeconds = TryGetAnyPathDouble(rateLimitsRoot,
			new[] { "retryAfterSeconds" },
			new[] { "retry_after_seconds" },
			new[] { "retry_after" },
			new[] { "msg", "retryAfterSeconds" },
			new[] { "msg", "retry_after_seconds" })
			?? TryGetAnyPathDouble(root,
			new[] { "retryAfterSeconds" },
			new[] { "retry_after_seconds" },
			new[] { "retry_after" },
			new[] { "msg", "retryAfterSeconds" },
			new[] { "msg", "retry_after_seconds" });
		var resetAtUtc = TryGetAnyPathDate(rateLimitsRoot,
			new[] { "resetAtUtc" },
			new[] { "resetAt" },
			new[] { "reset_at" },
			new[] { "resetsAt" },
			new[] { "resets_at" },
			new[] { "msg", "resetAtUtc" },
			new[] { "msg", "resetAt" },
			new[] { "msg", "reset_at" })
			?? TryGetAnyPathDate(root,
			new[] { "resetAtUtc" },
			new[] { "resetAt" },
			new[] { "reset_at" },
			new[] { "resetsAt" },
			new[] { "resets_at" },
			new[] { "msg", "resetAtUtc" },
			new[] { "msg", "resetAt" },
			new[] { "msg", "reset_at" });
		var planType = TryGetAnyPathString(rateLimitsRoot,
			new[] { "plan_type" },
			new[] { "planType" },
			new[] { "msg", "plan_type" },
			new[] { "msg", "planType" })
			?? TryGetAnyPathString(root,
			new[] { "plan_type" },
			new[] { "planType" },
			new[] { "msg", "plan_type" },
			new[] { "msg", "planType" });
		var hasCredits = TryGetAnyPathBool(rateLimitsRoot,
			new[] { "credits", "has_credits" },
			new[] { "credits", "hasCredits" },
			new[] { "msg", "credits", "has_credits" },
			new[] { "msg", "credits", "hasCredits" });
		var unlimitedCredits = TryGetAnyPathBool(rateLimitsRoot,
			new[] { "credits", "unlimited" },
			new[] { "msg", "credits", "unlimited" });
		var creditBalance = TryGetAnyPathDouble(rateLimitsRoot,
			new[] { "credits", "balance" },
			new[] { "msg", "credits", "balance" });
		var summary = TryGetAnyPathString(rateLimitsRoot,
			new[] { "summary" },
			new[] { "message" },
			new[] { "msg", "summary" },
			new[] { "msg", "message" })
			?? TryGetAnyPathString(root,
			new[] { "summary" },
			new[] { "message" },
			new[] { "msg", "summary" },
			new[] { "msg", "message" });
		if (string.IsNullOrWhiteSpace(summary) ||
			string.Equals(summary.Trim(), "Rate limits updated", StringComparison.OrdinalIgnoreCase))
		{
			summary = BuildRateLimitsSummary(scope, primary, secondary, remaining, limit, retryAfterSeconds, resetAtUtc);
		}

		var fingerprint = string.Join("|",
			NormalizeForFingerprint(scope),
			NormalizeForFingerprint(remaining),
			NormalizeForFingerprint(limit),
			NormalizeForFingerprint(used),
			NormalizeForFingerprint(retryAfterSeconds),
			NormalizeForFingerprint(resetAtUtc?.ToString("O")),
			NormalizeForFingerprint(primary?.UsedPercent),
			NormalizeForFingerprint(primary?.RemainingPercent),
			NormalizeForFingerprint(primary?.WindowMinutes),
			NormalizeForFingerprint(primary?.ResetsAtUtc?.ToString("O")),
			NormalizeForFingerprint(secondary?.UsedPercent),
			NormalizeForFingerprint(secondary?.RemainingPercent),
			NormalizeForFingerprint(secondary?.WindowMinutes),
			NormalizeForFingerprint(secondary?.ResetsAtUtc?.ToString("O")),
			NormalizeForFingerprint(planType),
			NormalizeForFingerprint(hasCredits),
			NormalizeForFingerprint(unlimitedCredits),
			NormalizeForFingerprint(creditBalance),
			NormalizeForFingerprint(summary));
		return new CoreRateLimitsSignal(
			scope,
			remaining,
			limit,
			used,
			retryAfterSeconds,
			resetAtUtc,
			primary,
			secondary,
			planType,
			hasCredits,
			unlimitedCredits,
			creditBalance,
			summary!,
			source,
			fingerprint);
	}

	private static string BuildRateLimitsSummary(
		string? scope,
		CoreRateLimitWindow? primary,
		CoreRateLimitWindow? secondary,
		double? remaining,
		double? limit,
		double? retryAfterSeconds,
		DateTimeOffset? resetAtUtc)
	{
		var parts = new List<string>();
		if (!string.IsNullOrWhiteSpace(scope))
		{
			parts.Add(scope!);
		}

		if (primary is not null)
		{
			var text = FormatRateLimitWindowSummary(primary, fallbackLabel: "primary");
			if (!string.IsNullOrWhiteSpace(text))
			{
				parts.Add(text);
			}
		}

		if (secondary is not null)
		{
			var text = FormatRateLimitWindowSummary(secondary, fallbackLabel: "secondary");
			if (!string.IsNullOrWhiteSpace(text))
			{
				parts.Add(text);
			}
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

		return parts.Count > 0 ? string.Join(" | ", parts) : "Rate limits updated";
	}

	private static string? FormatRateLimitWindowSummary(CoreRateLimitWindow window, string fallbackLabel)
	{
		var label = FormatRateLimitWindowLabel(window.WindowMinutes, fallbackLabel);
		if (window.RemainingPercent.HasValue)
		{
			return $"{label} {window.RemainingPercent.Value:0.#}% remaining";
		}

		if (window.UsedPercent.HasValue)
		{
			return $"{label} {window.UsedPercent.Value:0.#}% used";
		}

		return null;
	}

	private static CoreRateLimitWindow? TryBuildRateLimitWindow(JsonElement root, string snakeName, string camelName)
	{
		var usedPercent = TryGetAnyPathDouble(root,
			new[] { snakeName, "used_percent" },
			new[] { snakeName, "usedPercent" },
			new[] { camelName, "usedPercent" },
			new[] { camelName, "used_percent" });
		var windowMinutes = TryGetAnyPathDouble(root,
			new[] { snakeName, "window_minutes" },
			new[] { snakeName, "windowDurationMins" },
			new[] { snakeName, "windowMinutes" },
			new[] { camelName, "windowDurationMins" },
			new[] { camelName, "windowMinutes" },
			new[] { camelName, "window_minutes" });
		var resetsAtUtc = TryGetAnyPathDate(root,
			new[] { snakeName, "resets_at" },
			new[] { snakeName, "resetsAt" },
			new[] { snakeName, "resetAtUtc" },
			new[] { snakeName, "reset_at" },
			new[] { camelName, "resetsAt" },
			new[] { camelName, "resets_at" },
			new[] { camelName, "resetAtUtc" },
			new[] { camelName, "reset_at" });
		var remainingPercent = usedPercent.HasValue
			? Math.Clamp(100 - usedPercent.Value, 0, 100)
			: (double?)null;
		if (!usedPercent.HasValue && !windowMinutes.HasValue && !resetsAtUtc.HasValue)
		{
			return null;
		}

		return new CoreRateLimitWindow(
			UsedPercent: usedPercent,
			RemainingPercent: remainingPercent,
			WindowMinutes: windowMinutes,
			ResetsAtUtc: resetsAtUtc);
	}

	private static JsonElement ResolveRateLimitsRoot(JsonElement root)
	{
		if (TryGetPathObject(root, out var nested, "rate_limits"))
		{
			return nested;
		}

		if (TryGetPathObject(root, out nested, "rateLimits"))
		{
			return nested;
		}

		if (TryGetPathObject(root, out nested, "msg", "rate_limits"))
		{
			return nested;
		}

		if (TryGetPathObject(root, out nested, "msg", "rateLimits"))
		{
			return nested;
		}

		return root;
	}

	private static bool TryGetPathObject(JsonElement root, out JsonElement value, params string[] path)
	{
		value = root;
		foreach (var segment in path)
		{
			if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(segment, out value))
			{
				value = default;
				return false;
			}
		}

		if (value.ValueKind != JsonValueKind.Object)
		{
			value = default;
			return false;
		}

		return true;
	}

	private static string FormatRateLimitWindowLabel(double? windowMinutes, string fallback)
	{
		if (!windowMinutes.HasValue || windowMinutes.Value <= 0)
		{
			return fallback;
		}

		var rounded = Math.Round(windowMinutes.Value, MidpointRounding.AwayFromZero);
		if (Math.Abs(rounded - 300) <= 1)
		{
			return "5h";
		}

		if (Math.Abs(rounded - 10080) <= 1)
		{
			return "weekly";
		}

		if (rounded % 1440 == 0)
		{
			var days = rounded / 1440;
			return days == 1 ? "1d" : $"{days:0}d";
		}

		if (rounded % 60 == 0)
		{
			var hours = rounded / 60;
			return hours == 1 ? "1h" : $"{hours:0}h";
		}

		return rounded == 1 ? "1m" : $"{rounded:0}m";
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
		var approvalPolicyRaw = TryGetAnyPathString(root,
			new[] { "approvalPolicy" },
			new[] { "approval_policy" },
			new[] { "approvalMode" },
			new[] { "approval_mode" },
			new[] { "session", "approvalPolicy" },
			new[] { "session", "approval_policy" });
		var sandboxPolicyRaw = TryGetAnyPathString(root,
			new[] { "sandboxPolicy" },
			new[] { "sandboxPolicy", "type" },
			new[] { "sandbox_policy" },
			new[] { "sandboxMode" },
			new[] { "sandbox_mode" },
			new[] { "sandbox" },
			new[] { "sandbox", "type" },
			new[] { "session", "sandboxPolicy" },
			new[] { "session", "sandboxPolicy", "type" },
			new[] { "session", "sandbox_policy" },
			new[] { "session", "sandbox_policy", "type" });
		var approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicyRaw);
		var sandboxPolicy = WebCodexUtils.NormalizeSandboxMode(sandboxPolicyRaw);
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

	private static List<Dictionary<string, object?>> ParseToolUserInputQuestions(JsonElement paramsElement)
	{
		var questions = new List<Dictionary<string, object?>>();
		if (paramsElement.ValueKind != JsonValueKind.Object ||
			!paramsElement.TryGetProperty("questions", out var questionsElement) ||
			questionsElement.ValueKind != JsonValueKind.Array)
		{
			return questions;
		}

		foreach (var questionElement in questionsElement.EnumerateArray())
		{
			if (questionElement.ValueKind != JsonValueKind.Object)
			{
				continue;
			}

			var id = TryGetAnyPathString(questionElement, new[] { "id" });
			if (string.IsNullOrWhiteSpace(id))
			{
				continue;
			}

			var header = TryGetAnyPathString(questionElement, new[] { "header" }) ?? id;
			var question = TryGetAnyPathString(questionElement, new[] { "question" }) ?? string.Empty;
			var isSecret = questionElement.TryGetProperty("isSecret", out var isSecretElement) &&
				isSecretElement.ValueKind == JsonValueKind.True;
			var isOther = questionElement.TryGetProperty("isOther", out var isOtherElement) &&
				isOtherElement.ValueKind == JsonValueKind.True;

			var options = new List<Dictionary<string, string>>();
			if (questionElement.TryGetProperty("options", out var optionsElement) &&
				optionsElement.ValueKind == JsonValueKind.Array)
			{
				foreach (var optionElement in optionsElement.EnumerateArray())
				{
					if (optionElement.ValueKind != JsonValueKind.Object)
					{
						continue;
					}

					var label = TryGetAnyPathString(optionElement, new[] { "label" });
					if (string.IsNullOrWhiteSpace(label))
					{
						continue;
					}

					var description = TryGetAnyPathString(optionElement, new[] { "description" }) ?? string.Empty;
					options.Add(new Dictionary<string, string>(StringComparer.Ordinal)
					{
						["label"] = label,
						["description"] = description
					});
				}
			}

			questions.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
			{
				["id"] = id,
				["header"] = header,
				["question"] = question,
				["isSecret"] = isSecret,
				["isOther"] = isOther,
				["options"] = options
			});
		}

		return questions;
	}

	private static Dictionary<string, object?> BuildToolUserInputAnswersPayload(IReadOnlyDictionary<string, string> answersByQuestionId)
	{
		var payload = new Dictionary<string, object?>(StringComparer.Ordinal);
		if (answersByQuestionId is null)
		{
			return payload;
		}

		foreach (var entry in answersByQuestionId)
		{
			if (string.IsNullOrWhiteSpace(entry.Key))
			{
				continue;
			}

			var answer = entry.Value?.Trim();
			if (string.IsNullOrWhiteSpace(answer))
			{
				continue;
			}

			payload[entry.Key.Trim()] = new Dictionary<string, object?>(StringComparer.Ordinal)
			{
				["answers"] = new[] { answer }
			};
		}

		return payload;
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

	private static bool? TryGetAnyPathBool(JsonElement root, params string[][] paths)
	{
		foreach (var path in paths)
		{
			var raw = WebCodexUtils.TryGetPathString(root, path);
			if (string.IsNullOrWhiteSpace(raw))
			{
				continue;
			}

			if (bool.TryParse(raw, out var parsedBool))
			{
				return parsedBool;
			}

			if (string.Equals(raw, "1", StringComparison.Ordinal))
			{
				return true;
			}

			if (string.Equals(raw, "0", StringComparison.Ordinal))
			{
				return false;
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

			if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var unixRaw))
			{
				try
				{
					var isMilliseconds = Math.Abs(unixRaw) >= 1_000_000_000_000d;
					var unixRounded = (long)Math.Round(unixRaw, MidpointRounding.AwayFromZero);
					var unixValue = isMilliseconds
						? DateTimeOffset.FromUnixTimeMilliseconds(unixRounded)
						: DateTimeOffset.FromUnixTimeSeconds(unixRounded);
					return unixValue.ToUniversalTime();
				}
				catch
				{
				}
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

	private static string? TryExtractCoreTurnId(JsonElement root, JsonElement paramsElement)
	{
		return TryGetAnyPathString(paramsElement,
			new[] { "turn", "id" },
			new[] { "turnId" },
			new[] { "id" },
			new[] { "msg", "turn_id" },
			new[] { "msg", "turnId" })
			?? TryGetAnyPathString(root,
				new[] { "turnId" },
				new[] { "id" });
	}

	private static bool TryParseCoreTurnSignal(CodexCoreEvent ev, out CoreTurnSignal signal)
	{
		signal = default;
		if (!TryOpenStdoutJsonlDocument(ev, ShouldParseCoreTurnLine, out var document, out var root) ||
			document is null)
		{
			return false;
		}

		using (document)
		{
			if (TryGetCoreMethodParams(root, out var method, out var paramsElement))
			{
				if (string.Equals(method, "turn/started", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/turn_started", StringComparison.Ordinal))
				{
					var turnId = TryExtractCoreTurnId(root, paramsElement);
					if (string.IsNullOrWhiteSpace(turnId))
					{
						return false;
					}

					signal = new CoreTurnSignal(
						Kind: CoreTurnSignalKind.Started,
						TurnId: turnId,
						Status: null,
						ErrorMessage: null,
						Source: method);
					return true;
				}

				if (string.Equals(method, "turn/completed", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/turn_complete", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal))
				{
					var turnId = TryExtractCoreTurnId(root, paramsElement);
					if (string.IsNullOrWhiteSpace(turnId))
					{
						return false;
					}

					var status = WebCodexUtils.TryGetPathString(root, "params", "turn", "status")
						?? WebCodexUtils.TryGetPathString(root, "params", "msg", "status")
						?? WebCodexUtils.TryGetPathString(root, "params", "status")
						?? (string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal) ? "completed" : "unknown");
					var errorMessage = WebCodexUtils.TryGetPathString(root, "params", "turn", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "msg", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "msg", "errorMessage")
						?? WebCodexUtils.TryGetPathString(root, "params", "error", "message")
						?? WebCodexUtils.TryGetPathString(root, "params", "errorMessage");
					signal = new CoreTurnSignal(
						Kind: CoreTurnSignalKind.Completed,
						TurnId: turnId,
						Status: status,
						ErrorMessage: errorMessage,
						Source: method);
					return true;
				}

				return false;
			}

			if (!TryGetCoreEventPayload(root, out var payloadType, out var payloadElement))
			{
				return false;
			}

			if (string.Equals(payloadType, "turn_started", StringComparison.Ordinal))
			{
				var turnId = TryGetAnyPathString(payloadElement,
					new[] { "turn", "id" },
					new[] { "turnId" },
					new[] { "turn_id" },
					new[] { "id" });
				if (string.IsNullOrWhiteSpace(turnId))
				{
					return false;
				}

				signal = new CoreTurnSignal(
					Kind: CoreTurnSignalKind.Started,
					TurnId: turnId,
					Status: null,
					ErrorMessage: null,
					Source: $"event_msg:{payloadType}");
				return true;
			}

			if (string.Equals(payloadType, "turn_complete", StringComparison.Ordinal) ||
				string.Equals(payloadType, "task_complete", StringComparison.Ordinal))
			{
				var turnId = TryGetAnyPathString(payloadElement,
					new[] { "turn", "id" },
					new[] { "turnId" },
					new[] { "turn_id" },
					new[] { "msg", "turn_id" },
					new[] { "msg", "turnId" },
					new[] { "id" });
				if (string.IsNullOrWhiteSpace(turnId))
				{
					return false;
				}

				var status = WebCodexUtils.TryGetPathString(payloadElement, "status");
				if (string.IsNullOrWhiteSpace(status))
				{
					status = string.Equals(payloadType, "task_complete", StringComparison.Ordinal)
						? "completed"
						: "unknown";
				}

				var errorMessage = WebCodexUtils.TryGetPathString(payloadElement, "error", "message")
					?? WebCodexUtils.TryGetPathString(payloadElement, "msg", "error", "message")
					?? WebCodexUtils.TryGetPathString(payloadElement, "msg", "errorMessage")
					?? WebCodexUtils.TryGetPathString(payloadElement, "errorMessage");
				signal = new CoreTurnSignal(
					Kind: CoreTurnSignalKind.Completed,
					TurnId: turnId,
					Status: status,
					ErrorMessage: errorMessage,
					Source: $"event_msg:{payloadType}");
				return true;
			}

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
		string? TurnId,
		string? Status,
		string? ErrorMessage,
		string Source);

	private enum CorePlanSignalKind
	{
		Delta,
		Updated
	}

	private readonly record struct CorePlanSignal(
		CorePlanSignalKind Kind,
		string? Text,
		string? CollaborationMode,
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

	private sealed record CoreIssueSignal(
		string Code,
		string Severity,
		string UserMessage,
		string Detail,
		string RecommendedAction,
		bool IsAuthError,
		bool IsTransient)
	{
		public string DedupeKey => $"{Code}|{Detail}";
	}

	private sealed record CoreRateLimitsSignal(
		string? Scope,
		double? Remaining,
		double? Limit,
		double? Used,
		double? RetryAfterSeconds,
		DateTimeOffset? ResetAtUtc,
		CoreRateLimitWindow? Primary,
		CoreRateLimitWindow? Secondary,
		string? PlanType,
		bool? HasCredits,
		bool? UnlimitedCredits,
		double? CreditBalance,
		string Summary,
		string Source,
		string Fingerprint);

	private sealed record CoreRateLimitWindow(
		double? UsedPercent,
		double? RemainingPercent,
		double? WindowMinutes,
		DateTimeOffset? ResetsAtUtc);

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

	private TimeSpan GetRecoveredTurnStaleAfter()
	{
		var seconds = Math.Clamp(_defaults.TurnSlotWaitTimeoutSeconds * 2, 90, 1200);
		return TimeSpan.FromSeconds(seconds);
	}

	private TimeSpan GetPendingTurnStartStaleAfter()
	{
		var seconds = Math.Clamp(_defaults.TurnStartAckTimeoutSeconds, 5, 120);
		return TimeSpan.FromSeconds(seconds);
	}

	private TimeSpan GetStartedLocalTurnStaleAfter()
	{
		var seconds = Math.Clamp(_defaults.TurnTimeoutSeconds, 60, 1200);
		return TimeSpan.FromSeconds(seconds);
	}

	private bool TryCreateRecoveryOfferForStaleTurn(
		string sessionId,
		ManagedSession session,
		string reason,
		string message,
		TimeSpan pendingAge,
		string detectedEventName)
	{
		if (session.IsAppServerRecovering)
		{
			return false;
		}

		if (!session.TryCreateRecoveryOffer(reason, message, pendingAge, out var offer) || offer is null)
		{
			return false;
		}

		var roundedSeconds = Math.Round(Math.Max(0, offer.PendingSeconds));
		WriteOrchestratorAudit(
			$"event={detectedEventName} sessionId={sessionId} threadId={session.Session.ThreadId} pendingSeconds={roundedSeconds:0} offerId={offer.OfferId} reason={reason} {session.BuildTurnDebugSummary()} {session.BuildRpcDebugSummary()}");
		WriteOrchestratorAudit(
			$"event=recovery_offer_created sessionId={sessionId} threadId={session.Session.ThreadId} offerId={offer.OfferId} reason={reason} pendingSeconds={roundedSeconds:0}");
		session.Log.Write(
			$"[session_recovery] offer created offerId={offer.OfferId} reason={reason} pendingSeconds={roundedSeconds:0}");
		Broadcast?.Invoke(
			"session_recovery_offer",
			new
			{
				sessionId,
				offerId = offer.OfferId,
				reason,
				message,
				pendingSeconds = roundedSeconds,
				createdAtUtc = offer.CreatedAtUtc
			});
		Broadcast?.Invoke("status", new { sessionId, message = $"{message} Recover to restart the session app-server." });
		SessionsChanged?.Invoke();
		return true;
	}

	private bool TryExpireStalePendingTurnStart(string sessionId, ManagedSession session, TimeSpan staleAfter)
	{
		if (!session.IsLocalTurnAwaitingStartStale(staleAfter, out var pendingAge))
		{
			return false;
		}

		var roundedSeconds = Math.Round(pendingAge.TotalSeconds);
		var message = $"Turn start did not confirm after {roundedSeconds:0}s. Codex may be disconnected.";
		return TryCreateRecoveryOfferForStaleTurn(
			sessionId,
			session,
			reason: "turn_start_stale",
			message: message,
			pendingAge: pendingAge,
			detectedEventName: "turn_start_stale_detected");
	}

	private bool TryExpireStaleStartedLocalTurn(string sessionId, ManagedSession session, TimeSpan staleAfter)
	{
		if (!session.IsLocalStartedTurnStale(staleAfter, out var silentAge))
		{
			return false;
		}

		var roundedSeconds = Math.Round(silentAge.TotalSeconds);
		var message = $"Started turn showed no core activity for {roundedSeconds:0}s. Codex may be disconnected.";
		return TryCreateRecoveryOfferForStaleTurn(
			sessionId,
			session,
			reason: "turn_started_no_activity_stale",
			message: message,
			pendingAge: silentAge,
			detectedEventName: "turn_started_stale_detected");
	}

	private async Task RecoverSessionAfterStaleTurnStartAsync(string sessionId, ManagedSession staleSession, TimeSpan pendingAge)
	{
		var roundedSeconds = Math.Round(pendingAge.TotalSeconds);
		var queuedTurns = staleSession.GetQueuedTurnsSnapshot();
		var recoverableTurn = staleSession.GetRecoverableTurnSnapshot();
		var threadId = staleSession.Session.ThreadId;
		var model = staleSession.CurrentModel ?? _defaults.DefaultModel;
		var effort = staleSession.CurrentReasoningEffort;
		var approvalPolicy = staleSession.CurrentApprovalPolicy;
		var sandboxPolicy = staleSession.CurrentSandboxPolicy;
		var cwd = string.IsNullOrWhiteSpace(staleSession.Cwd) ? _defaults.DefaultCwd : staleSession.Cwd;
		var codexPath = string.IsNullOrWhiteSpace(staleSession.CodexPath) ? _defaults.CodexPath : staleSession.CodexPath;
		ManagedSession? replacement = null;
		var staleDisposed = false;
		WriteOrchestratorAudit(
			$"event=appserver_recovery_begin sessionId={sessionId} threadId={threadId} pendingSeconds={roundedSeconds} queuedTurns={queuedTurns.Count} {staleSession.BuildRpcDebugSummary()}");
		try
		{
			staleSession.CancelLifetime();
			TryRemoveSession(sessionId, out _);
			try
			{
				await staleSession.Client.DisposeAsync();
			}
			catch (Exception ex)
			{
				Logs.LogError(ex);
			}

			try
			{
				staleSession.Log.Dispose();
			}
			catch
			{
			}

			staleDisposed = true;

			var recoveryTimeoutSeconds = Math.Clamp(_defaults.TurnStartAckTimeoutSeconds * 2, 15, 120);
			using var recoveryCts = new CancellationTokenSource(TimeSpan.FromSeconds(recoveryTimeoutSeconds));
			await StartManagedSessionAsync(
				sessionId,
				model,
				effort,
				approvalPolicy,
				sandboxPolicy,
				cwd,
				codexPath,
				attached: true,
				(client, ct) => client.AttachToSessionAsync(new CodexSessionAttachOptions
				{
					ThreadId = threadId,
					Cwd = cwd,
					Model = model,
					ApprovalPolicy = approvalPolicy,
					SandboxMode = sandboxPolicy
				}, ct),
				recoveryCts.Token,
				appServerRecovering: true);

			replacement = TryGetSession(sessionId);
			if (replacement is null || ReferenceEquals(replacement, staleSession))
			{
				throw new InvalidOperationException("Recovered session was not available after reattach.");
			}

			if (queuedTurns.Count > 0)
			{
				replacement.ReplaceQueuedTurns(queuedTurns);
			}
			replacement.RestoreRecoverableTurnSnapshot(recoverableTurn);

			replacement.MarkAppServerRecoveryComplete();
			SessionsChanged?.Invoke();
			if (queuedTurns.Count > 0)
			{
				EnsureQueueDispatcher(sessionId, replacement);
			}

			replacement.Log.Write($"[session_recovery] completed app-server recovery after stale turn/start ({roundedSeconds:0}s)");
			Broadcast?.Invoke(
				"session_recovery_state",
				new
				{
					sessionId,
					state = "recovered",
					pendingSeconds = roundedSeconds
				});
			WriteOrchestratorAudit(
				$"event=appserver_recovery_completed sessionId={sessionId} threadId={replacement.Session.ThreadId} pendingSeconds={roundedSeconds} queuedTurnsRestored={queuedTurns.Count}");
			if (replacement.TryCreateTurnRetryOfferAfterRecovery(out var retryOffer) && retryOffer is not null)
			{
				WriteOrchestratorAudit(
					$"event=turn_retry_offer_created sessionId={sessionId} threadId={replacement.Session.ThreadId} offerId={retryOffer.OfferId} dispatchId={retryOffer.DispatchId ?? "(none)"} textChars={retryOffer.TextChars} imageCount={retryOffer.ImageCount}");
				replacement.Log.Write(
					$"[turn_retry] offer created offerId={retryOffer.OfferId} dispatchId={retryOffer.DispatchId ?? "(none)"}");
				Broadcast?.Invoke(
					"turn_retry_offer",
					new
					{
						sessionId,
						offerId = retryOffer.OfferId,
						message = retryOffer.Message,
						pendingSeconds = retryOffer.PendingSeconds,
						createdAtUtc = retryOffer.CreatedAtUtc,
						dispatchId = retryOffer.DispatchId,
						textChars = retryOffer.TextChars,
						imageCount = retryOffer.ImageCount,
						model = retryOffer.Model,
						reasoningEffort = retryOffer.ReasoningEffort,
						approvalPolicy = retryOffer.ApprovalPolicy,
						sandboxPolicy = retryOffer.SandboxPolicy
					});
				Broadcast?.Invoke("status", new { sessionId, message = "Recovery completed. Retry the dropped prompt if needed." });
			}
			Broadcast?.Invoke("status", new { sessionId, message = "Session recovered after stalled turn/start." });
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			var failureMessage = SimplifyRpcErrorMessage(ex.Message) ?? ex.Message;
			var current = TryGetSession(sessionId);
			current?.MarkAppServerRecoveryComplete();
			if (current is null)
			{
				Broadcast?.Invoke(
					"session_stopped",
					new
					{
						sessionId,
						message = "Session recovery failed and the session was stopped.",
						clearedQueuedTurnCount = queuedTurns.Count
					});
			}
			SessionsChanged?.Invoke();
			Broadcast?.Invoke(
				"session_recovery_state",
				new
				{
					sessionId,
					state = "failed",
					errorMessage = failureMessage
				});
			WriteOrchestratorAudit(
				$"event=appserver_recovery_failed sessionId={sessionId} pendingSeconds={roundedSeconds} error={failureMessage}");
			Broadcast?.Invoke("error", new { message = $"Session recovery failed: {failureMessage}" });
		}
		finally
		{
			staleSession.MarkAppServerRecoveryComplete();
			if (!staleDisposed)
			{
				staleSession.CancelLifetime();
				try
				{
					await staleSession.Client.DisposeAsync();
				}
				catch (Exception ex)
				{
					Logs.LogError(ex);
				}

				try
				{
					staleSession.Log.Dispose();
				}
				catch
				{
				}
			}
		}
	}

	private bool TryExpireStaleRecoveredTurn(string sessionId, ManagedSession session, TimeSpan staleAfter)
	{
		if (!session.IsRecoveredTurnStale(staleAfter, out var recoveredAge))
		{
			return false;
		}

		var roundedSeconds = Math.Round(recoveredAge.TotalSeconds);
		var message = $"Recovered in-flight turn expired after {roundedSeconds:0}s without completion signal.";
		if (!TryPublishTurnComplete(sessionId, session, status: "interrupted", errorMessage: message))
		{
			return false;
		}

		session.Log.Write($"[turn_recovery] expired stale recovered turn after {roundedSeconds:0}s");
		Broadcast?.Invoke("status", new { sessionId, message = "Recovered in-flight turn was stale and has been reset." });
		return true;
	}

	private static bool TryRecoverIdleTurnGate(ManagedSession session)
	{
		if (!session.TryRecoverTurnSlotIfIdle())
		{
			return false;
		}

		session.Log.Write("[turn_gate] recovered stuck idle gate");
		return true;
	}

	private async Task<bool> TryRecoverAndAcquireTurnSlotAsync(
		string sessionId,
		ManagedSession session,
		TimeSpan stalePendingStartAfter,
		TimeSpan staleStartedLocalAfter,
		TimeSpan staleRecoveredAfter,
		bool includeDirectImmediateWait)
	{
		RecoverTurnStateFromClientIfNeeded(sessionId, session);

		if (TryRecoverIdleTurnGate(session))
		{
			return true;
		}

		if (TryExpireStalePendingTurnStart(sessionId, session, stalePendingStartAfter) &&
			await session.TryWaitForTurnSlotAsync(timeout: TimeSpan.Zero, cancellationToken: session.LifetimeToken))
		{
			return true;
		}

		if (TryExpireStaleStartedLocalTurn(sessionId, session, staleStartedLocalAfter) &&
			await session.TryWaitForTurnSlotAsync(timeout: TimeSpan.Zero, cancellationToken: session.LifetimeToken))
		{
			return true;
		}

		if (TryExpireStaleRecoveredTurn(sessionId, session, staleRecoveredAfter))
		{
			TryRecoverIdleTurnGate(session);
			if (await session.TryWaitForTurnSlotAsync(timeout: TimeSpan.Zero, cancellationToken: session.LifetimeToken))
			{
				return true;
			}
		}

		if (!includeDirectImmediateWait)
		{
			return false;
		}

		return await session.TryWaitForTurnSlotAsync(timeout: TimeSpan.Zero, cancellationToken: session.LifetimeToken);
	}

	private async Task<bool> WaitForTurnSlotWithTimeoutAsync(string sessionId, ManagedSession session)
	{
		var staleRecoveredAfter = GetRecoveredTurnStaleAfter();
		var stalePendingStartAfter = GetPendingTurnStartStaleAfter();
		var staleStartedLocalAfter = GetStartedLocalTurnStaleAfter();
		if (await TryRecoverAndAcquireTurnSlotAsync(
			sessionId,
			session,
			stalePendingStartAfter,
			staleStartedLocalAfter,
			staleRecoveredAfter,
			includeDirectImmediateWait: true))
		{
			return true;
		}

		Broadcast?.Invoke("status", new { sessionId, message = "Turn queued: waiting for previous turn to finish." });

		var overallTimeout = TimeSpan.FromSeconds(_defaults.TurnSlotWaitTimeoutSeconds);
		var pollInterval = TimeSpan.FromSeconds(Math.Clamp(_defaults.TurnSlotWaitPollSeconds, 1, 30));
		var deadline = DateTimeOffset.UtcNow.Add(overallTimeout);

		while (DateTimeOffset.UtcNow < deadline && !session.LifetimeToken.IsCancellationRequested)
		{
			if (await TryRecoverAndAcquireTurnSlotAsync(
				sessionId,
				session,
				stalePendingStartAfter,
				staleStartedLocalAfter,
				staleRecoveredAfter,
				includeDirectImmediateWait: false))
			{
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

	private void RecoverTurnStateFromClientIfNeeded(string sessionId, ManagedSession session)
	{
		if (!session.TryMarkTurnStartedFromClientState(out var recoveredTurnId))
		{
			return;
		}

		session.Log.Write($"[turn_recovery] recovered active turn from client state turnId={recoveredTurnId ?? "(unknown)"}");
		var collaborationMode = session.GetActiveCollaborationMode();
		Broadcast?.Invoke(
			"turn_started",
			new
			{
				sessionId,
				isPlanTurn = string.Equals(collaborationMode, "plan", StringComparison.Ordinal),
				collaborationMode
			});
		SessionsChanged?.Invoke();
	}

	public async ValueTask DisposeAsync()
	{
		ManagedSession[] sessions;
		lock (_sync)
		{
			sessions = _sessions.Values.ToArray();
			_sessions.Clear();
		}
		lock (_turnCacheSync)
		{
			_turnCacheByThread.Clear();
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
		string? approvalPolicy,
		string? sandboxPolicy,
		string? cwd,
		string logPath,
		bool attached);

	internal enum LoadedSessionAttachResolutionKind
	{
		NotLoaded,
		Resolved,
		Ambiguous,
		Unavailable
	}

	internal sealed record LoadedSessionAttachResolution(
		LoadedSessionAttachResolutionKind Kind,
		string? SessionId,
		string? ThreadId,
		string? Cwd,
		string? Model,
		string? ReasoningEffort,
		string? ApprovalPolicy,
		string? SandboxPolicy,
		string? Reason,
		IReadOnlyList<string> CandidateSessionIds);

	internal sealed record TurnWatchSnapshot(
		string ThreadId,
		string? ThreadName,
		string SessionFilePath,
		DateTimeOffset? UpdatedAtUtc,
		// Protocol contract: mode=full is an authoritative snapshot, mode=noop means no
		// timeline mutation is required for this cursor tick.
		string Mode,
		long Cursor,
		long NextCursor,
		bool Reset,
		bool Truncated,
		int TurnCountInMemory,
		TurnContextUsageSnapshot? ContextUsage,
		TurnPermissionInfoSnapshot? Permission,
		string ReasoningSummary,
		IReadOnlyList<ConsolidatedTurnSnapshot> Turns,
		ConsolidatedTurnSnapshot? ActiveTurnDetail);

	internal sealed record TurnContextUsageSnapshot(
		double? UsedTokens,
		double? ContextWindow,
		double? PercentLeft);

	internal sealed record TurnPermissionInfoSnapshot(
		string Approval,
		string Sandbox);

	internal sealed class ConsolidatedTurnSnapshot
	{
		public string TurnId { get; set; } = string.Empty;
		public TurnEntrySnapshot User { get; set; } = new("user", "User", string.Empty, null, "message", false, Array.Empty<string>());
		public TurnEntrySnapshot? AssistantFinal { get; set; }
		public List<TurnEntrySnapshot> Intermediate { get; set; } = new();
		public bool IsInFlight { get; set; }
		public bool HasIntermediate { get; set; }
		public int IntermediateCount { get; set; }
		public bool IntermediateLoaded { get; set; }

		public ConsolidatedTurnSnapshot Clone()
		{
			return new ConsolidatedTurnSnapshot
			{
				TurnId = TurnId,
				User = User.Clone(),
				AssistantFinal = AssistantFinal?.Clone(),
				Intermediate = Intermediate.Select(x => x.Clone()).ToList(),
				IsInFlight = IsInFlight,
				HasIntermediate = HasIntermediate,
				IntermediateCount = IntermediateCount,
				IntermediateLoaded = IntermediateLoaded
			};
		}
	}

	internal sealed class TurnEntrySnapshot
	{
		public TurnEntrySnapshot(
			string role,
			string title,
			string text,
			string? timestamp,
			string rawType,
			bool compact,
			IReadOnlyList<string> images)
		{
			Role = role;
			Title = title;
			Text = text;
			Timestamp = timestamp;
			RawType = rawType;
			Compact = compact;
			Images = images?.ToArray() ?? Array.Empty<string>();
		}

		public string Role { get; set; }
		public string Title { get; set; }
		public string Text { get; set; }
		public string? Timestamp { get; set; }
		public string RawType { get; set; }
		public bool Compact { get; set; }
		public string[] Images { get; set; } = Array.Empty<string>();

		public TurnEntrySnapshot Clone()
		{
			return new TurnEntrySnapshot(Role, Title, Text, Timestamp, RawType, Compact, Images.ToArray());
		}
	}

	private sealed class ThreadTurnCacheState
	{
		public string SessionFilePath { get; set; } = string.Empty;
		public long FileLength { get; set; }
		public DateTime FileLastWriteUtc { get; set; }
		public int MaxEntries { get; set; }
		public long Version { get; set; }
		public bool Truncated { get; set; }
		public bool LastIsTurnInFlight { get; set; }
		public bool LastInferredTurnInFlightFromLogs { get; set; }
		public string ReasoningSummary { get; set; } = string.Empty;
		public TurnContextUsageSnapshot? ContextUsage { get; set; }
		public TurnPermissionInfoSnapshot? Permission { get; set; }
		public List<ConsolidatedTurnSnapshot> Turns { get; set; } = new();
	}

	private sealed class ConsolidatedTurnBuilder
	{
		public ConsolidatedTurnBuilder(TimelineProjectedEntry userEntry, string? taskId, bool isInferredUserAnchor = false)
		{
			User = userEntry.Clone();
			TaskId = string.IsNullOrWhiteSpace(taskId) ? null : taskId.Trim();
			IsInferredUserAnchor = isInferredUserAnchor;
		}

		public TimelineProjectedEntry User { get; private set; }
		public string? TaskId { get; private set; }
		public bool IsInferredUserAnchor { get; private set; }
		public TimelineProjectedEntry? FinalAssistant { get; set; }
		public List<TurnEntrySnapshot> Intermediate { get; } = new();
		public bool IsInFlight { get; set; }

		public void ReplaceInferredUser(TimelineProjectedEntry userEntry, string? taskId)
		{
			if (!IsInferredUserAnchor)
			{
				return;
			}

			User = userEntry.Clone();
			TaskId = string.IsNullOrWhiteSpace(taskId) ? null : taskId.Trim();
			IsInferredUserAnchor = false;
		}

		public ConsolidatedTurnSnapshot ToSnapshot(string threadId, int sequence)
		{
			var userTurnEntry = new TurnEntrySnapshot(
				"user",
				string.IsNullOrWhiteSpace(User.Title) ? "User" : User.Title,
				User.Text ?? string.Empty,
				User.Timestamp,
				string.IsNullOrWhiteSpace(User.RawType) ? "message" : User.RawType,
				User.Compact,
				User.Images ?? Array.Empty<string>());
			var turnId = !string.IsNullOrWhiteSpace(User.Timestamp)
				? $"{threadId}:{User.Timestamp}:{sequence}"
				: $"{threadId}:turn-{sequence}";
			return new ConsolidatedTurnSnapshot
			{
				TurnId = turnId,
				User = userTurnEntry,
				AssistantFinal = FinalAssistant is null ? null : ToTurnEntry(FinalAssistant),
				Intermediate = Intermediate.Select(x => x.Clone()).ToList(),
				IsInFlight = IsInFlight,
				HasIntermediate = Intermediate.Count > 0,
				IntermediateCount = Intermediate.Count,
				IntermediateLoaded = true
			};
		}
	}

internal sealed record SessionSnapshot(
	string SessionId,
	string ThreadId,
	string? Cwd,
	string? Model,
	string? ReasoningEffort,
	string? ApprovalPolicy,
	string? SandboxPolicy,
	bool IsTurnInFlight,
	PendingApprovalSnapshot? PendingApproval,
	RecoveryOfferSnapshot? PendingRecoveryOffer,
	TurnRetryOfferSnapshot? PendingTurnRetryOffer,
	int QueuedTurnCount,
	IReadOnlyList<QueuedTurnSummarySnapshot> QueuedTurns,
	int TurnCountInMemory,
	bool IsTurnInFlightInferredFromLogs,
	bool IsTurnInFlightLogOnly,
	bool IsAppServerRecovering);

internal sealed record SessionRateLimitSnapshot(
	string SessionId,
	string ThreadId,
	string? Scope,
	double? Remaining,
	double? Limit,
	double? Used,
	double? RetryAfterSeconds,
	DateTimeOffset? ResetAtUtc,
	SessionRateLimitWindowSnapshot? Primary,
	SessionRateLimitWindowSnapshot? Secondary,
	string? PlanType,
	bool? HasCredits,
	bool? UnlimitedCredits,
	double? CreditBalance,
	string Summary,
	string Source,
	DateTimeOffset UpdatedAtUtc);

internal sealed record SessionRateLimitWindowSnapshot(
	double? UsedPercent,
	double? RemainingPercent,
	double? WindowMinutes,
	DateTimeOffset? ResetsAtUtc);

	internal sealed record QueuedTurnSummarySnapshot(
		string QueueItemId,
		string PreviewText,
		int ImageCount,
		DateTimeOffset CreatedAtUtc);

	internal sealed record QueuedTurnImagePayload(string Url);

	internal sealed record QueuedTurnEditPayload(
		string QueueItemId,
		string Text,
		IReadOnlyList<QueuedTurnImagePayload> Images);

	internal sealed record SteerTurnResult(
		bool Success,
		string? ErrorMessage,
		TurnSubmitFallback Fallback);

	internal enum TurnSubmitFallback
	{
		None,
		StartTurn,
		QueueTurn
	}

	private sealed record TurnExecutionRequest(
		string Text,
		string? Cwd,
		IReadOnlyList<CodexUserImageInput> Images,
		CodexCollaborationMode? CollaborationMode,
		string? QueueItemId,
		string? ModelOverride = null,
		string? ReasoningEffortOverride = null,
		string? ApprovalPolicyOverride = null,
		string? SandboxPolicyOverride = null,
		string? ReplaySource = null);

	internal sealed record QueuedTurn(
		string QueueItemId,
		string Text,
		string? Cwd,
		IReadOnlyList<CodexUserImageInput> Images,
		CodexCollaborationMode? CollaborationMode,
		DateTimeOffset CreatedAtUtc);

	private enum TurnExecutionOutcome
	{
		Finished,
		QueueTimedOut,
		AccountMismatch,
		CanceledByLifetime
	}

	internal sealed record PendingApprovalSnapshot(
		string ApprovalId,
		string RequestType,
		string Summary,
		string? Reason,
		string? Cwd,
		IReadOnlyList<string> Actions,
		DateTimeOffset CreatedAtUtc);

	internal sealed record RecoveryOfferSnapshot(
		string OfferId,
		string Reason,
		string Message,
		double PendingSeconds,
		DateTimeOffset CreatedAtUtc,
		string? DispatchId,
		string? ActiveTurnId);

	internal sealed record TurnRetryOfferSnapshot(
		string OfferId,
		string Message,
		double PendingSeconds,
		DateTimeOffset CreatedAtUtc,
		string? DispatchId,
		int TextChars,
		int ImageCount,
		string? Model,
		string? ReasoningEffort,
		string? ApprovalPolicy,
		string? SandboxPolicy);

	internal sealed record RecoverableTurnReplaySnapshot(
		string DispatchId,
		string Text,
		string? Cwd,
		IReadOnlyList<CodexUserImageInput> Images,
		CodexCollaborationMode? CollaborationMode,
		string? Model,
		string? ReasoningEffort,
		string? ApprovalPolicy,
		string? SandboxPolicy,
		bool StartAcknowledged,
		bool StaleStartCanceled,
		DateTimeOffset CreatedAtUtc,
		DateTimeOffset? StaleCanceledAtUtc,
		bool RetryOffered);

	internal sealed record ManagedSession(
		string SessionId,
		CodexClient Client,
		CodexSession Session,
		string? Cwd,
		string? CodexPath,
		string? Model,
		string? ReasoningEffort,
		LocalLogWriter Log,
		ConcurrentDictionary<string, TaskCompletionSource<string>> PendingApprovals,
		ConcurrentDictionary<string, TaskCompletionSource<Dictionary<string, object?>>> PendingToolUserInputs,
		string? ApprovalPolicy = null,
		string? SandboxPolicy = null,
		string? StartupAuthIdentityKey = null,
		string? StartupAuthLabel = null,
		bool AppServerRecovering = false,
		CancellationTokenSource? ClientLifetimeCts = null)
	{
		private enum TurnLifecycleState
		{
			Idle,
			RunningLocal,
			RunningRecovered
		}

		private readonly CancellationTokenSource _lifetimeCts = new();
		private readonly SemaphoreSlim _turnGate = new(1, 1);
		private readonly object _approvalSync = new();
		private readonly object _turnSync = new();
		private readonly object _queueSync = new();
		private readonly object _modelsSync = new();
		private readonly List<QueuedTurn> _queuedTurns = new();
		private readonly SemaphoreSlim _modelsListGate = new(1, 1);
		private string? _model = string.IsNullOrWhiteSpace(Model) ? null : Model.Trim();
		private string? _reasoningEffort = WebCodexUtils.NormalizeReasoningEffort(ReasoningEffort);
		private string? _approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(ApprovalPolicy);
		private string? _sandboxPolicy = WebCodexUtils.NormalizeSandboxMode(SandboxPolicy);
		private IReadOnlyList<CodexModelInfo> _cachedModels = Array.Empty<CodexModelInfo>();
		private DateTimeOffset _cachedModelsFetchedUtc = DateTimeOffset.MinValue;
		private CancellationTokenSource? _activeTurnCts;
		private string? _activeTurnId;
		private string? _activeDispatchId;
		private string? _activeCollaborationMode;
		private TurnLifecycleState _turnState = TurnLifecycleState.Idle;
		private DateTimeOffset _turnStateChangedUtc = DateTimeOffset.UtcNow;
		private DateTimeOffset _lastCoreEventUtc = DateTimeOffset.UtcNow;
		private string? _lastCoreEventType;
		private string? _lastCoreEventMessage;
		private string? _lastBroadcastCoreIssueKey;
		private DateTimeOffset _lastBroadcastCoreIssueUtc = DateTimeOffset.MinValue;
		private bool _queueDispatchRunning;
		private PendingApprovalSnapshot? _pendingApproval;
		private RecoveryOfferSnapshot? _pendingRecoveryOffer;
		private TurnRetryOfferSnapshot? _pendingTurnRetryOffer;
		private RecoverableTurnReplaySnapshot? _recoverableTurn;
		private DateTimeOffset _lastRecoveryOfferDismissedUtc = DateTimeOffset.MinValue;
		private bool _isAppServerRecovering = AppServerRecovering;
		private SessionRateLimitSnapshot? _latestRateLimitSnapshot;

		public string? PendingApprovalId => PendingApprovals.Keys.FirstOrDefault();
		public string? PendingToolUserInputId => PendingToolUserInputs.Keys.FirstOrDefault();
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
					return _turnState != TurnLifecycleState.Idle;
				}
			}
		}

		public bool IsTurnInFlightRecoveredFromLogs
		{
			get
			{
				lock (_turnSync)
				{
					return _turnState == TurnLifecycleState.RunningRecovered;
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

		public bool IsAppServerRecovering
		{
			get
			{
				lock (_turnSync)
				{
					return _isAppServerRecovering;
				}
			}
		}

		public bool TryBeginAppServerRecovery()
		{
			lock (_turnSync)
			{
				if (_isAppServerRecovering)
				{
					return false;
				}

				_isAppServerRecovering = true;
				return true;
			}
		}

		public void MarkAppServerRecoveryComplete()
		{
			lock (_turnSync)
			{
				_isAppServerRecovering = false;
			}
		}

		public string? GetActiveCollaborationMode()
		{
			lock (_turnSync)
			{
				return _activeCollaborationMode;
			}
		}

		public string BuildTurnDebugSummary()
		{
			string? clientActiveTurnId = null;
			try
			{
				if (!Session.TryGetActiveTurnId(out clientActiveTurnId))
				{
					clientActiveTurnId = null;
				}
			}
			catch
			{
				clientActiveTurnId = null;
			}

			lock (_turnSync)
			{
				var nowUtc = DateTimeOffset.UtcNow;
				var stateAgeSeconds = Math.Round((nowUtc - _turnStateChangedUtc).TotalSeconds);
				var coreIdleSeconds = Math.Round((nowUtc - _lastCoreEventUtc).TotalSeconds);
				var lastCoreEventType = string.IsNullOrWhiteSpace(_lastCoreEventType) ? "(none)" : _lastCoreEventType;
				var lastCoreEventMessage = string.IsNullOrWhiteSpace(_lastCoreEventMessage) ? "(none)" : _lastCoreEventMessage;
				return
					$"turnState={_turnState} dispatchId={_activeDispatchId ?? "(none)"} activeTurnId={_activeTurnId ?? "(none)"} clientActiveTurnId={clientActiveTurnId ?? "(none)"} stateAgeSec={stateAgeSeconds:0} coreIdleSec={coreIdleSeconds:0} lastCoreType={lastCoreEventType} lastCoreMessage={lastCoreEventMessage} gateCount={_turnGate.CurrentCount} recovering={_isAppServerRecovering}";
			}
		}

		public string BuildRpcDebugSummary(int maxPending = 6)
		{
			CodexRpcDebugSnapshot snapshot;
			try
			{
				snapshot = Session.GetRpcDebugSnapshot(maxPending);
			}
			catch
			{
				return "rpcDebug=unavailable";
			}

			var nowUtc = DateTimeOffset.UtcNow;
			var pendingSummary = "(none)";
			var pendingRequests = snapshot.PendingRequests;
			if (pendingRequests is { Count: > 0 })
			{
				try
				{
					pendingSummary = string.Join(
						",",
						pendingRequests.Select(x =>
						{
							if (x is null)
							{
								return "(null-pending-request)";
							}

							var requestId = string.IsNullOrWhiteSpace(x.Id) ? "(missing-id)" : x.Id;
							var requestMethod = string.IsNullOrWhiteSpace(x.Method) ? "(missing-method)" : x.Method;
							var roundedAgeMs = Math.Round(x.AgeMs);
							if (double.IsNaN(roundedAgeMs) || double.IsInfinity(roundedAgeMs))
							{
								roundedAgeMs = -1;
							}

							return $"{requestId}:{requestMethod}:{roundedAgeMs:0}ms";
						}));
				}
				catch
				{
					pendingSummary = "(unavailable)";
				}
			}
			var stdinIdleSec = snapshot.LastStdinWriteUtc.HasValue ? Math.Round((nowUtc - snapshot.LastStdinWriteUtc.Value).TotalSeconds) : -1;
			var stdoutIdleSec = snapshot.LastStdoutReadUtc.HasValue ? Math.Round((nowUtc - snapshot.LastStdoutReadUtc.Value).TotalSeconds) : -1;
			var stderrIdleSec = snapshot.LastStderrReadUtc.HasValue ? Math.Round((nowUtc - snapshot.LastStderrReadUtc.Value).TotalSeconds) : -1;
			var stdoutPump = string.IsNullOrWhiteSpace(snapshot.StdoutPumpStopReason) ? "running" : snapshot.StdoutPumpStopReason;
			var stderrPump = string.IsNullOrWhiteSpace(snapshot.StderrPumpStopReason) ? "running" : snapshot.StderrPumpStopReason;
			var stdoutPumpStoppedSec = snapshot.StdoutPumpStoppedUtc.HasValue ? Math.Round((nowUtc - snapshot.StdoutPumpStoppedUtc.Value).TotalSeconds) : -1;
			var stderrPumpStoppedSec = snapshot.StderrPumpStoppedUtc.HasValue ? Math.Round((nowUtc - snapshot.StderrPumpStoppedUtc.Value).TotalSeconds) : -1;
			return
				$"rpcPending={snapshot.PendingCount} rpcPendingDetail={pendingSummary} rpcStdinIdleSec={stdinIdleSec:0} rpcStdoutIdleSec={stdoutIdleSec:0} rpcStderrIdleSec={stderrIdleSec:0} rpcStdoutPump={stdoutPump} rpcStdoutPumpStoppedSec={stdoutPumpStoppedSec:0} rpcStderrPump={stderrPump} rpcStderrPumpStoppedSec={stderrPumpStoppedSec:0}";
		}

		public bool TryGetCachedModels(out IReadOnlyList<CodexModelInfo> models, TimeSpan? maxAge = null)
		{
			lock (_modelsSync)
			{
				if (_cachedModels is null || _cachedModels.Count == 0)
				{
					models = Array.Empty<CodexModelInfo>();
					return false;
				}

				if (maxAge is TimeSpan ageLimit)
				{
					if (_cachedModelsFetchedUtc == DateTimeOffset.MinValue)
					{
						models = Array.Empty<CodexModelInfo>();
						return false;
					}

					var cacheAge = DateTimeOffset.UtcNow - _cachedModelsFetchedUtc;
					if (cacheAge > ageLimit)
					{
						models = Array.Empty<CodexModelInfo>();
						return false;
					}
				}

				models = _cachedModels.ToArray();
				return true;
			}
		}

		public async Task<IReadOnlyList<CodexModelInfo>> QueryModelsSerializedAsync(
			Func<CancellationToken, Task<IReadOnlyList<CodexModelInfo>>> fetchAsync,
			CancellationToken cancellationToken,
			TimeSpan? maxAge = null)
		{
			await _modelsListGate.WaitAsync(cancellationToken);
			try
			{
				if (TryGetCachedModels(out var cachedModels, maxAge))
				{
					return cachedModels;
				}

				var models = await fetchAsync(cancellationToken);
				lock (_modelsSync)
				{
					_cachedModels = models.ToArray();
					_cachedModelsFetchedUtc = DateTimeOffset.UtcNow;
				}

				return models;
			}
			finally
			{
				_modelsListGate.Release();
			}
		}

		public SessionSnapshot ToSnapshot(
			int turnCountInMemory,
			bool isTurnInFlightInferredFromLogs,
			bool isTurnInFlightLogOnly)
		{
			var queuedTurns = GetQueuedTurnSummaries();
			return new SessionSnapshot(
				SessionId,
				ThreadId: Session.ThreadId,
				Cwd,
				Model: CurrentModel,
				ReasoningEffort: CurrentReasoningEffort,
				ApprovalPolicy: CurrentApprovalPolicy,
				SandboxPolicy: CurrentSandboxPolicy,
				IsTurnInFlight: IsTurnInFlight,
				PendingApproval: GetPendingApproval(),
				PendingRecoveryOffer: GetPendingRecoveryOffer(),
				PendingTurnRetryOffer: GetPendingTurnRetryOffer(),
				QueuedTurnCount: queuedTurns.Count,
				QueuedTurns: queuedTurns,
				TurnCountInMemory: turnCountInMemory,
				IsTurnInFlightInferredFromLogs: isTurnInFlightInferredFromLogs,
				IsTurnInFlightLogOnly: isTurnInFlightLogOnly,
				IsAppServerRecovering: IsAppServerRecovering);
		}

		public void SetLatestRateLimitSnapshot(SessionRateLimitSnapshot snapshot)
		{
			lock (_turnSync)
			{
				_latestRateLimitSnapshot = snapshot;
			}
		}

		public SessionRateLimitSnapshot? GetLatestRateLimitSnapshot()
		{
			lock (_turnSync)
			{
				return _latestRateLimitSnapshot;
			}
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

		public void SetApprovalPolicy(string? approvalPolicy)
		{
			lock (_turnSync)
			{
				_approvalPolicy = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy);
			}
		}

		public void SetSandboxPolicy(string? sandboxPolicy)
		{
			lock (_turnSync)
			{
				_sandboxPolicy = WebCodexUtils.NormalizeSandboxMode(sandboxPolicy);
			}
		}

		private IReadOnlyList<QueuedTurnSummarySnapshot> GetQueuedTurnSummaries()
		{
			lock (_queueSync)
			{
				return _queuedTurns
					.Select(item => new QueuedTurnSummarySnapshot(
						QueueItemId: item.QueueItemId,
						PreviewText: BuildQueuedTurnPreview(item.Text, item.Images.Count),
						ImageCount: item.Images.Count,
						CreatedAtUtc: item.CreatedAtUtc))
					.ToArray();
			}
		}

		internal void EnqueueQueuedTurn(QueuedTurn queuedTurn)
		{
			lock (_queueSync)
			{
				_queuedTurns.Add(queuedTurn);
			}
		}

		internal bool TryRemoveQueuedTurn(string queueItemId, out QueuedTurn? removed)
		{
			removed = null;
			lock (_queueSync)
			{
				var index = _queuedTurns.FindIndex(x => string.Equals(x.QueueItemId, queueItemId, StringComparison.Ordinal));
				if (index < 0)
				{
					return false;
				}

				removed = _queuedTurns[index];
				_queuedTurns.RemoveAt(index);
				return true;
			}
		}

		internal bool TryPopQueuedTurn(string queueItemId, out QueuedTurn? queuedTurn)
		{
			return TryRemoveQueuedTurn(queueItemId, out queuedTurn);
		}

		internal bool TryPopNextQueuedTurn(out QueuedTurn? queuedTurn)
		{
			queuedTurn = null;
			lock (_queueSync)
			{
				if (_queuedTurns.Count == 0)
				{
					return false;
				}

				queuedTurn = _queuedTurns[0];
				_queuedTurns.RemoveAt(0);
				return true;
			}
		}

		internal IReadOnlyList<QueuedTurn> GetQueuedTurnsSnapshot()
		{
			lock (_queueSync)
			{
				return _queuedTurns.ToList();
			}
		}

		internal void ReplaceQueuedTurns(IReadOnlyList<QueuedTurn> queuedTurns)
		{
			lock (_queueSync)
			{
				_queuedTurns.Clear();
				if (queuedTurns is null || queuedTurns.Count == 0)
				{
					return;
				}

				_queuedTurns.AddRange(queuedTurns);
			}
		}

		internal void RequeueQueuedTurnFront(QueuedTurn queuedTurn)
		{
			lock (_queueSync)
			{
				_queuedTurns.Insert(0, queuedTurn);
			}
		}

		internal bool HasQueuedTurns()
		{
			lock (_queueSync)
			{
				return _queuedTurns.Count > 0;
			}
		}

		internal bool TryMarkQueueDispatchStarted()
		{
			lock (_queueSync)
			{
				if (_queueDispatchRunning)
				{
					return false;
				}

				_queueDispatchRunning = true;
				return true;
			}
		}

		internal void MarkQueueDispatchStopped()
		{
			lock (_queueSync)
			{
				_queueDispatchRunning = false;
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
					var normalizedApproval = WebCodexUtils.NormalizeApprovalPolicy(approvalPolicy);
					if (!string.Equals(_approvalPolicy, normalizedApproval, StringComparison.Ordinal))
					{
						_approvalPolicy = normalizedApproval;
						changed = true;
					}
				}

				if (sandboxPolicy is not null)
				{
					var normalizedSandbox = WebCodexUtils.NormalizeSandboxMode(sandboxPolicy);
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

		public string? ResolveActiveTurnId()
		{
			if (Session.TryGetActiveTurnId(out var activeFromClient) && !string.IsNullOrWhiteSpace(activeFromClient))
			{
				lock (_turnSync)
				{
					_activeTurnId = activeFromClient;
				}
				return activeFromClient;
			}

			lock (_turnSync)
			{
				return _activeTurnId;
			}
		}

		public bool IsRecoveredTurnStale(TimeSpan staleAfter, out TimeSpan recoveredAge)
		{
			recoveredAge = TimeSpan.Zero;
			lock (_turnSync)
			{
				if (_turnState != TurnLifecycleState.RunningRecovered)
				{
					return false;
				}

				recoveredAge = DateTimeOffset.UtcNow - _turnStateChangedUtc;
				return recoveredAge >= staleAfter;
			}
		}

		public bool IsLocalTurnAwaitingStartStale(TimeSpan staleAfter, out TimeSpan pendingAge)
		{
			pendingAge = TimeSpan.Zero;
			lock (_turnSync)
			{
				if (_turnState != TurnLifecycleState.RunningLocal)
				{
					return false;
				}

				if (!string.IsNullOrWhiteSpace(_activeTurnId))
				{
					return false;
				}

				if (Session.TryGetActiveTurnId(out var activeFromClient) && !string.IsNullOrWhiteSpace(activeFromClient))
				{
					_activeTurnId = activeFromClient;
					return false;
				}

				pendingAge = DateTimeOffset.UtcNow - _turnStateChangedUtc;
				return pendingAge >= staleAfter;
			}
		}

		public bool IsLocalStartedTurnStale(TimeSpan staleAfter, out TimeSpan silentAge)
		{
			silentAge = TimeSpan.Zero;
			lock (_turnSync)
			{
				if (_turnState != TurnLifecycleState.RunningLocal)
				{
					return false;
				}

				if (string.IsNullOrWhiteSpace(_activeTurnId))
				{
					if (Session.TryGetActiveTurnId(out var activeFromClient) && !string.IsNullOrWhiteSpace(activeFromClient))
					{
						_activeTurnId = activeFromClient;
					}
					else
					{
						return false;
					}
				}

				var lastActivityUtc = _lastCoreEventUtc > _turnStateChangedUtc
					? _lastCoreEventUtc
					: _turnStateChangedUtc;
				silentAge = DateTimeOffset.UtcNow - lastActivityUtc;
				return silentAge >= staleAfter;
			}
		}

		private static string? NormalizeCoreDebugValue(string? value, int maxLength)
		{
			if (string.IsNullOrWhiteSpace(value))
			{
				return null;
			}

			var normalized = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
			if (normalized.Length > maxLength)
			{
				normalized = normalized[..maxLength] + "...";
			}

			return normalized.Replace(' ', '_');
		}

		public void MarkCoreEventObserved(string? coreEventType = null, string? coreEventMessage = null)
		{
			lock (_turnSync)
			{
				_lastCoreEventUtc = DateTimeOffset.UtcNow;
				_lastCoreEventType = NormalizeCoreDebugValue(coreEventType, 64) ?? _lastCoreEventType;
				_lastCoreEventMessage = NormalizeCoreDebugValue(coreEventMessage, 140) ?? _lastCoreEventMessage;
			}
		}

		public bool ShouldBroadcastCoreIssue(string issueKey, TimeSpan minimumInterval)
		{
			if (string.IsNullOrWhiteSpace(issueKey))
			{
				return false;
			}

			lock (_turnSync)
			{
				var nowUtc = DateTimeOffset.UtcNow;
				if (string.Equals(_lastBroadcastCoreIssueKey, issueKey, StringComparison.Ordinal) &&
					nowUtc - _lastBroadcastCoreIssueUtc < minimumInterval)
				{
					return false;
				}

				_lastBroadcastCoreIssueKey = issueKey;
				_lastBroadcastCoreIssueUtc = nowUtc;
				return true;
			}
		}

		private void SetTurnState(TurnLifecycleState state)
		{
			_turnState = state;
			_turnStateChangedUtc = DateTimeOffset.UtcNow;
		}

		public async Task<bool> TryWaitForTurnSlotAsync(TimeSpan timeout, CancellationToken cancellationToken)
		{
			if (IsAppServerRecovering)
			{
				return false;
			}

			var waitingOnRecoveredExternalTurn = false;
			lock (_turnSync)
			{
				// External signal recovery can mark a turn as active without owning the semaphore slot.
				// Keep queueing blocked until a matching completion signal clears in-flight state.
				if (_turnState == TurnLifecycleState.RunningRecovered)
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
				if (_turnState == TurnLifecycleState.RunningLocal)
				{
					_activeTurnCts = null;
					SetTurnState(TurnLifecycleState.RunningRecovered);
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
				if (_turnState != TurnLifecycleState.Idle)
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

		public bool TryMarkTurnStarted(CancellationTokenSource turnCts, string? collaborationMode, string? dispatchId)
		{
			lock (_turnSync)
			{
				if (_turnState != TurnLifecycleState.Idle)
				{
					if (string.IsNullOrWhiteSpace(_activeTurnId) &&
						Session.TryGetActiveTurnId(out var currentTurnId) &&
						!string.IsNullOrWhiteSpace(currentTurnId))
					{
						_activeTurnId = currentTurnId;
					}

					return false;
				}

				_activeTurnCts = turnCts;
				_activeDispatchId = string.IsNullOrWhiteSpace(dispatchId) ? null : dispatchId.Trim();
				_activeTurnId = Session.TryGetActiveTurnId(out var activeFromClient) ? activeFromClient : _activeTurnId;
				if (!string.IsNullOrWhiteSpace(_activeTurnId))
				{
					MarkRecoverableTurnStartAcknowledged(_activeDispatchId);
				}
				_activeCollaborationMode = WebCodexUtils.NormalizeCollaborationMode(collaborationMode);
				_lastCoreEventUtc = DateTimeOffset.UtcNow;
				_lastCoreEventType = null;
				_lastCoreEventMessage = null;
				_pendingRecoveryOffer = null;
				_pendingTurnRetryOffer = null;
				_recoverableTurn = null;
				SetTurnState(TurnLifecycleState.RunningLocal);
				return true;
			}
		}

		public bool TryMarkTurnStartedFromCoreSignal(string turnId)
		{
			var normalizedTurnId = turnId?.Trim();
			if (string.IsNullOrWhiteSpace(normalizedTurnId))
			{
				return false;
			}

			lock (_turnSync)
			{
				if (_turnState != TurnLifecycleState.Idle)
				{
					if (string.IsNullOrWhiteSpace(_activeTurnId))
					{
						_activeTurnId = normalizedTurnId;
					}
					MarkRecoverableTurnStartAcknowledged(_activeDispatchId);
					return false;
				}

				_activeTurnCts = null;
				_activeDispatchId = null;
				_activeTurnId = normalizedTurnId;
				_pendingRecoveryOffer = null;
				_pendingTurnRetryOffer = null;
				_recoverableTurn = null;
				MarkRecoverableTurnStartAcknowledged();
				SetTurnState(TurnLifecycleState.RunningRecovered);
				return true;
			}
		}

		public bool TryMarkTurnStartedFromClientState(out string? recoveredTurnId)
		{
			recoveredTurnId = null;
			if (!Session.TryGetActiveTurnId(out var activeFromClient) || string.IsNullOrWhiteSpace(activeFromClient))
			{
				return false;
			}

			var normalizedTurnId = activeFromClient.Trim();
			lock (_turnSync)
			{
				if (_turnState != TurnLifecycleState.Idle)
				{
					if (string.IsNullOrWhiteSpace(_activeTurnId))
					{
						_activeTurnId = normalizedTurnId;
					}
					MarkRecoverableTurnStartAcknowledged(_activeDispatchId);

					recoveredTurnId = _activeTurnId;
					return false;
				}

				_activeTurnCts = null;
				_activeDispatchId = null;
				_activeTurnId = normalizedTurnId;
				_pendingRecoveryOffer = null;
				_pendingTurnRetryOffer = null;
				_recoverableTurn = null;
				MarkRecoverableTurnStartAcknowledged();
				SetTurnState(TurnLifecycleState.RunningRecovered);
				recoveredTurnId = normalizedTurnId;
				return true;
			}
		}

		public bool TryMarkTurnCompletedFromCoreSignal()
		{
			var shouldRelease = false;
			lock (_turnSync)
			{
				if (_turnState == TurnLifecycleState.Idle)
				{
					return false;
				}

				shouldRelease = _turnState == TurnLifecycleState.RunningLocal;
				_activeTurnCts = null;
				_activeDispatchId = null;
				_activeTurnId = null;
				_activeCollaborationMode = null;
				_pendingRecoveryOffer = null;
				_pendingTurnRetryOffer = null;
				_recoverableTurn = null;
				SetTurnState(TurnLifecycleState.Idle);
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

		public void TrySetActiveCollaborationModeIfInFlight(string? mode)
		{
			var normalized = WebCodexUtils.NormalizeCollaborationMode(mode);
			if (string.IsNullOrWhiteSpace(normalized))
			{
				return;
			}

			lock (_turnSync)
			{
				if (_turnState == TurnLifecycleState.Idle)
				{
					return;
				}

				_activeCollaborationMode = normalized;
			}
		}

		public (bool HadTurnInFlight, bool HadActiveTurnToken, int ClearedQueuedTurnCount) ForceResetTurnState(bool clearQueuedTurns, bool preserveRecoverableTurn = false)
		{
			CancellationTokenSource? activeTurnCts = null;
			var shouldRelease = false;
			bool hadTurnInFlight;
			bool hadActiveTurnToken;

			lock (_turnSync)
			{
				hadTurnInFlight = _turnState != TurnLifecycleState.Idle;
				shouldRelease = _turnState == TurnLifecycleState.RunningLocal;
				activeTurnCts = _activeTurnCts;
				hadActiveTurnToken = activeTurnCts is not null;
				_activeTurnCts = null;
				_activeDispatchId = null;
				_activeTurnId = null;
				_activeCollaborationMode = null;
				_pendingRecoveryOffer = null;
				if (!preserveRecoverableTurn)
				{
					_pendingTurnRetryOffer = null;
					_recoverableTurn = null;
				}
				SetTurnState(TurnLifecycleState.Idle);
			}

			if (activeTurnCts is not null)
			{
				try
				{
					activeTurnCts.Cancel();
				}
				catch
				{
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

			var clearedQueuedTurnCount = 0;
			if (clearQueuedTurns)
			{
				lock (_queueSync)
				{
					clearedQueuedTurnCount = _queuedTurns.Count;
					if (clearedQueuedTurnCount > 0)
					{
						_queuedTurns.Clear();
					}
				}
			}

			return (hadTurnInFlight, hadActiveTurnToken, clearedQueuedTurnCount);
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
			try { ClientLifetimeCts?.Cancel(); } catch { }
			try { ClientLifetimeCts?.Dispose(); } catch { }
		}

		public PendingApprovalSnapshot? GetPendingApproval()
		{
			lock (_approvalSync)
			{
				return _pendingApproval;
			}
		}

		public RecoveryOfferSnapshot? GetPendingRecoveryOffer()
		{
			lock (_turnSync)
			{
				return _pendingRecoveryOffer;
			}
		}

		public TurnRetryOfferSnapshot? GetPendingTurnRetryOffer()
		{
			lock (_turnSync)
			{
				return _pendingTurnRetryOffer;
			}
		}

		public void RememberRecoverableTurn(
			string dispatchId,
			string text,
			string? cwd,
			IReadOnlyList<CodexUserImageInput>? images,
			CodexCollaborationMode? collaborationMode,
			string? model,
			string? reasoningEffort,
			string? approvalPolicy,
			string? sandboxPolicy)
		{
			var normalizedDispatchId = dispatchId?.Trim();
			if (string.IsNullOrWhiteSpace(normalizedDispatchId))
			{
				return;
			}

			var safeText = text ?? string.Empty;
			var safeCwd = string.IsNullOrWhiteSpace(cwd) ? null : cwd.Trim();
			var safeImages = images is null
				? Array.Empty<CodexUserImageInput>()
				: images
					.Where(x => x is not null && !string.IsNullOrWhiteSpace(x.Url))
					.Select(x => new CodexUserImageInput(x.Url))
					.ToArray();
			var safeCollaborationMode = collaborationMode is null
				? null
				: new CodexCollaborationMode
				{
					Mode = collaborationMode.Mode
				};

			lock (_turnSync)
			{
				_recoverableTurn = new RecoverableTurnReplaySnapshot(
					DispatchId: normalizedDispatchId,
					Text: safeText,
					Cwd: safeCwd,
					Images: safeImages,
					CollaborationMode: safeCollaborationMode,
					Model: string.IsNullOrWhiteSpace(model) ? null : model.Trim(),
					ReasoningEffort: string.IsNullOrWhiteSpace(reasoningEffort) ? null : reasoningEffort.Trim(),
					ApprovalPolicy: string.IsNullOrWhiteSpace(approvalPolicy) ? null : approvalPolicy.Trim(),
					SandboxPolicy: string.IsNullOrWhiteSpace(sandboxPolicy) ? null : sandboxPolicy.Trim(),
					StartAcknowledged: false,
					StaleStartCanceled: false,
					CreatedAtUtc: DateTimeOffset.UtcNow,
					StaleCanceledAtUtc: null,
					RetryOffered: false);
				_pendingTurnRetryOffer = null;
			}
		}

		public void MarkRecoverableTurnStartAcknowledged(string? dispatchId = null)
		{
			lock (_turnSync)
			{
				if (_recoverableTurn is null)
				{
					return;
				}

				if (!string.IsNullOrWhiteSpace(dispatchId) &&
					!string.Equals(_recoverableTurn.DispatchId, dispatchId.Trim(), StringComparison.Ordinal))
				{
					return;
				}

				_recoverableTurn = _recoverableTurn with
				{
					StartAcknowledged = true
				};
			}
		}

		public bool TryMarkRecoverableTurnStaleStartCanceled(string dispatchId, out RecoverableTurnReplaySnapshot? snapshot)
		{
			snapshot = null;
			var normalizedDispatchId = dispatchId?.Trim();
			if (string.IsNullOrWhiteSpace(normalizedDispatchId))
			{
				return false;
			}

			lock (_turnSync)
			{
				if (_recoverableTurn is null)
				{
					return false;
				}

				if (!string.Equals(_recoverableTurn.DispatchId, normalizedDispatchId, StringComparison.Ordinal))
				{
					return false;
				}

				if (_recoverableTurn.StartAcknowledged)
				{
					return false;
				}

				_recoverableTurn = _recoverableTurn with
				{
					StaleStartCanceled = true,
					StaleCanceledAtUtc = DateTimeOffset.UtcNow
				};
				snapshot = _recoverableTurn;
				return true;
			}
		}

		public RecoverableTurnReplaySnapshot? GetRecoverableTurnSnapshot()
		{
			lock (_turnSync)
			{
				return _recoverableTurn;
			}
		}

		public void RestoreRecoverableTurnSnapshot(RecoverableTurnReplaySnapshot? snapshot)
		{
			lock (_turnSync)
			{
				_recoverableTurn = snapshot;
				if (snapshot is null)
				{
					_pendingTurnRetryOffer = null;
				}
			}
		}

		public bool TryCreateTurnRetryOfferAfterRecovery(out TurnRetryOfferSnapshot? offer)
		{
			offer = null;
			lock (_turnSync)
			{
				if (_recoverableTurn is null)
				{
					return false;
				}

				if (_recoverableTurn.StartAcknowledged || !_recoverableTurn.StaleStartCanceled)
				{
					return false;
				}

				if (_pendingTurnRetryOffer is not null)
				{
					offer = _pendingTurnRetryOffer;
					return false;
				}

				if (_recoverableTurn.RetryOffered)
				{
					return false;
				}

				var pendingSeconds = _recoverableTurn.StaleCanceledAtUtc.HasValue
					? Math.Max(0, Math.Round((DateTimeOffset.UtcNow - _recoverableTurn.StaleCanceledAtUtc.Value).TotalSeconds))
					: 0;
				offer = new TurnRetryOfferSnapshot(
					OfferId: Guid.NewGuid().ToString("N"),
					Message: "Codex disconnected before the turn started. Retry the last prompt now?",
					PendingSeconds: pendingSeconds,
					CreatedAtUtc: DateTimeOffset.UtcNow,
					DispatchId: _recoverableTurn.DispatchId,
					TextChars: string.IsNullOrWhiteSpace(_recoverableTurn.Text) ? 0 : _recoverableTurn.Text.Trim().Length,
					ImageCount: _recoverableTurn.Images.Count,
					Model: _recoverableTurn.Model,
					ReasoningEffort: _recoverableTurn.ReasoningEffort,
					ApprovalPolicy: _recoverableTurn.ApprovalPolicy,
					SandboxPolicy: _recoverableTurn.SandboxPolicy);
				_pendingTurnRetryOffer = offer;
				_recoverableTurn = _recoverableTurn with
				{
					RetryOffered = true
				};
				return true;
			}
		}

		public bool TryConsumeTurnRetryOffer(string? offerId, out TurnRetryOfferSnapshot? offer, out RecoverableTurnReplaySnapshot? replay)
		{
			offer = null;
			replay = null;
			lock (_turnSync)
			{
				if (_pendingTurnRetryOffer is null || _recoverableTurn is null)
				{
					return false;
				}

				if (!string.IsNullOrWhiteSpace(offerId) &&
					!string.Equals(_pendingTurnRetryOffer.OfferId, offerId.Trim(), StringComparison.Ordinal))
				{
					return false;
				}

				offer = _pendingTurnRetryOffer;
				replay = _recoverableTurn;
				_pendingTurnRetryOffer = null;
				return true;
			}
		}

		public bool TryDismissTurnRetryOffer(string? offerId, out TurnRetryOfferSnapshot? offer)
		{
			offer = null;
			lock (_turnSync)
			{
				if (_pendingTurnRetryOffer is null)
				{
					return false;
				}

				if (!string.IsNullOrWhiteSpace(offerId) &&
					!string.Equals(_pendingTurnRetryOffer.OfferId, offerId.Trim(), StringComparison.Ordinal))
				{
					return false;
				}

				offer = _pendingTurnRetryOffer;
				_pendingTurnRetryOffer = null;
				_recoverableTurn = null;
				return true;
			}
		}

		public void ClearRecoverableTurn(string? dispatchId = null)
		{
			lock (_turnSync)
			{
				if (_recoverableTurn is null)
				{
					_pendingTurnRetryOffer = null;
					return;
				}

				if (!string.IsNullOrWhiteSpace(dispatchId) &&
					!string.Equals(_recoverableTurn.DispatchId, dispatchId.Trim(), StringComparison.Ordinal))
				{
					return;
				}

				_pendingTurnRetryOffer = null;
				_recoverableTurn = null;
			}
		}

		public bool TryCreateRecoveryOffer(
			string reason,
			string message,
			TimeSpan pendingAge,
			out RecoveryOfferSnapshot? offer)
		{
			offer = null;
			lock (_turnSync)
			{
				if (_pendingRecoveryOffer is not null)
				{
					offer = _pendingRecoveryOffer;
					return false;
				}

				var nowUtc = DateTimeOffset.UtcNow;
				if (nowUtc - _lastRecoveryOfferDismissedUtc < TimeSpan.FromSeconds(30))
				{
					return false;
				}

				string? activeTurnId = _activeTurnId;
				if (string.IsNullOrWhiteSpace(activeTurnId) &&
					Session.TryGetActiveTurnId(out var activeFromClient) &&
					!string.IsNullOrWhiteSpace(activeFromClient))
				{
					activeTurnId = activeFromClient;
				}

				offer = new RecoveryOfferSnapshot(
					OfferId: Guid.NewGuid().ToString("N"),
					Reason: reason,
					Message: message,
					PendingSeconds: Math.Max(0, Math.Round(pendingAge.TotalSeconds)),
					CreatedAtUtc: nowUtc,
					DispatchId: _activeDispatchId,
					ActiveTurnId: activeTurnId);
				_pendingRecoveryOffer = offer;
				return true;
			}
		}

		public bool TryConsumeRecoveryOffer(string? offerId, out RecoveryOfferSnapshot? offer)
		{
			offer = null;
			lock (_turnSync)
			{
				if (_pendingRecoveryOffer is null)
				{
					return false;
				}

				if (!string.IsNullOrWhiteSpace(offerId) &&
					!string.Equals(_pendingRecoveryOffer.OfferId, offerId.Trim(), StringComparison.Ordinal))
				{
					return false;
				}

				offer = _pendingRecoveryOffer;
				_pendingRecoveryOffer = null;
				return true;
			}
		}

		public bool TryDismissRecoveryOffer(string? offerId, out RecoveryOfferSnapshot? offer)
		{
			offer = null;
			lock (_turnSync)
			{
				if (_pendingRecoveryOffer is null)
				{
					return false;
				}

				if (!string.IsNullOrWhiteSpace(offerId) &&
					!string.Equals(_pendingRecoveryOffer.OfferId, offerId.Trim(), StringComparison.Ordinal))
				{
					return false;
				}

				offer = _pendingRecoveryOffer;
				_pendingRecoveryOffer = null;
				_lastRecoveryOfferDismissedUtc = DateTimeOffset.UtcNow;
				return true;
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

