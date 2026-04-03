using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed class ReviewStore
{
	private const string ReviewMetadataHeader = "[Review metadata]";
	private const string ReviewMetadataFooter = "[/Review metadata]";
	private static readonly TimeSpan RunningStaleAfter = TimeSpan.FromMinutes(8);
	private static readonly TimeSpan QueuedStaleAfter = TimeSpan.FromMinutes(20);
	private readonly object _sync = new();
	private readonly string _storagePath;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
	{
		WriteIndented = true
	};
	private List<ReviewRecord> _records = new();

	public ReviewStore(WebRuntimeDefaults defaults)
	{
		var root = Path.Combine(
			Path.GetDirectoryName(defaults.LogRootPath) ?? defaults.LogRootPath,
			"reviews");
		Directory.CreateDirectory(root);
		_storagePath = Path.Combine(root, "registry.json");
		_records = Load();
	}

	public ReviewCreateResult CreateReview(ReviewCreateRequest request)
	{
		var normalized = NormalizeCreateRequest(request);
		var now = DateTimeOffset.UtcNow;
		var reviewId = $"review_{Guid.NewGuid():N}";
		var promptText = BuildPromptText(reviewId, normalized);
		var record = new ReviewRecord
		{
			ReviewId = reviewId,
			ThreadId = normalized.ThreadId,
			SessionId = normalized.SessionId,
			Cwd = normalized.Cwd,
			TargetType = normalized.TargetType,
			CommitSha = normalized.CommitSha,
			CommitSubject = normalized.CommitSubject,
			ContextLabel = normalized.ContextLabel,
			VisibleFiles = normalized.VisibleFiles,
			TotalFiles = normalized.TotalFiles,
			HiddenBinaryFiles = normalized.HiddenBinaryFiles,
			NoteText = normalized.NoteText,
			PromptText = promptText,
			Status = normalized.InitialStatus,
			QueuedAtUtc = now,
			StartedAtUtc = string.Equals(normalized.InitialStatus, "running", StringComparison.Ordinal) ? now : null,
			TurnId = string.Empty
		};

		lock (_sync)
		{
			_records.Add(record);
			SaveNoLock();
		}

		return new ReviewCreateResult(record.Clone(), promptText);
	}

	public bool TryMarkRunningFromPromptText(string? promptText, string? sessionId, string? threadId, string? turnId = null)
	{
		var metadata = ParseReviewMetadata(promptText);
		if (metadata is null)
		{
			return false;
		}

		lock (_sync)
		{
			var record = _records.FirstOrDefault(x => string.Equals(x.ReviewId, metadata.ReviewId, StringComparison.Ordinal));
			if (record is null)
			{
				return false;
			}

			return ApplyRunningStateNoLock(
				record,
				sessionId,
				threadId,
				turnId,
				DateTimeOffset.UtcNow);
		}
	}

	public bool TryBindTurnToNextActiveReview(string? sessionId, string? threadId, string? turnId)
	{
		var normalizedSessionId = sessionId?.Trim() ?? string.Empty;
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		var normalizedTurnId = turnId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedTurnId))
		{
			return false;
		}

		lock (_sync)
		{
			var record = _records
				.Where(x =>
					!IsTerminalStatus(NormalizeStatus(x.Status)) &&
					string.IsNullOrWhiteSpace(x.TurnId) &&
					(string.IsNullOrWhiteSpace(normalizedSessionId) || string.Equals(x.SessionId, normalizedSessionId, StringComparison.Ordinal)) &&
					(string.IsNullOrWhiteSpace(normalizedThreadId) || string.Equals(x.ThreadId, normalizedThreadId, StringComparison.Ordinal)))
				.OrderBy(x => x.QueuedAtUtc)
				.ThenBy(x => x.ReviewId, StringComparer.Ordinal)
				.FirstOrDefault();
			if (record is null)
			{
				return false;
			}

			return ApplyRunningStateNoLock(
				record,
				normalizedSessionId,
				normalizedThreadId,
				normalizedTurnId,
				DateTimeOffset.UtcNow);
		}
	}

	public bool TryCompleteFromPromptText(
		string? promptText,
		string? sessionId,
		string? threadId,
		string? turnId,
		string? resultStatus,
		string? assistantText)
	{
		var metadata = ParseReviewMetadata(promptText);
		if (metadata is null)
		{
			return false;
		}

		lock (_sync)
		{
			var record = _records.FirstOrDefault(x => string.Equals(x.ReviewId, metadata.ReviewId, StringComparison.Ordinal));
			if (record is null)
			{
				return false;
			}

			return ApplyCompletionStateNoLock(
				record,
				sessionId,
				threadId,
				turnId,
				resultStatus,
				assistantText,
				DateTimeOffset.UtcNow);
		}
	}

	public bool TryCompleteByTurn(
		string? sessionId,
		string? threadId,
		string? turnId,
		string? resultStatus,
		string? assistantText)
	{
		var normalizedTurnId = turnId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedTurnId))
		{
			return false;
		}

		var normalizedSessionId = sessionId?.Trim() ?? string.Empty;
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		lock (_sync)
		{
			var record = _records.FirstOrDefault(x =>
				string.Equals(x.TurnId, normalizedTurnId, StringComparison.Ordinal) &&
				(string.IsNullOrWhiteSpace(normalizedSessionId) || string.Equals(x.SessionId, normalizedSessionId, StringComparison.Ordinal)) &&
				(string.IsNullOrWhiteSpace(normalizedThreadId) || string.Equals(x.ThreadId, normalizedThreadId, StringComparison.Ordinal)));
			if (record is null)
			{
				return false;
			}

			return ApplyCompletionStateNoLock(
				record,
				normalizedSessionId,
				normalizedThreadId,
				normalizedTurnId,
				resultStatus,
				assistantText,
				DateTimeOffset.UtcNow);
		}
	}

	public bool TryUpdateStatus(string reviewId, string status)
	{
		var normalizedReviewId = reviewId?.Trim() ?? string.Empty;
		var normalizedStatus = NormalizeStatus(status);
		if (string.IsNullOrWhiteSpace(normalizedReviewId) || string.IsNullOrWhiteSpace(normalizedStatus))
		{
			return false;
		}

		lock (_sync)
		{
			var record = _records.FirstOrDefault(x => string.Equals(x.ReviewId, normalizedReviewId, StringComparison.Ordinal));
			if (record is null)
			{
				return false;
			}

			var currentStatus = NormalizeStatus(record.Status);
			if (!IsAllowedTransition(currentStatus, normalizedStatus))
			{
				return false;
			}

			var now = DateTimeOffset.UtcNow;
			var changed = !string.Equals(currentStatus, normalizedStatus, StringComparison.Ordinal);
			if (string.Equals(normalizedStatus, "running", StringComparison.Ordinal))
			{
				if (record.StartedAtUtc is null)
				{
					record.StartedAtUtc = now;
					changed = true;
				}
				record.CompletedAtUtc = null;
			}
			else if (IsTerminalStatus(normalizedStatus))
			{
				if (record.StartedAtUtc is null)
				{
					record.StartedAtUtc = now;
					changed = true;
				}
				if (record.CompletedAtUtc is null)
				{
					record.CompletedAtUtc = now;
					changed = true;
				}
			}
			else if (string.Equals(normalizedStatus, "queued", StringComparison.Ordinal))
			{
				record.CompletedAtUtc = null;
			}

			if (!changed)
			{
				return false;
			}

			record.Status = normalizedStatus;
			SaveNoLock();
			return true;
		}
	}

	public bool TrySetFindingState(string reviewId, string findingKey, bool done)
	{
		var normalizedReviewId = reviewId?.Trim() ?? string.Empty;
		var normalizedFindingKey = findingKey?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedReviewId) || string.IsNullOrWhiteSpace(normalizedFindingKey))
		{
			return false;
		}

		lock (_sync)
		{
			var record = _records.FirstOrDefault(x => string.Equals(x.ReviewId, normalizedReviewId, StringComparison.Ordinal));
			if (record is null)
			{
				return false;
			}

			if (done)
			{
				if (!record.DismissedFindingKeys.Contains(normalizedFindingKey, StringComparer.Ordinal))
				{
					record.DismissedFindingKeys.Add(normalizedFindingKey);
				}
			}
			else
			{
				record.DismissedFindingKeys.RemoveAll(x => string.Equals(x, normalizedFindingKey, StringComparison.Ordinal));
			}

			SaveNoLock();
			return true;
		}
	}

	public int ClearDismissedFindings(string reviewId)
	{
		var normalizedReviewId = reviewId?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedReviewId))
		{
			return 0;
		}

		lock (_sync)
		{
			var record = _records.FirstOrDefault(x => string.Equals(x.ReviewId, normalizedReviewId, StringComparison.Ordinal));
			if (record is null)
			{
				return 0;
			}

			var count = record.DismissedFindingKeys.Count;
			if (count <= 0)
			{
				return 0;
			}

			record.DismissedFindingKeys.Clear();
			SaveNoLock();
			return count;
		}
	}

	public ReviewCatalogSnapshot GetCatalog(string cwd, SessionOrchestrator orchestrator)
	{
		var normalizedCwd = NormalizeCwd(cwd);
		if (string.IsNullOrWhiteSpace(normalizedCwd))
		{
			throw new InvalidOperationException("cwd is required.");
		}

		List<ReviewRecord> scoped;
		lock (_sync)
		{
			scoped = _records
				.Where(x => string.Equals(x.Cwd, normalizedCwd, StringComparison.OrdinalIgnoreCase))
				.Select(x => x.Clone())
				.ToList();
		}

		var threadIds = scoped
			.Select(x => x.ThreadId)
			.Where(x => !string.IsNullOrWhiteSpace(x))
			.Distinct(StringComparer.Ordinal)
			.ToArray();
		var turnsByThread = new Dictionary<string, IReadOnlyList<SessionOrchestrator.ConsolidatedTurnSnapshot>>(StringComparer.Ordinal);
		foreach (var threadId in threadIds)
		{
			try
			{
				var watch = orchestrator.WatchTurns(threadId, maxEntries: 6000, initial: true, cursor: null, includeActiveTurnDetail: false);
				turnsByThread[threadId] = watch.Turns ?? Array.Empty<SessionOrchestrator.ConsolidatedTurnSnapshot>();
			}
			catch
			{
				turnsByThread[threadId] = Array.Empty<SessionOrchestrator.ConsolidatedTurnSnapshot>();
			}
		}

		var changed = false;
		foreach (var record in scoped)
		{
			if (!turnsByThread.TryGetValue(record.ThreadId, out var turns))
			{
				continue;
			}

			var changedThisRecord = ReconcileRecordFromTurns(record, turns);
			changed = changed || changedThisRecord;
		}

		if (changed)
		{
			lock (_sync)
			{
				var byId = scoped.ToDictionary(x => x.ReviewId, StringComparer.Ordinal);
				for (var i = 0; i < _records.Count; i += 1)
				{
					if (byId.TryGetValue(_records[i].ReviewId, out var updated))
					{
						_records[i] = updated.Clone();
					}
				}
				SaveNoLock();
			}
		}

		var snapshots = scoped
			.OrderByDescending(x => x.CompletedAtUtc ?? x.StartedAtUtc ?? x.QueuedAtUtc)
			.ThenByDescending(x => x.ReviewId, StringComparer.Ordinal)
			.Select(ToSnapshot)
			.ToArray();
		return new ReviewCatalogSnapshot(normalizedCwd, snapshots);
	}

	private bool ReconcileRecordFromTurns(ReviewRecord record, IReadOnlyList<SessionOrchestrator.ConsolidatedTurnSnapshot> turns)
	{
		if (turns is null || turns.Count == 0)
		{
			return ReconcileWithoutTurnMatch(record);
		}

		var matchedTurn = FindLatestMatchingTurn(record, turns);
		if (matchedTurn is null)
		{
			return ReconcileWithoutTurnMatch(record);
		}

		var turn = matchedTurn;
		var currentStatus = NormalizeStatus(record.Status);
		var assistantText = turn.AssistantFinal?.Text ?? record.AssistantText ?? string.Empty;
		var hasAssistantFinal = turn.AssistantFinal is not null && !string.IsNullOrWhiteSpace(turn.AssistantFinal?.Text);
		var nextStatus = currentStatus;
		if (!IsTerminalStatus(currentStatus) && !string.Equals(currentStatus, "dismissed", StringComparison.Ordinal))
		{
			if (hasAssistantFinal)
			{
				nextStatus = "completed";
			}
			else if (turn.IsInFlight)
			{
				nextStatus = "running";
			}
			else if (string.Equals(currentStatus, "running", StringComparison.Ordinal))
			{
				nextStatus = "stale";
			}
		}

		var nextStartedAt = record.StartedAtUtc ?? ParseUtc(turn.User.Timestamp) ?? record.QueuedAtUtc;
		DateTimeOffset? nextCompletedAt = record.CompletedAtUtc;
		if (IsTerminalStatus(nextStatus) && nextCompletedAt is null)
		{
			nextCompletedAt = ParseUtc(turn.AssistantFinal?.Timestamp) ?? DateTimeOffset.UtcNow;
		}
		var nextFindings = !string.IsNullOrWhiteSpace(assistantText)
			? ExtractFindings(assistantText, record.Cwd, record.DismissedFindingKeys)
			: record.Findings;
		var nextTurnId = turn.TurnId?.Trim() ?? string.Empty;

		var changed =
			!string.Equals(record.Status, nextStatus, StringComparison.Ordinal) ||
			record.StartedAtUtc != nextStartedAt ||
			record.CompletedAtUtc != nextCompletedAt ||
			!string.Equals(record.AssistantText ?? string.Empty, assistantText, StringComparison.Ordinal) ||
			!AreFindingsEqual(record.Findings, nextFindings) ||
			!string.Equals(record.TurnId ?? string.Empty, nextTurnId, StringComparison.Ordinal);

		record.Status = nextStatus;
		record.StartedAtUtc = nextStartedAt;
		record.CompletedAtUtc = nextCompletedAt;
		record.AssistantText = assistantText;
		record.Findings = nextFindings.ToList();
		record.TurnId = nextTurnId;
		return changed;
	}

	private static SessionOrchestrator.ConsolidatedTurnSnapshot? FindLatestMatchingTurn(
		ReviewRecord record,
		IReadOnlyList<SessionOrchestrator.ConsolidatedTurnSnapshot> turns)
	{
		SessionOrchestrator.ConsolidatedTurnSnapshot? best = null;
		var bestTime = DateTimeOffset.MinValue;
		foreach (var turn in turns)
		{
			var metadata = ParseReviewMetadata(turn.User.Text);
			if (metadata is null || !string.Equals(metadata.ReviewId, record.ReviewId, StringComparison.Ordinal))
			{
				continue;
			}

			var candidateTime = ParseUtc(turn.AssistantFinal?.Timestamp)
				?? ParseUtc(turn.User.Timestamp)
				?? DateTimeOffset.MinValue;
			if (best is null || candidateTime >= bestTime)
			{
				best = turn;
				bestTime = candidateTime;
			}
		}

		return best;
	}

	private bool ApplyRunningStateNoLock(
		ReviewRecord record,
		string? sessionId,
		string? threadId,
		string? turnId,
		DateTimeOffset now)
	{
		var changed = false;
		var normalizedSessionId = sessionId?.Trim() ?? string.Empty;
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		var normalizedTurnId = turnId?.Trim() ?? string.Empty;
		if (!string.IsNullOrWhiteSpace(normalizedSessionId) &&
			!string.Equals(record.SessionId, normalizedSessionId, StringComparison.Ordinal))
		{
			record.SessionId = normalizedSessionId;
			changed = true;
		}
		if (!string.IsNullOrWhiteSpace(normalizedThreadId) &&
			!string.Equals(record.ThreadId, normalizedThreadId, StringComparison.Ordinal))
		{
			record.ThreadId = normalizedThreadId;
			changed = true;
		}
		if (!string.IsNullOrWhiteSpace(normalizedTurnId) &&
			!string.Equals(record.TurnId, normalizedTurnId, StringComparison.Ordinal))
		{
			record.TurnId = normalizedTurnId;
			changed = true;
		}

		var currentStatus = NormalizeStatus(record.Status);
		if (IsAllowedTransition(currentStatus, "running") &&
			!string.Equals(currentStatus, "running", StringComparison.Ordinal))
		{
			record.Status = "running";
			record.CompletedAtUtc = null;
			changed = true;
		}
		if (record.StartedAtUtc is null)
		{
			record.StartedAtUtc = now;
			changed = true;
		}

		if (changed)
		{
			SaveNoLock();
		}

		return changed;
	}

	private bool ApplyCompletionStateNoLock(
		ReviewRecord record,
		string? sessionId,
		string? threadId,
		string? turnId,
		string? resultStatus,
		string? assistantText,
		DateTimeOffset now)
	{
		var changed = false;
		var normalizedSessionId = sessionId?.Trim() ?? string.Empty;
		var normalizedThreadId = threadId?.Trim() ?? string.Empty;
		var normalizedTurnId = turnId?.Trim() ?? string.Empty;
		if (!string.IsNullOrWhiteSpace(normalizedSessionId) &&
			!string.Equals(record.SessionId, normalizedSessionId, StringComparison.Ordinal))
		{
			record.SessionId = normalizedSessionId;
			changed = true;
		}
		if (!string.IsNullOrWhiteSpace(normalizedThreadId) &&
			!string.Equals(record.ThreadId, normalizedThreadId, StringComparison.Ordinal))
		{
			record.ThreadId = normalizedThreadId;
			changed = true;
		}
		if (!string.IsNullOrWhiteSpace(normalizedTurnId) &&
			!string.Equals(record.TurnId, normalizedTurnId, StringComparison.Ordinal))
		{
			record.TurnId = normalizedTurnId;
			changed = true;
		}

		var currentStatus = NormalizeStatus(record.Status);
		var nextStatus = string.Equals(currentStatus, "dismissed", StringComparison.Ordinal)
			? "dismissed"
			: NormalizeCompletionStatus(resultStatus, assistantText);
		if (IsAllowedTransition(currentStatus, nextStatus) &&
			!string.Equals(currentStatus, nextStatus, StringComparison.Ordinal))
		{
			record.Status = nextStatus;
			changed = true;
		}

		if (record.StartedAtUtc is null)
		{
			record.StartedAtUtc = now;
			changed = true;
		}
		if (IsTerminalStatus(nextStatus) && record.CompletedAtUtc is null)
		{
			record.CompletedAtUtc = now;
			changed = true;
		}

		var normalizedAssistantText = assistantText ?? string.Empty;
		if (!string.IsNullOrWhiteSpace(normalizedAssistantText) &&
			!string.Equals(record.AssistantText ?? string.Empty, normalizedAssistantText, StringComparison.Ordinal))
		{
			record.AssistantText = normalizedAssistantText;
			changed = true;
		}

		var nextFindings = !string.IsNullOrWhiteSpace(normalizedAssistantText)
			? ExtractFindings(normalizedAssistantText, record.Cwd, record.DismissedFindingKeys)
			: record.Findings;
		if (!AreFindingsEqual(record.Findings, nextFindings))
		{
			record.Findings = nextFindings.ToList();
			changed = true;
		}

		if (changed)
		{
			SaveNoLock();
		}

		return changed;
	}

	private static bool ReconcileWithoutTurnMatch(ReviewRecord record)
	{
		var currentStatus = NormalizeStatus(record.Status);
		var now = DateTimeOffset.UtcNow;
		var nextStatus = currentStatus;
		if (string.Equals(currentStatus, "running", StringComparison.Ordinal))
		{
			var startedAt = record.StartedAtUtc ?? record.QueuedAtUtc;
			if (now - startedAt >= RunningStaleAfter)
			{
				nextStatus = "stale";
			}
		}
		else if (string.Equals(currentStatus, "queued", StringComparison.Ordinal))
		{
			var queuedAt = record.QueuedAtUtc;
			if (now - queuedAt >= QueuedStaleAfter)
			{
				nextStatus = "stale";
			}
		}

		if (string.Equals(nextStatus, currentStatus, StringComparison.Ordinal))
		{
			return false;
		}

		record.Status = nextStatus;
		if (IsTerminalStatus(nextStatus))
		{
			record.CompletedAtUtc ??= now;
			record.StartedAtUtc ??= now;
		}
		return true;
	}

	private static string NormalizeCompletionStatus(string? status, string? assistantText)
	{
		var normalized = status?.Trim() ?? string.Empty;
		if (string.Equals(normalized, "completed", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "success", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "succeeded", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "ok", StringComparison.OrdinalIgnoreCase))
		{
			return "completed";
		}

		if (string.Equals(normalized, "failed", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "error", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "interrupted", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "canceled", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "cancelled", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "queuetimedout", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "timeout", StringComparison.OrdinalIgnoreCase))
		{
			return "failed";
		}

		if (!string.IsNullOrWhiteSpace(assistantText))
		{
			return "completed";
		}

		return "failed";
	}

	private static bool AreFindingsEqual(IReadOnlyList<ReviewFindingRecord> left, IReadOnlyList<ReviewFindingRecord> right)
	{
		if (ReferenceEquals(left, right))
		{
			return true;
		}
		if (left.Count != right.Count)
		{
			return false;
		}
		for (var i = 0; i < left.Count; i += 1)
		{
			var a = left[i];
			var b = right[i];
			if (!string.Equals(a.Key, b.Key, StringComparison.Ordinal) ||
				!string.Equals(a.Path, b.Path, StringComparison.Ordinal) ||
				a.LineNo != b.LineNo ||
				!string.Equals(a.Severity, b.Severity, StringComparison.Ordinal) ||
				!string.Equals(a.Detail, b.Detail, StringComparison.Ordinal) ||
				a.Done != b.Done ||
				!AreReferencesEqual(a.References, b.References))
			{
				return false;
			}
		}

		return true;
	}

	private static bool AreReferencesEqual(IReadOnlyList<ReviewReferenceRecord>? left, IReadOnlyList<ReviewReferenceRecord>? right)
	{
		var a = left ?? Array.Empty<ReviewReferenceRecord>();
		var b = right ?? Array.Empty<ReviewReferenceRecord>();
		if (a.Count != b.Count)
		{
			return false;
		}

		for (var i = 0; i < a.Count; i += 1)
		{
			var x = a[i];
			var y = b[i];
			if (!string.Equals(x.Path, y.Path, StringComparison.Ordinal) ||
				x.LineStart != y.LineStart ||
				x.LineEnd != y.LineEnd ||
				!string.Equals(x.Label, y.Label, StringComparison.Ordinal))
			{
				return false;
			}
		}

		return true;
	}

	private static ReviewCatalogItemSnapshot ToSnapshot(ReviewRecord record)
	{
		return new ReviewCatalogItemSnapshot(
			record.ReviewId,
			record.ThreadId,
			record.SessionId,
			record.Cwd,
			record.TargetType,
			record.CommitSha,
			record.CommitSubject,
			record.ContextLabel,
			record.VisibleFiles,
			record.TotalFiles,
			record.HiddenBinaryFiles,
			record.NoteText,
			record.Status,
			record.QueuedAtUtc,
			record.StartedAtUtc,
			record.CompletedAtUtc,
			record.TurnId,
			record.PromptText,
			record.AssistantText,
			record.Findings.Select(x => x with { }).ToArray());
	}

	private static DateTimeOffset? ParseUtc(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}
		return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
	}

	private static string NormalizeCwd(string? cwd)
	{
		if (string.IsNullOrWhiteSpace(cwd))
		{
			return string.Empty;
		}
		try
		{
			return Path.GetFullPath(cwd.Trim());
		}
		catch
		{
			return cwd.Trim();
		}
	}

	private static string NormalizeTargetType(string? value)
	{
		return string.Equals(value?.Trim(), "commit", StringComparison.OrdinalIgnoreCase) ? "commit" : "worktree";
	}

	private static string NormalizeStatus(string? value)
	{
		var normalized = value?.Trim() ?? string.Empty;
		if (string.Equals(normalized, "running", StringComparison.OrdinalIgnoreCase))
		{
			return "running";
		}
		if (string.Equals(normalized, "completed", StringComparison.OrdinalIgnoreCase))
		{
			return "completed";
		}
		if (string.Equals(normalized, "dismissed", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(normalized, "reviewed", StringComparison.OrdinalIgnoreCase))
		{
			return "dismissed";
		}
		if (string.Equals(normalized, "failed", StringComparison.OrdinalIgnoreCase))
		{
			return "failed";
		}
		if (string.Equals(normalized, "stale", StringComparison.OrdinalIgnoreCase))
		{
			return "stale";
		}
		return "queued";
	}

	private static bool IsTerminalStatus(string status)
	{
		return string.Equals(status, "completed", StringComparison.Ordinal) ||
			string.Equals(status, "failed", StringComparison.Ordinal) ||
			string.Equals(status, "dismissed", StringComparison.Ordinal) ||
			string.Equals(status, "stale", StringComparison.Ordinal);
	}

	private static bool IsAllowedTransition(string currentStatus, string nextStatus)
	{
		if (string.Equals(currentStatus, nextStatus, StringComparison.Ordinal))
		{
			return true;
		}

		if (string.Equals(currentStatus, "queued", StringComparison.Ordinal))
		{
			return string.Equals(nextStatus, "running", StringComparison.Ordinal) ||
				IsTerminalStatus(nextStatus);
		}

		if (string.Equals(currentStatus, "running", StringComparison.Ordinal))
		{
			return IsTerminalStatus(nextStatus);
		}

		if (string.Equals(currentStatus, "completed", StringComparison.Ordinal))
		{
			return string.Equals(nextStatus, "dismissed", StringComparison.Ordinal);
		}

		if (string.Equals(currentStatus, "failed", StringComparison.Ordinal) ||
			string.Equals(currentStatus, "stale", StringComparison.Ordinal))
		{
			return string.Equals(nextStatus, "queued", StringComparison.Ordinal) ||
				string.Equals(nextStatus, "running", StringComparison.Ordinal) ||
				string.Equals(nextStatus, "dismissed", StringComparison.Ordinal);
		}

		if (string.Equals(currentStatus, "dismissed", StringComparison.Ordinal))
		{
			return false;
		}

		return false;
	}

	private static string NormalizeCommitSha(string? value)
	{
		return string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim().ToLowerInvariant();
	}

	private static ReviewCreateRequest NormalizeCreateRequest(ReviewCreateRequest request)
	{
		var cwd = NormalizeCwd(request.Cwd);
		if (string.IsNullOrWhiteSpace(cwd))
		{
			throw new InvalidOperationException("cwd is required.");
		}

		var targetType = NormalizeTargetType(request.TargetType);
		var commitSha = NormalizeCommitSha(request.CommitSha);
		if (string.Equals(targetType, "commit", StringComparison.Ordinal) && string.IsNullOrWhiteSpace(commitSha))
		{
			throw new InvalidOperationException("commitSha is required for commit reviews.");
		}

		return request with
		{
			ThreadId = request.ThreadId?.Trim() ?? string.Empty,
			SessionId = request.SessionId?.Trim() ?? string.Empty,
			Cwd = cwd,
			TargetType = targetType,
			CommitSha = commitSha,
			CommitSubject = request.CommitSubject?.Trim() ?? string.Empty,
			ContextLabel = request.ContextLabel?.Trim() ?? "+3",
			NoteText = request.NoteText?.Trim() ?? string.Empty,
			InitialStatus = NormalizeStatus(request.InitialStatus),
			VisibleFiles = Math.Max(0, request.VisibleFiles),
			TotalFiles = Math.Max(0, request.TotalFiles),
			HiddenBinaryFiles = Math.Max(0, request.HiddenBinaryFiles)
		};
	}

	private static string BuildPromptText(string reviewId, ReviewCreateRequest request)
	{
		var lines = new List<string>
		{
			"Run a code review for the current repository state.",
			"Focus on bugs, regressions, risky behavior changes, and missing tests.",
			"Report findings first, ordered by severity, with file paths and line references when possible."
		};

		if (string.Equals(request.TargetType, "commit", StringComparison.Ordinal))
		{
			lines.Add($"Review target: commit {request.CommitSha}{(string.IsNullOrWhiteSpace(request.CommitSubject) ? string.Empty : $" ({request.CommitSubject})")}.");
		}
		else
		{
			lines.Add("Review target: uncommitted working tree changes (staged, unstaged, and untracked).");
		}

		lines.Add($"Diff panel context: {request.ContextLabel}.");
		lines.Add($"Diff panel summary: {request.TotalFiles} file change(s), {request.VisibleFiles} visible, {request.HiddenBinaryFiles} binary hidden.");
		if (!string.IsNullOrWhiteSpace(request.NoteText))
		{
			lines.Add($"Additional review note: {request.NoteText}");
		}

		lines.Add(string.Empty);
		lines.Add(ReviewMetadataHeader);
		lines.Add($"review_id={reviewId}");
		lines.Add($"thread_id={request.ThreadId}");
		lines.Add($"session_id={request.SessionId}");
		lines.Add($"cwd={request.Cwd}");
		lines.Add($"target_type={request.TargetType}");
		if (!string.IsNullOrWhiteSpace(request.CommitSha))
		{
			lines.Add($"commit_sha={request.CommitSha}");
		}
		lines.Add($"context_label={request.ContextLabel}");
		lines.Add($"visible_files={request.VisibleFiles}");
		lines.Add($"total_files={request.TotalFiles}");
		lines.Add($"hidden_binary_files={request.HiddenBinaryFiles}");
		lines.Add(ReviewMetadataFooter);
		return string.Join("\n", lines);
	}

	private static ReviewMetadata? ParseReviewMetadata(string? text)
	{
		var source = text ?? string.Empty;
		if (!source.Contains(ReviewMetadataHeader, StringComparison.Ordinal) ||
			!source.Contains(ReviewMetadataFooter, StringComparison.Ordinal))
		{
			return null;
		}

		var match = Regex.Match(
			source,
			@"\[Review metadata\](?<body>[\s\S]*?)\[/Review metadata\]",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		if (!match.Success)
		{
			return null;
		}

		var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		var lines = match.Groups["body"].Value.Split('\n');
		foreach (var rawLine in lines)
		{
			var line = rawLine?.Trim() ?? string.Empty;
			if (string.IsNullOrWhiteSpace(line))
			{
				continue;
			}

			var separatorIndex = line.IndexOf('=');
			if (separatorIndex <= 0)
			{
				continue;
			}

			var key = line[..separatorIndex].Trim();
			var value = line[(separatorIndex + 1)..].Trim();
			if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value))
			{
				values[key] = value;
			}
		}

		if (!values.TryGetValue("review_id", out var reviewId) || string.IsNullOrWhiteSpace(reviewId))
		{
			return null;
		}

		return new ReviewMetadata(
			reviewId.Trim(),
			values.TryGetValue("thread_id", out var threadId) ? threadId.Trim() : string.Empty,
			values.TryGetValue("session_id", out var sessionId) ? sessionId.Trim() : string.Empty,
			values.TryGetValue("cwd", out var cwd) ? NormalizeCwd(cwd) : string.Empty,
			values.TryGetValue("target_type", out var targetType) ? NormalizeTargetType(targetType) : "worktree",
			values.TryGetValue("commit_sha", out var commitSha) ? NormalizeCommitSha(commitSha) : string.Empty);
	}

	private static IReadOnlyList<ReviewFindingRecord> ExtractFindings(
		string assistantText,
		string cwd,
		IReadOnlyList<string> dismissedFindingKeys)
	{
		var dismissed = dismissedFindingKeys.ToHashSet(StringComparer.Ordinal);
		var findings = new List<ReviewFindingRecord>();
		var seen = new HashSet<string>(StringComparer.Ordinal);
		var currentBlock = new List<string>();
		var inFindingsSection = false;
		foreach (var rawLine in (assistantText ?? string.Empty).Split('\n'))
		{
			var line = rawLine?.Trim() ?? string.Empty;
			if (string.IsNullOrWhiteSpace(line))
			{
				continue;
			}

			var heading = NormalizeSectionHeading(line);
			if (string.Equals(heading, "findings", StringComparison.OrdinalIgnoreCase))
			{
				CommitFindingBlock(currentBlock, cwd, dismissed, seen, findings);
				currentBlock.Clear();
				inFindingsSection = true;
				continue;
			}
			if (IsTerminalReviewSectionHeading(heading))
			{
				CommitFindingBlock(currentBlock, cwd, dismissed, seen, findings);
				currentBlock.Clear();
				inFindingsSection = false;
				continue;
			}

			var startsFinding = IsFindingStartLine(line);
			if (!inFindingsSection && !startsFinding)
			{
				continue;
			}

			if (startsFinding)
			{
				CommitFindingBlock(currentBlock, cwd, dismissed, seen, findings);
				currentBlock.Clear();
				inFindingsSection = true;
			}

			if (inFindingsSection)
			{
				currentBlock.Add(line);
			}
		}
		CommitFindingBlock(currentBlock, cwd, dismissed, seen, findings);

		return findings;
	}

	private static void CommitFindingBlock(
		List<string> blockLines,
		string cwd,
		HashSet<string> dismissed,
		HashSet<string> seen,
		List<ReviewFindingRecord> findings)
	{
		if (blockLines is null || blockLines.Count == 0)
		{
			return;
		}

		var parsed = ParseFindingBlock(blockLines, cwd);
		if (parsed is null || string.IsNullOrWhiteSpace(parsed.Value.Detail))
		{
			return;
		}

		var detail = parsed.Value.Detail;
		var references = parsed.Value.References ?? Array.Empty<ReviewReferenceRecord>();
		var key = !string.IsNullOrWhiteSpace(parsed.Value.Path) && parsed.Value.LineNo > 0
			? $"{parsed.Value.Path}|{parsed.Value.LineNo}|{detail}"
			: $"summary||{detail}";
		if (!seen.Add(key))
		{
			return;
		}

		findings.Add(new ReviewFindingRecord(
			key,
			parsed.Value.Path,
			parsed.Value.LineNo,
			parsed.Value.Severity,
			detail,
			dismissed.Contains(key),
			references));
	}

	private static (string Path, int LineNo, string Severity, string Detail, IReadOnlyList<ReviewReferenceRecord> References)? ParseFindingBlock(IReadOnlyList<string> blockLines, string cwd)
	{
		if (blockLines is null || blockLines.Count == 0)
		{
			return null;
		}

		var headerLine = blockLines[0]?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(headerLine))
		{
			return null;
		}

		var normalizedHeaderLine = Regex.Replace(headerLine, @"^(?:[-*]\s+)?(?:#{1,6}\s*)?", string.Empty, RegexOptions.CultureInvariant).Trim();
		var match = Regex.Match(
			normalizedHeaderLine,
			@"^(?:(?:\d+)\.\s*)?(?<severity>critical|high|medium|low)(?:\s*[:\-]\s*|\s+)(?<detail>.+)$",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		var severity = match.Success ? NormalizeSeverity(match.Groups["severity"].Value) : NormalizeSeverity(normalizedHeaderLine);
		var detail = match.Success
			? match.Groups["detail"].Value.Trim()
			: Regex.Replace(normalizedHeaderLine, @"^\d+\.\s*", string.Empty, RegexOptions.CultureInvariant).Trim();
		if (string.IsNullOrWhiteSpace(detail))
		{
			return null;
		}

		var references = ExtractFileReferences(blockLines, cwd)
			.Where(x => !string.IsNullOrWhiteSpace(x.Path))
			.ToArray();

		var firstLineReference = references
			.FirstOrDefault(x => x.LineStart > 0);
		if (firstLineReference is not null)
		{
			return (firstLineReference.Path, firstLineReference.LineStart, severity, detail, references);
		}

		return (string.Empty, 0, severity, detail, references);
	}

	private static IReadOnlyList<ReviewReferenceRecord> ExtractFileReferences(IReadOnlyList<string> blockLines, string cwd)
	{
		var results = new List<ReviewReferenceRecord>();
		var dedupe = new HashSet<string>(StringComparer.Ordinal);
		if (blockLines is null || blockLines.Count == 0)
		{
			return results;
		}

		foreach (var line in blockLines)
		{
			var sourceLine = line ?? string.Empty;
			foreach (Match linkMatch in Regex.Matches(sourceLine, @"\[([^\]]+)\]\(([^)]+)\)", RegexOptions.CultureInvariant))
			{
				var parsed = ParseFileLink(linkMatch.Groups[2].Value);
				if (parsed is null)
				{
					continue;
				}

				var label = linkMatch.Groups[1].Value.Trim();
				AddReference(results, dedupe, parsed.Value.Path, parsed.Value.LineStart, parsed.Value.LineEnd, label, cwd);
			}

			foreach (Match codeMatch in Regex.Matches(sourceLine, @"`(?<token>[^`]+)`(?:\s*:\s*(?<line>\d+(?:\s*-\s*\d+)?))?", RegexOptions.CultureInvariant))
			{
				var token = codeMatch.Groups["token"].Value.Trim();
				if (string.IsNullOrWhiteSpace(token))
				{
					continue;
				}

				var lineSuffix = codeMatch.Groups["line"].Success ? codeMatch.Groups["line"].Value : string.Empty;
				var parsed = ParseFileToken(token, lineSuffix);
				if (parsed is null)
				{
					continue;
				}

				AddReference(results, dedupe, parsed.Value.Path, parsed.Value.LineStart, parsed.Value.LineEnd, token, cwd);
			}

			foreach (Match pathMatch in Regex.Matches(sourceLine, @"(?<token>(?:[A-Za-z]:[\\/]|/)?[A-Za-z0-9_.\-\\/]+?\.(?:cs|csx|js|jsx|ts|tsx|json|md|markdown|pts|ps1|psm1|cmd|bat|css|html|htm|sql|xml|yml|yaml|csproj|props|targets|sln|config)(?:[:#]L?\d+(?:[-:]\d+)?)?)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
			{
				var token = pathMatch.Groups["token"].Value.Trim();
				var parsed = ParseFileToken(token, string.Empty);
				if (parsed is null)
				{
					continue;
				}
				AddReference(results, dedupe, parsed.Value.Path, parsed.Value.LineStart, parsed.Value.LineEnd, token, cwd);
			}
		}

		return results;
	}

	private static void AddReference(
		List<ReviewReferenceRecord> results,
		HashSet<string> dedupe,
		string path,
		int lineStart,
		int lineEnd,
		string label,
		string cwd)
	{
		var normalizedPath = NormalizeFindingPath(path, cwd);
		if (string.IsNullOrWhiteSpace(normalizedPath))
		{
			return;
		}

		var effectiveEnd = lineEnd > 0 ? lineEnd : lineStart;
		var key = $"{normalizedPath}|{lineStart}|{effectiveEnd}";
		if (!dedupe.Add(key))
		{
			return;
		}

		results.Add(new ReviewReferenceRecord(
			normalizedPath,
			lineStart,
			effectiveEnd,
			label?.Trim() ?? string.Empty));
	}

	private static bool IsFindingStartLine(string line)
	{
		var normalizedLine = Regex.Replace(
			line ?? string.Empty,
			@"^(?:[-*]\s+)?(?:#{1,6}\s*)?",
			string.Empty,
			RegexOptions.CultureInvariant).Trim();

		return Regex.IsMatch(
			normalizedLine,
			@"^(?:(?:\d+)\.\s*)?(critical|high|medium|low)(?:\s*[:\-]\s*|\s+)",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
	}

	private static string NormalizeSectionHeading(string line)
	{
		var normalized = line?.Trim() ?? string.Empty;
		normalized = Regex.Replace(normalized, @"^[#*\s`>_-]+", string.Empty, RegexOptions.CultureInvariant);
		normalized = Regex.Replace(normalized, @"[#*\s`:_-]+$", string.Empty, RegexOptions.CultureInvariant);
		return normalized.Trim();
	}

	private static bool IsTerminalReviewSectionHeading(string heading)
	{
		if (string.IsNullOrWhiteSpace(heading))
		{
			return false;
		}

		return
			string.Equals(heading, "missing tests", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(heading, "open questions", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(heading, "residual risks / regressions to watch", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(heading, "residual risks", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(heading, "notes", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(heading, "change summary", StringComparison.OrdinalIgnoreCase);
	}

	private static (string Path, int LineStart, int LineEnd)? ParseFileLink(string? href)
	{
		var value = href?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		if (value.Contains("://", StringComparison.Ordinal) &&
			!value.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
		{
			return null;
		}

		if (value.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
		{
			value = value["file://".Length..].TrimStart('/');
		}

		value = Regex.Replace(value, @"[?#].*$", string.Empty);
		return ParseFileToken(value, string.Empty);
	}

	private static (string Path, int LineStart, int LineEnd)? ParseFileToken(string? token, string? externalLineSuffix)
	{
		var value = token?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var lineStart = 0;
		var lineEnd = 0;

		var inlineLineMatch = Regex.Match(value, @"(?::|#L)(\d+)(?:[-:](\d+))?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		if (inlineLineMatch.Success)
		{
			if (int.TryParse(inlineLineMatch.Groups[1].Value, out var parsedStart))
			{
				lineStart = parsedStart;
				lineEnd = parsedStart;
				if (inlineLineMatch.Groups[2].Success && int.TryParse(inlineLineMatch.Groups[2].Value, out var parsedEnd) && parsedEnd >= parsedStart)
				{
					lineEnd = parsedEnd;
				}
			}
			value = value[..inlineLineMatch.Index];
		}
		else if (!string.IsNullOrWhiteSpace(externalLineSuffix))
		{
			var suffixMatch = Regex.Match(externalLineSuffix, @"(\d+)(?:\s*-\s*(\d+))?", RegexOptions.CultureInvariant);
			if (suffixMatch.Success && int.TryParse(suffixMatch.Groups[1].Value, out var parsedStart))
			{
				lineStart = parsedStart;
				lineEnd = parsedStart;
				if (suffixMatch.Groups[2].Success && int.TryParse(suffixMatch.Groups[2].Value, out var parsedEnd) && parsedEnd >= parsedStart)
				{
					lineEnd = parsedEnd;
				}
			}
		}

		value = value.Trim().Trim('"', '\'', '`');
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		if (!Regex.IsMatch(value, @"\.(cs|csx|js|jsx|ts|tsx|json|md|markdown|pts|ps1|psm1|cmd|bat|css|html|htm|sql|xml|yml|yaml|csproj|props|targets|sln|config)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
		{
			return null;
		}

		return (value.Replace('\\', '/'), lineStart, lineEnd);
	}

	private static string NormalizeFindingPath(string path, string cwd)
	{
		var normalizedPath = (path ?? string.Empty).Trim().Replace('\\', '/');
		var normalizedCwd = NormalizeCwd(cwd).Replace('\\', '/').TrimEnd('/');
		if (string.IsNullOrWhiteSpace(normalizedPath) || string.IsNullOrWhiteSpace(normalizedCwd))
		{
			return normalizedPath;
		}

		if (normalizedPath.Length > normalizedCwd.Length + 1 &&
			normalizedPath.StartsWith(normalizedCwd + "/", StringComparison.OrdinalIgnoreCase))
		{
			return normalizedPath[(normalizedCwd.Length + 1)..];
		}

		return normalizedPath;
	}

	private static string NormalizeSeverity(string text)
	{
		var source = text?.ToLowerInvariant() ?? string.Empty;
		if (source.Contains("critical", StringComparison.Ordinal))
		{
			return "critical";
		}
		if (source.Contains("high", StringComparison.Ordinal))
		{
			return "high";
		}
		if (source.Contains("medium", StringComparison.Ordinal))
		{
			return "medium";
		}
		if (source.Contains("low", StringComparison.Ordinal))
		{
			return "low";
		}
		return "info";
	}

	private List<ReviewRecord> Load()
	{
		try
		{
			if (!File.Exists(_storagePath))
			{
				return new List<ReviewRecord>();
			}

			var json = File.ReadAllText(_storagePath);
			return JsonSerializer.Deserialize<List<ReviewRecord>>(json, _jsonOptions) ?? new List<ReviewRecord>();
		}
		catch
		{
			return new List<ReviewRecord>();
		}
	}

	private void SaveNoLock()
	{
		var json = JsonSerializer.Serialize(_records, _jsonOptions);
		var tempPath = _storagePath + ".tmp";
		File.WriteAllText(tempPath, json);
		File.Move(tempPath, _storagePath, overwrite: true);
	}

	internal sealed record ReviewCreateRequest(
		string ThreadId,
		string SessionId,
		string Cwd,
		string TargetType,
		string CommitSha,
		string CommitSubject,
		string ContextLabel,
		int VisibleFiles,
		int TotalFiles,
		int HiddenBinaryFiles,
		string NoteText,
		string InitialStatus);

	internal sealed record ReviewCreateResult(ReviewRecord Record, string PromptText);

	internal sealed record ReviewCatalogSnapshot(string Cwd, IReadOnlyList<ReviewCatalogItemSnapshot> Reviews);

	internal sealed record ReviewCatalogItemSnapshot(
		string ReviewId,
		string ThreadId,
		string SessionId,
		string Cwd,
		string TargetType,
		string CommitSha,
		string CommitSubject,
		string ContextLabel,
		int VisibleFiles,
		int TotalFiles,
		int HiddenBinaryFiles,
		string NoteText,
		string Status,
		DateTimeOffset QueuedAtUtc,
		DateTimeOffset? StartedAtUtc,
		DateTimeOffset? CompletedAtUtc,
		string TurnId,
		string PromptText,
		string AssistantText,
		IReadOnlyList<ReviewFindingRecord> Findings);

	internal sealed record ReviewFindingRecord(
		string Key,
		string Path,
		int LineNo,
		string Severity,
		string Detail,
		bool Done,
		IReadOnlyList<ReviewReferenceRecord>? References = null);

	internal sealed record ReviewReferenceRecord(
		string Path,
		int LineStart,
		int LineEnd,
		string Label);

	private sealed record ReviewMetadata(
		string ReviewId,
		string ThreadId,
		string SessionId,
		string Cwd,
		string TargetType,
		string CommitSha);

	internal sealed class ReviewRecord
	{
		public string ReviewId { get; set; } = string.Empty;
		public string ThreadId { get; set; } = string.Empty;
		public string SessionId { get; set; } = string.Empty;
		public string Cwd { get; set; } = string.Empty;
		public string TargetType { get; set; } = "worktree";
		public string CommitSha { get; set; } = string.Empty;
		public string CommitSubject { get; set; } = string.Empty;
		public string ContextLabel { get; set; } = "+3";
		public int VisibleFiles { get; set; }
		public int TotalFiles { get; set; }
		public int HiddenBinaryFiles { get; set; }
		public string NoteText { get; set; } = string.Empty;
		public string PromptText { get; set; } = string.Empty;
		public string Status { get; set; } = "queued";
		public DateTimeOffset QueuedAtUtc { get; set; }
		public DateTimeOffset? StartedAtUtc { get; set; }
		public DateTimeOffset? CompletedAtUtc { get; set; }
		public string TurnId { get; set; } = string.Empty;
		public string AssistantText { get; set; } = string.Empty;
		public List<ReviewFindingRecord> Findings { get; set; } = new();
		public List<string> DismissedFindingKeys { get; set; } = new();

		public ReviewRecord Clone()
		{
			return new ReviewRecord
			{
				ReviewId = ReviewId,
				ThreadId = ThreadId,
				SessionId = SessionId,
				Cwd = Cwd,
				TargetType = TargetType,
				CommitSha = CommitSha,
				CommitSubject = CommitSubject,
				ContextLabel = ContextLabel,
				VisibleFiles = VisibleFiles,
				TotalFiles = TotalFiles,
				HiddenBinaryFiles = HiddenBinaryFiles,
				NoteText = NoteText,
				PromptText = PromptText,
				Status = Status,
				QueuedAtUtc = QueuedAtUtc,
				StartedAtUtc = StartedAtUtc,
				CompletedAtUtc = CompletedAtUtc,
				TurnId = TurnId,
				AssistantText = AssistantText,
				Findings = Findings.Select(x => x with { }).ToList(),
				DismissedFindingKeys = DismissedFindingKeys.ToList()
			};
		}
	}
}
