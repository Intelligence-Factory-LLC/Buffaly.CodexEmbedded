using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Buffaly.CodexEmbedded.Core;

internal sealed class RecapQueryService
{
	private static readonly Regex QueryTokenRegex = new(@"[a-z0-9_./\\-]+", RegexOptions.Compiled | RegexOptions.IgnoreCase);
	private static readonly HashSet<string> QueryStopWords = new(StringComparer.OrdinalIgnoreCase)
	{
		"a", "an", "the", "to", "for", "of", "in", "on", "and", "or", "at", "from", "with", "about",
		"is", "are", "was", "were", "be", "been", "it", "that", "this", "these", "those",
		"did", "do", "does", "we", "i", "you", "our", "my", "your", "through", "throughout",
		"where", "what", "when", "how", "why", "can", "could", "should", "would", "have", "has", "had"
	};

	private readonly WebRuntimeDefaults _defaults;

	public RecapQueryService(WebRuntimeDefaults defaults)
	{
		_defaults = defaults;
	}

	public RecapDayResponse GetDaySummary(string? localDateRaw, string? timezoneId, int maxSessions)
	{
		var context = LoadContext(localDateRaw, timezoneId, maxSessions);
		var sessions = BuildSessionSummaries(context);
		var summary = BuildDaySummary(context, sessions);
		return new RecapDayResponse(
			LocalDate: context.LocalDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
			Timezone: context.TimezoneId,
			WindowStartUtc: context.WindowStartUtc.ToString("O"),
			WindowEndUtc: context.WindowEndUtc.ToString("O"),
			Summary: summary,
			Sessions: sessions);
	}

	public RecapQueryResponse QueryDay(RecapQueryRequest request)
	{
		var context = LoadContext(request.LocalDate, request.Timezone, request.MaxSessions);
		var sessions = BuildSessionSummaries(context);
		var summary = BuildDaySummary(context, sessions);
		var normalizedQuery = NormalizeText(request.Query);
		if (string.IsNullOrWhiteSpace(normalizedQuery))
		{
			var recapAnswer = BuildDayAnswer(summary, sessions);
			return new RecapQueryResponse(
				LocalDate: context.LocalDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
				Timezone: context.TimezoneId,
				WindowStartUtc: context.WindowStartUtc.ToString("O"),
				WindowEndUtc: context.WindowEndUtc.ToString("O"),
				Query: string.Empty,
				Answer: recapAnswer,
				Summary: summary,
				Threads: Array.Empty<RecapThreadMatchSummary>(),
				Matches: Array.Empty<RecapMatchItem>());
		}

		var queryTokens = TokenizeQuery(normalizedQuery);
		var scoredMatches = ScoreMatches(context, normalizedQuery, queryTokens)
			.OrderByDescending(x => x.Score)
			.ThenByDescending(x => x.Event.TimestampUtc)
			.Take(Math.Clamp(request.MaxResults, 1, 200))
			.ToList();
		var threadSummaries = BuildThreadMatchSummaries(context, scoredMatches);
		var answer = BuildQueryAnswer(context.LocalDate, normalizedQuery, scoredMatches, threadSummaries);
		var matches = scoredMatches.Select(x =>
		{
			var threadMeta = context.ThreadById.TryGetValue(x.Event.ThreadId, out var existing)
				? existing
				: RecapThreadMeta.Empty(x.Event.ThreadId);
			return new RecapMatchItem(
				ThreadId: x.Event.ThreadId,
				ThreadName: threadMeta.ThreadName,
				Cwd: threadMeta.Cwd,
				Model: threadMeta.Model,
				SessionFilePath: threadMeta.SessionFilePath,
				TimestampUtc: x.Event.TimestampUtc.ToString("O"),
				EventType: x.Event.EventType,
				Text: x.Event.Text,
				Command: x.Event.Command,
				Score: x.Score);
		}).ToArray();

		return new RecapQueryResponse(
			LocalDate: context.LocalDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
			Timezone: context.TimezoneId,
			WindowStartUtc: context.WindowStartUtc.ToString("O"),
			WindowEndUtc: context.WindowEndUtc.ToString("O"),
			Query: normalizedQuery,
			Answer: answer,
			Summary: summary,
			Threads: threadSummaries,
			Matches: matches);
	}

	private LoadedRecapContext LoadContext(string? localDateRaw, string? timezoneId, int maxSessions)
	{
		var timezone = ResolveTimezone(timezoneId);
		var nowLocal = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, timezone);
		var localDate = DateOnly.FromDateTime(nowLocal.DateTime);
		if (!string.IsNullOrWhiteSpace(localDateRaw) &&
			DateOnly.TryParseExact(localDateRaw.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedDate))
		{
			localDate = parsedDate;
		}

		var (windowStartUtc, windowEndUtc) = GetUtcWindow(localDate, timezone);
		var orderedSessions = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: 0)
			.Where(x => !string.IsNullOrWhiteSpace(x.ThreadId) && !string.IsNullOrWhiteSpace(x.SessionFilePath))
			.OrderByDescending(x => x.UpdatedAtUtc ?? DateTimeOffset.MinValue)
			.ThenBy(x => x.ThreadId, StringComparer.Ordinal)
			.Take(Math.Clamp(maxSessions, 1, 3000))
			.ToArray();

		var threadById = new Dictionary<string, RecapThreadMeta>(StringComparer.Ordinal);
		foreach (var session in orderedSessions)
		{
			if (string.IsNullOrWhiteSpace(session.ThreadId) || string.IsNullOrWhiteSpace(session.SessionFilePath))
			{
				continue;
			}

			var sessionPath = Path.GetFullPath(session.SessionFilePath);
			if (!File.Exists(sessionPath))
			{
				continue;
			}

			threadById[session.ThreadId] = new RecapThreadMeta(
				ThreadId: session.ThreadId,
				ThreadName: NormalizeText(session.ThreadName),
				Cwd: NormalizeText(session.Cwd),
				Model: NormalizeText(session.Model),
				SessionFilePath: sessionPath);
		}

		var events = new List<RecapEvent>(capacity: 1024);
		foreach (var thread in threadById.Values)
		{
			ReadSessionEvents(thread, windowStartUtc, windowEndUtc, events);
		}

		ReadHistoryEvents(windowStartUtc, windowEndUtc, threadById, events);
		events.Sort((left, right) => right.TimestampUtc.CompareTo(left.TimestampUtc));

		return new LoadedRecapContext(
			LocalDate: localDate,
			TimezoneId: timezone.Id,
			WindowStartUtc: windowStartUtc,
			WindowEndUtc: windowEndUtc,
			ThreadById: threadById,
			Events: events);
	}

	private static RecapDaySummary BuildDaySummary(LoadedRecapContext context, IReadOnlyList<RecapSessionSummary> sessions)
	{
		var userPrompts = context.Events.Count(x => string.Equals(x.EventType, RecapEventTypes.UserPrompt, StringComparison.Ordinal));
		var assistantMessages = context.Events.Count(x => string.Equals(x.EventType, RecapEventTypes.AssistantMessage, StringComparison.Ordinal));
		var toolCalls = context.Events.Count(x => string.Equals(x.EventType, RecapEventTypes.ToolCall, StringComparison.Ordinal));
		var threadCount = sessions.Count;
		var topCommands = context.Events
			.Where(x => !string.IsNullOrWhiteSpace(x.Command))
			.Select(x => ExtractCommandHead(x.Command))
			.Where(x => !string.IsNullOrWhiteSpace(x))
			.GroupBy(x => x, StringComparer.OrdinalIgnoreCase)
			.Select(x => new RecapBucketItem(x.Key, x.Count()))
			.OrderByDescending(x => x.Count)
			.ThenBy(x => x.Value, StringComparer.OrdinalIgnoreCase)
			.Take(8)
			.ToArray();
		var topTopics = context.Events
			.Where(x => string.Equals(x.EventType, RecapEventTypes.UserPrompt, StringComparison.Ordinal))
			.SelectMany(x => TokenizeQuery(x.Text))
			.Where(x => x.Length >= 3)
			.GroupBy(x => x, StringComparer.OrdinalIgnoreCase)
			.Select(x => new RecapBucketItem(x.Key, x.Count()))
			.OrderByDescending(x => x.Count)
			.ThenBy(x => x.Value, StringComparer.OrdinalIgnoreCase)
			.Take(10)
			.ToArray();
		var activityByHour = BuildHourBuckets(context.Events, context.TimezoneId);
		return new RecapDaySummary(
			EventCount: context.Events.Count,
			ActiveThreadCount: threadCount,
			UserPromptCount: userPrompts,
			AssistantMessageCount: assistantMessages,
			ToolCallCount: toolCalls,
			TopCommands: topCommands,
			TopTopics: topTopics,
			ActivityByHour: activityByHour);
	}

	private static IReadOnlyList<RecapSessionSummary> BuildSessionSummaries(LoadedRecapContext context)
	{
		return context.Events
			.GroupBy(x => x.ThreadId, StringComparer.Ordinal)
			.Select(group =>
			{
				var meta = context.ThreadById.TryGetValue(group.Key, out var existing)
					? existing
					: RecapThreadMeta.Empty(group.Key);
				var ordered = group
					.OrderByDescending(x => x.TimestampUtc)
					.ToArray();
				var promptSamples = ordered
					.Where(x => string.Equals(x.EventType, RecapEventTypes.UserPrompt, StringComparison.Ordinal))
					.Select(x => TruncateForDisplay(x.Text, 220))
					.Where(x => !string.IsNullOrWhiteSpace(x))
					.Take(4)
					.ToArray();
				var commandSamples = ordered
					.Where(x => !string.IsNullOrWhiteSpace(x.Command))
					.Select(x => TruncateForDisplay(x.Command, 220))
					.Where(x => !string.IsNullOrWhiteSpace(x))
					.Take(4)
					.ToArray();
				return new RecapSessionSummary(
					ThreadId: group.Key,
					ThreadName: meta.ThreadName,
					Cwd: meta.Cwd,
					Model: meta.Model,
					SessionFilePath: meta.SessionFilePath,
					EventCount: ordered.Length,
					UserPromptCount: ordered.Count(x => string.Equals(x.EventType, RecapEventTypes.UserPrompt, StringComparison.Ordinal)),
					AssistantMessageCount: ordered.Count(x => string.Equals(x.EventType, RecapEventTypes.AssistantMessage, StringComparison.Ordinal)),
					ToolCallCount: ordered.Count(x => string.Equals(x.EventType, RecapEventTypes.ToolCall, StringComparison.Ordinal)),
					FirstEventUtc: ordered.Length > 0 ? ordered[^1].TimestampUtc.ToString("O") : null,
					LastEventUtc: ordered.Length > 0 ? ordered[0].TimestampUtc.ToString("O") : null,
					PromptSamples: promptSamples,
					CommandSamples: commandSamples);
			})
			.OrderByDescending(x => x.EventCount)
			.ThenByDescending(x => x.LastEventUtc, StringComparer.Ordinal)
			.ThenBy(x => x.ThreadId, StringComparer.Ordinal)
			.ToArray();
	}

	private static IReadOnlyList<RecapThreadMatchSummary> BuildThreadMatchSummaries(LoadedRecapContext context, IReadOnlyList<ScoredRecapEvent> matches)
	{
		return matches
			.GroupBy(x => x.Event.ThreadId, StringComparer.Ordinal)
			.Select(group =>
			{
				var meta = context.ThreadById.TryGetValue(group.Key, out var existing)
					? existing
					: RecapThreadMeta.Empty(group.Key);
				var ordered = group
					.OrderByDescending(x => x.Score)
					.ThenByDescending(x => x.Event.TimestampUtc)
					.ToArray();
				var sampleMatches = ordered
					.Take(5)
					.Select(x =>
					{
						var text = !string.IsNullOrWhiteSpace(x.Event.Command)
							? x.Event.Command
							: x.Event.Text;
						return TruncateForDisplay(text, 220);
					})
					.Where(x => !string.IsNullOrWhiteSpace(x))
					.ToArray();
				return new RecapThreadMatchSummary(
					ThreadId: group.Key,
					ThreadName: meta.ThreadName,
					Cwd: meta.Cwd,
					Model: meta.Model,
					SessionFilePath: meta.SessionFilePath,
					MatchCount: group.Count(),
					TopScore: ordered.Length > 0 ? ordered[0].Score : 0,
					LastMatchUtc: group.Max(x => x.Event.TimestampUtc).ToString("O"),
					SampleMatches: sampleMatches);
			})
			.OrderByDescending(x => x.TopScore)
			.ThenByDescending(x => x.MatchCount)
			.ThenByDescending(x => x.LastMatchUtc, StringComparer.Ordinal)
			.ToArray();
	}

	private static IReadOnlyList<ScoredRecapEvent> ScoreMatches(
		LoadedRecapContext context,
		string normalizedQuery,
		IReadOnlyList<string> queryTokens)
	{
		var queryLower = normalizedQuery.ToLowerInvariant();
		var queryLooksLikeWhereQuestion = queryLower.Contains("where", StringComparison.Ordinal) ||
			queryLower.Contains("implement", StringComparison.Ordinal) ||
			queryLower.Contains("implemented", StringComparison.Ordinal);
		var output = new List<ScoredRecapEvent>();
		foreach (var ev in context.Events)
		{
			var threadMeta = context.ThreadById.TryGetValue(ev.ThreadId, out var existing)
				? existing
				: RecapThreadMeta.Empty(ev.ThreadId);
			var searchableText = string.Join(
				"\n",
				new[]
				{
					ev.Text,
					ev.Command,
					threadMeta.ThreadName,
					threadMeta.Cwd,
					threadMeta.Model
				}
				.Where(x => !string.IsNullOrWhiteSpace(x)))
				.ToLowerInvariant();
			if (string.IsNullOrWhiteSpace(searchableText))
			{
				continue;
			}

			var score = 0;
			if (searchableText.Contains(queryLower, StringComparison.Ordinal))
			{
				score += 14;
			}

			foreach (var token in queryTokens)
			{
				if (searchableText.Contains(token, StringComparison.Ordinal))
				{
					score += 4;
				}

				if (!string.IsNullOrWhiteSpace(ev.Command) && ev.Command.Contains(token, StringComparison.OrdinalIgnoreCase))
				{
					score += 3;
				}
			}

			if (queryLooksLikeWhereQuestion && string.Equals(ev.EventType, RecapEventTypes.ToolCall, StringComparison.Ordinal))
			{
				score += 2;
			}

			if (score <= 0)
			{
				continue;
			}

			output.Add(new ScoredRecapEvent(ev, score));
		}

		return output;
	}

	private static IReadOnlyList<RecapHourBucket> BuildHourBuckets(IReadOnlyList<RecapEvent> events, string timezoneId)
	{
		TimeZoneInfo timezone;
		try
		{
			timezone = TimeZoneInfo.FindSystemTimeZoneById(timezoneId);
		}
		catch
		{
			timezone = TimeZoneInfo.Utc;
		}

		var buckets = new Dictionary<int, int>();
		foreach (var ev in events)
		{
			var local = TimeZoneInfo.ConvertTime(ev.TimestampUtc, timezone);
			var hour = local.Hour;
			if (!buckets.TryGetValue(hour, out var count))
			{
				buckets[hour] = 1;
			}
			else
			{
				buckets[hour] = count + 1;
			}
		}

		return buckets
			.OrderBy(x => x.Key)
			.Select(x => new RecapHourBucket(x.Key, x.Value))
			.ToArray();
	}

	private static string BuildDayAnswer(RecapDaySummary summary, IReadOnlyList<RecapSessionSummary> sessions)
	{
		var topSessionNames = sessions
			.Take(3)
			.Select(x => string.IsNullOrWhiteSpace(x.ThreadName) ? x.ThreadId : x.ThreadName)
			.Where(x => !string.IsNullOrWhiteSpace(x))
			.ToArray();
		var topSessionsText = topSessionNames.Length > 0
			? $"Top active sessions: {string.Join(", ", topSessionNames)}."
			: "No active sessions were detected.";
		return $"Captured {summary.EventCount} events across {summary.ActiveThreadCount} sessions. " +
			$"User prompts: {summary.UserPromptCount}, assistant messages: {summary.AssistantMessageCount}, tool calls: {summary.ToolCallCount}. " +
			topSessionsText;
	}

	private static string BuildQueryAnswer(
		DateOnly localDate,
		string query,
		IReadOnlyList<ScoredRecapEvent> matches,
		IReadOnlyList<RecapThreadMatchSummary> threadSummaries)
	{
		var dayText = localDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
		if (matches.Count <= 0)
		{
			return $"No recap matches were found for '{query}' on {dayText}.";
		}

		var topThreads = threadSummaries
			.Take(3)
			.Select(x => string.IsNullOrWhiteSpace(x.ThreadName) ? x.ThreadId : x.ThreadName)
			.Where(x => !string.IsNullOrWhiteSpace(x))
			.ToArray();
		var threadText = topThreads.Length > 0 ? string.Join(", ", topThreads) : "unknown sessions";
		return $"Found {matches.Count} matching events in {threadSummaries.Count} sessions on {dayText}. " +
			$"Strongest matches are in: {threadText}.";
	}

	private static void ReadSessionEvents(
		RecapThreadMeta thread,
		DateTimeOffset windowStartUtc,
		DateTimeOffset windowEndUtc,
		List<RecapEvent> destination)
	{
		if (string.IsNullOrWhiteSpace(thread.SessionFilePath) || !File.Exists(thread.SessionFilePath))
		{
			return;
		}

		try
		{
			using var stream = new FileStream(thread.SessionFilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
			using var reader = new StreamReader(stream);
			while (!reader.EndOfStream)
			{
				var line = reader.ReadLine();
				if (string.IsNullOrWhiteSpace(line))
				{
					continue;
				}

				try
				{
					using var doc = JsonDocument.Parse(line);
					var root = doc.RootElement;
					if (root.ValueKind != JsonValueKind.Object)
					{
						continue;
					}

					var timestampUtc = TryGetTimestampUtc(root);
					if (timestampUtc is null)
					{
						continue;
					}

					if (timestampUtc < windowStartUtc || timestampUtc >= windowEndUtc)
					{
						continue;
					}

					var lineType = TryGetString(root, "type");
					if (string.Equals(lineType, "response_item", StringComparison.Ordinal))
					{
						if (!TryGetProperty(root, "payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
						{
							continue;
						}

						ReadResponseItemEvents(
							thread,
							payload,
							timestampUtc.Value,
							destination);
						continue;
					}

					if (string.Equals(lineType, "event_msg", StringComparison.Ordinal))
					{
						if (!TryGetProperty(root, "payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
						{
							continue;
						}

						ReadEventMessageEvents(
							thread,
							payload,
							timestampUtc.Value,
							destination);
					}
				}
				catch
				{
				}
			}
		}
		catch
		{
		}
	}

	private static void ReadResponseItemEvents(
		RecapThreadMeta thread,
		JsonElement payload,
		DateTimeOffset timestampUtc,
		List<RecapEvent> destination)
	{
		var payloadType = NormalizeText(TryGetString(payload, "type"));
		if (string.Equals(payloadType, "message", StringComparison.Ordinal))
		{
			var role = NormalizeText(TryGetString(payload, "role"));
			if (!string.Equals(role, "assistant", StringComparison.Ordinal))
			{
				return;
			}

			var text = ExtractMessageText(TryGetProperty(payload, "content"));
			if (string.IsNullOrWhiteSpace(text))
			{
				return;
			}

			destination.Add(new RecapEvent(
				TimestampUtc: timestampUtc,
				ThreadId: thread.ThreadId,
				EventType: RecapEventTypes.AssistantMessage,
				Text: TruncateForStorage(text, 3000),
				Command: null));
			return;
		}

		if (string.Equals(payloadType, "function_call", StringComparison.Ordinal) ||
			string.Equals(payloadType, "custom_tool_call", StringComparison.Ordinal))
		{
			var name = NormalizeText(TryGetString(payload, "name"));
			var argumentsRaw = TryGetString(payload, "arguments") ?? TryGetString(payload, "input");
			var command = ExtractToolCommand(argumentsRaw);
			var textParts = new List<string>();
			if (!string.IsNullOrWhiteSpace(name))
			{
				textParts.Add($"Tool: {name}");
			}
			if (!string.IsNullOrWhiteSpace(command))
			{
				textParts.Add(command);
			}

			var text = textParts.Count > 0
				? string.Join(" | ", textParts)
				: "Tool call";
			destination.Add(new RecapEvent(
				TimestampUtc: timestampUtc,
				ThreadId: thread.ThreadId,
				EventType: RecapEventTypes.ToolCall,
				Text: TruncateForStorage(text, 3000),
				Command: TruncateForStorage(command, 3000)));
		}
	}

	private static void ReadEventMessageEvents(
		RecapThreadMeta thread,
		JsonElement payload,
		DateTimeOffset timestampUtc,
		List<RecapEvent> destination)
	{
		var payloadType = NormalizeText(TryGetString(payload, "type"));
		if (!string.Equals(payloadType, "task_started", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "task_complete", StringComparison.Ordinal))
		{
			return;
		}

		var message = NormalizeText(TryGetString(payload, "message") ?? TryGetString(payload, "title"));
		if (string.IsNullOrWhiteSpace(message))
		{
			return;
		}

		destination.Add(new RecapEvent(
			TimestampUtc: timestampUtc,
			ThreadId: thread.ThreadId,
			EventType: payloadType,
			Text: TruncateForStorage(message, 1200),
			Command: null));
	}

	private void ReadHistoryEvents(
		DateTimeOffset windowStartUtc,
		DateTimeOffset windowEndUtc,
		Dictionary<string, RecapThreadMeta> threadById,
		List<RecapEvent> destination)
	{
		var codexHome = CodexHomePaths.ResolveCodexHomePath(_defaults.CodexHomePath);
		var historyPath = Path.Combine(codexHome, "history.jsonl");
		if (!File.Exists(historyPath))
		{
			return;
		}

		var dedupeKeys = new HashSet<string>(StringComparer.Ordinal);
		try
		{
			foreach (var line in File.ReadLines(historyPath))
			{
				if (string.IsNullOrWhiteSpace(line))
				{
					continue;
				}

				try
				{
					using var doc = JsonDocument.Parse(line);
					var root = doc.RootElement;
					if (root.ValueKind != JsonValueKind.Object)
					{
						continue;
					}

					var threadId = NormalizeText(TryGetString(root, "session_id"));
					var text = NormalizeText(TryGetString(root, "text"));
					if (string.IsNullOrWhiteSpace(threadId) || string.IsNullOrWhiteSpace(text))
					{
						continue;
					}

					if (!TryReadUnixSeconds(root, "ts", out var timestampUtc))
					{
						continue;
					}

					if (timestampUtc < windowStartUtc || timestampUtc >= windowEndUtc)
					{
						continue;
					}

					if (!threadById.ContainsKey(threadId))
					{
						threadById[threadId] = RecapThreadMeta.Empty(threadId);
					}

					var dedupeKey = string.Create(
						CultureInfo.InvariantCulture,
						$"{threadId}|{timestampUtc.ToUnixTimeSeconds()}|{text}");
					if (!dedupeKeys.Add(dedupeKey))
					{
						continue;
					}

					destination.Add(new RecapEvent(
						TimestampUtc: timestampUtc,
						ThreadId: threadId,
						EventType: RecapEventTypes.UserPrompt,
						Text: TruncateForStorage(text, 3000),
						Command: null));
				}
				catch
				{
				}
			}
		}
		catch
		{
		}
	}

	private static TimeZoneInfo ResolveTimezone(string? timezoneId)
	{
		if (!string.IsNullOrWhiteSpace(timezoneId))
		{
			try
			{
				return TimeZoneInfo.FindSystemTimeZoneById(timezoneId.Trim());
			}
			catch
			{
			}
		}

		return TimeZoneInfo.Local;
	}

	private static (DateTimeOffset WindowStartUtc, DateTimeOffset WindowEndUtc) GetUtcWindow(DateOnly localDate, TimeZoneInfo timezone)
	{
		var startLocal = localDate.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);
		var endLocal = localDate.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);
		var startUtc = ConvertLocalToUtcSafe(startLocal, timezone);
		var endUtc = ConvertLocalToUtcSafe(endLocal, timezone);
		return (startUtc, endUtc);
	}

	private static DateTimeOffset ConvertLocalToUtcSafe(DateTime local, TimeZoneInfo timezone)
	{
		if (timezone.IsInvalidTime(local))
		{
			local = local.AddHours(1);
		}

		if (timezone.IsAmbiguousTime(local))
		{
			var offsets = timezone.GetAmbiguousTimeOffsets(local);
			var offset = offsets.Length > 0 ? offsets.Max() : timezone.GetUtcOffset(local);
			return new DateTimeOffset(local, offset).ToUniversalTime();
		}

		var utc = TimeZoneInfo.ConvertTimeToUtc(local, timezone);
		return new DateTimeOffset(utc, TimeSpan.Zero);
	}

	private static DateTimeOffset? TryGetTimestampUtc(JsonElement root)
	{
		var timestampRaw = TryGetString(root, "timestamp");
		if (string.IsNullOrWhiteSpace(timestampRaw))
		{
			return null;
		}

		if (!DateTimeOffset.TryParse(timestampRaw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
		{
			return null;
		}

		return parsed.ToUniversalTime();
	}

	private static bool TryReadUnixSeconds(JsonElement root, string key, out DateTimeOffset timestampUtc)
	{
		timestampUtc = default;
		if (!TryGetProperty(root, key, out var value))
		{
			return false;
		}

		long seconds;
		switch (value.ValueKind)
		{
			case JsonValueKind.Number:
				if (!value.TryGetInt64(out seconds))
				{
					return false;
				}
				break;
			case JsonValueKind.String:
				if (!long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out seconds))
				{
					return false;
				}
				break;
			default:
				return false;
		}

		try
		{
			timestampUtc = DateTimeOffset.FromUnixTimeSeconds(seconds);
			return true;
		}
		catch
		{
			return false;
		}
	}

	private static string? ExtractToolCommand(string? rawArguments)
	{
		if (string.IsNullOrWhiteSpace(rawArguments))
		{
			return null;
		}

		try
		{
			using var doc = JsonDocument.Parse(rawArguments);
			var root = doc.RootElement;
			if (root.ValueKind != JsonValueKind.Object)
			{
				return TruncateForStorage(NormalizeText(rawArguments), 2000);
			}

			var direct = NormalizeText(TryGetString(root, "command"));
			if (!string.IsNullOrWhiteSpace(direct))
			{
				return TruncateForStorage(direct, 2000);
			}

			if (TryGetProperty(root, "tool_uses", out var toolUses) && toolUses.ValueKind == JsonValueKind.Array)
			{
				var commands = new List<string>();
				foreach (var item in toolUses.EnumerateArray())
				{
					if (item.ValueKind != JsonValueKind.Object)
					{
						continue;
					}

					var recipient = NormalizeText(TryGetString(item, "recipient_name"));
					var parameters = TryGetProperty(item, "parameters", out var parametersValue)
						? parametersValue
						: default;
					var command = parameters.ValueKind == JsonValueKind.Object
						? NormalizeText(TryGetString(parameters, "command"))
						: string.Empty;
					if (string.IsNullOrWhiteSpace(recipient) && string.IsNullOrWhiteSpace(command))
					{
						continue;
					}

					var combined = string.IsNullOrWhiteSpace(command)
						? recipient
						: $"{recipient}: {command}";
					commands.Add(combined);
				}

				if (commands.Count > 0)
				{
					return TruncateForStorage(string.Join("\n", commands), 2000);
				}
			}

			return TruncateForStorage(NormalizeText(rawArguments), 2000);
		}
		catch
		{
			return TruncateForStorage(NormalizeText(rawArguments), 2000);
		}
	}

	private static string ExtractMessageText(JsonElement? content)
	{
		if (content is not JsonElement value)
		{
			return string.Empty;
		}

		switch (value.ValueKind)
		{
			case JsonValueKind.String:
				return NormalizeText(value.GetString());
			case JsonValueKind.Array:
			{
				var parts = new List<string>();
				foreach (var item in value.EnumerateArray())
				{
					var text = ExtractTextFromElement(item, depth: 0);
					if (!string.IsNullOrWhiteSpace(text))
					{
						parts.Add(text);
					}
				}

				return NormalizeText(string.Join("\n", parts));
			}
			default:
				return string.Empty;
		}
	}

	private static string ExtractTextFromElement(JsonElement value, int depth)
	{
		if (depth > 6)
		{
			return string.Empty;
		}

		switch (value.ValueKind)
		{
			case JsonValueKind.String:
				return NormalizeText(value.GetString());
			case JsonValueKind.Object:
			{
				var direct = NormalizeText(
					TryGetString(value, "text") ??
					TryGetString(value, "output_text") ??
					TryGetString(value, "outputText") ??
					TryGetString(value, "message"));
				if (!string.IsNullOrWhiteSpace(direct))
				{
					return direct;
				}

				var nestedKeys = new[] { "content", "parts", "items", "data" };
				foreach (var key in nestedKeys)
				{
					if (!TryGetProperty(value, key, out var nested))
					{
						continue;
					}

					var nestedText = ExtractTextFromElement(nested, depth + 1);
					if (!string.IsNullOrWhiteSpace(nestedText))
					{
						return nestedText;
					}
				}

				return string.Empty;
			}
			case JsonValueKind.Array:
			{
				var parts = new List<string>();
				foreach (var nested in value.EnumerateArray())
				{
					var next = ExtractTextFromElement(nested, depth + 1);
					if (!string.IsNullOrWhiteSpace(next))
					{
						parts.Add(next);
					}
				}

				return NormalizeText(string.Join("\n", parts));
			}
			default:
				return string.Empty;
		}
	}

	private static IReadOnlyList<string> TokenizeQuery(string query)
	{
		if (string.IsNullOrWhiteSpace(query))
		{
			return Array.Empty<string>();
		}

		var tokens = QueryTokenRegex.Matches(query)
			.Select(x => x.Value.Trim().ToLowerInvariant())
			.Where(x => x.Length >= 2 && !QueryStopWords.Contains(x))
			.Distinct(StringComparer.Ordinal)
			.Take(16)
			.ToArray();
		if (tokens.Length > 0)
		{
			return tokens;
		}

		var fallback = query.Trim().ToLowerInvariant();
		return fallback.Length > 1 ? new[] { fallback } : Array.Empty<string>();
	}

	private static string ExtractCommandHead(string? command)
	{
		var normalized = NormalizeText(command);
		if (string.IsNullOrWhiteSpace(normalized))
		{
			return string.Empty;
		}

		var firstLine = normalized.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
		if (string.IsNullOrWhiteSpace(firstLine))
		{
			return string.Empty;
		}

		var firstToken = firstLine.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
		return NormalizeText(firstToken);
	}

	private static bool TryGetProperty(JsonElement root, string key, out JsonElement value)
	{
		if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(key, out value))
		{
			return true;
		}

		value = default;
		return false;
	}

	private static JsonElement? TryGetProperty(JsonElement root, string key)
	{
		return TryGetProperty(root, key, out var value) ? value : null;
	}

	private static string? TryGetString(JsonElement root, string key)
	{
		if (!TryGetProperty(root, key, out var value))
		{
			return null;
		}

		return value.ValueKind switch
		{
			JsonValueKind.String => value.GetString(),
			JsonValueKind.Number => value.ToString(),
			JsonValueKind.True => "true",
			JsonValueKind.False => "false",
			_ => null
		};
	}

	private static string NormalizeText(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return string.Empty;
		}

		return value.Replace("\r", string.Empty).Trim();
	}

	private static string TruncateForStorage(string? text, int maxChars)
	{
		var normalized = NormalizeText(text);
		if (normalized.Length <= maxChars)
		{
			return normalized;
		}

		return normalized[..maxChars];
	}

	private static string TruncateForDisplay(string? text, int maxChars)
	{
		var normalized = NormalizeText(text);
		if (normalized.Length <= maxChars)
		{
			return normalized;
		}

		return normalized[..maxChars] + "...";
	}

	private static class RecapEventTypes
	{
		public const string UserPrompt = "user_prompt";
		public const string AssistantMessage = "assistant_message";
		public const string ToolCall = "tool_call";
	}

	private sealed record LoadedRecapContext(
		DateOnly LocalDate,
		string TimezoneId,
		DateTimeOffset WindowStartUtc,
		DateTimeOffset WindowEndUtc,
		Dictionary<string, RecapThreadMeta> ThreadById,
		List<RecapEvent> Events);

	private sealed record RecapThreadMeta(
		string ThreadId,
		string? ThreadName,
		string? Cwd,
		string? Model,
		string? SessionFilePath)
	{
		public static RecapThreadMeta Empty(string threadId)
		{
			return new RecapThreadMeta(threadId, null, null, null, null);
		}
	}

	private sealed record RecapEvent(
		DateTimeOffset TimestampUtc,
		string ThreadId,
		string EventType,
		string Text,
		string? Command);

	private sealed record ScoredRecapEvent(
		RecapEvent Event,
		int Score);
}

internal sealed class RecapQueryRequest
{
	public string? Query { get; init; }
	public string? LocalDate { get; init; }
	public string? Timezone { get; init; }
	public int MaxResults { get; init; } = 50;
	public int MaxSessions { get; init; } = 400;
}

internal sealed record RecapDayResponse(
	string LocalDate,
	string Timezone,
	string WindowStartUtc,
	string WindowEndUtc,
	RecapDaySummary Summary,
	IReadOnlyList<RecapSessionSummary> Sessions);

internal sealed record RecapQueryResponse(
	string LocalDate,
	string Timezone,
	string WindowStartUtc,
	string WindowEndUtc,
	string Query,
	string Answer,
	RecapDaySummary Summary,
	IReadOnlyList<RecapThreadMatchSummary> Threads,
	IReadOnlyList<RecapMatchItem> Matches);

internal sealed record RecapDaySummary(
	int EventCount,
	int ActiveThreadCount,
	int UserPromptCount,
	int AssistantMessageCount,
	int ToolCallCount,
	IReadOnlyList<RecapBucketItem> TopCommands,
	IReadOnlyList<RecapBucketItem> TopTopics,
	IReadOnlyList<RecapHourBucket> ActivityByHour);

internal sealed record RecapSessionSummary(
	string ThreadId,
	string? ThreadName,
	string? Cwd,
	string? Model,
	string? SessionFilePath,
	int EventCount,
	int UserPromptCount,
	int AssistantMessageCount,
	int ToolCallCount,
	string? FirstEventUtc,
	string? LastEventUtc,
	IReadOnlyList<string> PromptSamples,
	IReadOnlyList<string> CommandSamples);

internal sealed record RecapThreadMatchSummary(
	string ThreadId,
	string? ThreadName,
	string? Cwd,
	string? Model,
	string? SessionFilePath,
	int MatchCount,
	int TopScore,
	string LastMatchUtc,
	IReadOnlyList<string> SampleMatches);

internal sealed record RecapMatchItem(
	string ThreadId,
	string? ThreadName,
	string? Cwd,
	string? Model,
	string? SessionFilePath,
	string TimestampUtc,
	string EventType,
	string Text,
	string? Command,
	int Score);

internal sealed record RecapBucketItem(
	string Value,
	int Count);

internal sealed record RecapHourBucket(
	int Hour,
	int Count);
