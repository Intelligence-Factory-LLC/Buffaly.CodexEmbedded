using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

internal sealed class TimelineProjectionService
{
	private readonly ConcurrentDictionary<string, TimelineProjectionState> _stateByThread = new(StringComparer.Ordinal);

	public TimelineProjectionResult Project(string threadId, JsonlWatchResult watchResult, bool initial)
	{
		var normalizedThreadId = string.IsNullOrWhiteSpace(threadId) ? string.Empty : threadId.Trim();
		if (string.IsNullOrWhiteSpace(normalizedThreadId))
		{
			return new TimelineProjectionResult(Array.Empty<TimelineProjectedEntry>(), null, null, string.Empty);
		}

		var state = _stateByThread.GetOrAdd(normalizedThreadId, _ => new TimelineProjectionState());
		if (initial || watchResult.Reset || watchResult.Cursor == 0)
		{
			state.Reset();
		}

		var entries = new List<TimelineProjectedEntry>();
		foreach (var line in watchResult.Lines)
		{
			ParseLine(state, line, entries);
		}

		state.LastCursor = watchResult.NextCursor;
		state.LastFileLength = watchResult.FileLength;
		return new TimelineProjectionResult(entries, state.ContextUsage, state.Permission, state.ReasoningSummary);
	}

	private static void ParseLine(TimelineProjectionState state, string line, List<TimelineProjectedEntry> entries)
	{
		if (string.IsNullOrWhiteSpace(line))
		{
			return;
		}

		try
		{
			using var doc = JsonDocument.Parse(line);
			var root = doc.RootElement;
			if (root.ValueKind != JsonValueKind.Object)
			{
				return;
			}

			var lineType = TryGetString(root, "type") ?? string.Empty;
			var timestamp = TryGetString(root, "timestamp");
			var payload = TryGetProperty(root, "payload");

			switch (lineType)
			{
				case "session_meta":
					if (payload is JsonElement sessionMeta)
					{
						UpdateSessionMeta(state, sessionMeta);
						var details = new List<string>();
						var thread = TryGetString(sessionMeta, "id");
						if (!string.IsNullOrWhiteSpace(thread))
						{
							details.Add($"thread={thread}");
						}
						var provider = TryGetString(sessionMeta, "model_provider");
						if (!string.IsNullOrWhiteSpace(provider))
						{
							details.Add($"provider={provider}");
						}
						var cwd = TryGetString(sessionMeta, "cwd");
						if (!string.IsNullOrWhiteSpace(cwd))
						{
							details.Add($"cwd={cwd}");
						}
						if (details.Count > 0)
						{
							Emit(state, entries, state.CreateEntry("system", "Session Meta", string.Join(" | ", details), timestamp, "session_meta", compact: false));
						}
					}
					return;
				case "turn_context":
					if (payload is JsonElement turnContext)
					{
						UpdateSessionMeta(state, turnContext);
						UpdateContextUsage(state, turnContext, "turn_context");
					}
					return;
				case "response_item":
					if (payload is JsonElement responseItem)
					{
						UpdateSessionMeta(state, responseItem);
						ParseResponseItem(state, responseItem, timestamp, entries);
					}
					return;
				case "event_msg":
					if (payload is JsonElement eventPayload)
					{
						UpdateSessionMeta(state, eventPayload);
						ParseEventPayload(state, eventPayload, timestamp, entries);
					}
					return;
				default:
					return;
			}
		}
		catch
		{
		}
	}

	private static void UpdateSessionMeta(TimelineProjectionState state, JsonElement payload)
	{
		var model = ExtractModel(payload);
		if (!string.IsNullOrWhiteSpace(model))
		{
			state.LatestTurnModel = model;
		}

		var permission = ReadPermission(payload);
		if (permission is not null)
		{
			state.Permission = permission;
		}

		var reasoning = ExtractReasoningSummary(payload);
		if (!string.IsNullOrWhiteSpace(reasoning))
		{
			state.ReasoningSummary = reasoning;
		}
	}

	private static void Emit(TimelineProjectionState state, List<TimelineProjectedEntry> entries, TimelineProjectedEntry entry)
	{
		state.Track(entry);
		entries.Add(entry.Clone());
	}

	private static string NormalizeText(string? text)
	{
		if (string.IsNullOrWhiteSpace(text))
		{
			return string.Empty;
		}

		return text.Replace("\r", string.Empty).TrimEnd();
	}

	private static string Truncate(string? text, int maxChars)
	{
		var normalized = NormalizeText(text);
		if (normalized.Length <= maxChars)
		{
			return normalized;
		}

		return $"{normalized[..maxChars]}\n... (truncated)";
	}

	private static JsonElement? TryGetProperty(JsonElement? element, string propertyName)
	{
		if (element is not JsonElement value || value.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		return value.TryGetProperty(propertyName, out var result) ? result : null;
	}

	private static string? TryGetString(JsonElement? element, string propertyName)
	{
		if (element is not JsonElement value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(propertyName, out var result))
		{
			return null;
		}

		return result.ValueKind switch
		{
			JsonValueKind.String => result.GetString(),
			JsonValueKind.Number => result.ToString(),
			JsonValueKind.True => "true",
			JsonValueKind.False => "false",
			_ => null
		};
	}

	private static double? TryReadDouble(string? raw)
	{
		if (string.IsNullOrWhiteSpace(raw))
		{
			return null;
		}

		if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
		{
			return null;
		}

		return parsed >= 0 ? parsed : null;
	}

	private static void ParseResponseItem(TimelineProjectionState state, JsonElement payload, string? timestamp, List<TimelineProjectedEntry> entries)
	{
		var payloadType = TryGetString(payload, "type") ?? string.Empty;
		switch (payloadType)
		{
			case "message":
			{
				var role = TryGetString(payload, "role") ?? string.Empty;
				var parts = ReadMessageParts(TryGetProperty(payload, "content"));
				if (string.IsNullOrWhiteSpace(parts.Text) && parts.Images.Count == 0)
				{
					return;
				}

				if (!string.Equals(role, "assistant", StringComparison.Ordinal) &&
					!string.Equals(role, "user", StringComparison.Ordinal))
				{
					return;
				}

				var title = string.Equals(role, "assistant", StringComparison.Ordinal) ? "Assistant" : "User";
				var entry = state.CreateEntry(role, title, parts.Text, timestamp, "message", compact: false);
				entry.Images = parts.Images.ToArray();
				state.AttachTaskContext(entry);
				Emit(state, entries, entry);
				return;
			}
			case "function_call":
			case "custom_tool_call":
			{
				var name = TryGetString(payload, "name") ?? "tool";
				var callId = TryGetString(payload, "call_id");
				var rawArguments = TryGetString(payload, "arguments") ?? TryGetString(payload, "input") ?? string.Empty;
				var command = ExtractToolCommand(name, rawArguments);
				var detailLines = ExtractToolDetails(rawArguments);
				var body = FormatToolEntryText(command, detailLines, "(waiting for output)");
				var entry = state.CreateEntry("tool", $"Tool Call: {name}", body, timestamp, payloadType, compact: false);
				entry.Command = command;
				entry.Details = detailLines;
				state.AttachTaskContext(entry);
				Emit(state, entries, entry);
				if (!string.IsNullOrWhiteSpace(callId))
				{
					state.ToolEntryByCallId[callId] = entry.Id;
				}
				return;
			}
			case "function_call_output":
			case "custom_tool_call_output":
			{
				var callId = TryGetString(payload, "call_id");
				var output = FormatToolOutput(TryGetProperty(payload, "output") ?? TryGetProperty(payload, "result") ?? TryGetProperty(payload, "content"));
				if (!string.IsNullOrWhiteSpace(callId) &&
					state.ToolEntryByCallId.TryGetValue(callId, out var trackedEntryId) &&
					state.TryGetTrackedEntry(trackedEntryId, out var tracked))
				{
					tracked.Text = FormatToolEntryText(tracked.Command, tracked.Details, output);
					tracked.Timestamp = timestamp ?? tracked.Timestamp;
					tracked.RawType = payloadType;
					Emit(state, entries, tracked);
					return;
				}

				var entry = state.CreateEntry("tool", "Tool Output", output, timestamp, payloadType, compact: false);
				state.AttachTaskContext(entry);
				Emit(state, entries, entry);
				return;
			}
			case "reasoning":
			{
				var summary = ExtractReasoningSummary(payload);
				if (string.IsNullOrWhiteSpace(summary))
				{
					return;
				}

				state.ReasoningSummary = summary;
				var entry = state.CreateEntry("reasoning", "Reasoning Summary", Truncate(summary, 1200), timestamp, "reasoning", compact: false);
				state.AttachTaskContext(entry);
				Emit(state, entries, entry);
				return;
			}
			default:
				return;
		}
	}

	private static void ParseEventPayload(TimelineProjectionState state, JsonElement payload, string? timestamp, List<TimelineProjectedEntry> entries)
	{
		var eventType = TryGetString(payload, "type") ?? string.Empty;
		if (string.Equals(eventType, "token_count", StringComparison.Ordinal))
		{
			UpdateContextUsage(state, payload, "token_count");
			return;
		}

		if (string.Equals(eventType, "thread_compacted", StringComparison.Ordinal) ||
			string.Equals(eventType, "thread/compacted", StringComparison.Ordinal))
		{
			UpdateContextUsage(state, payload, "thread_compacted");
			var summary = TryGetString(payload, "summary") ?? TryGetString(payload, "message") ?? "Context compressed";
			var contextLeft = FormatContextLeftLabel(state.ContextUsage);
			var parts = string.IsNullOrWhiteSpace(contextLeft) ? summary : $"{summary} | {contextLeft}";
			var entry = state.CreateEntry("system", "Context Compression", Truncate(parts, 240), timestamp, eventType, compact: true);
			state.AttachTaskContext(entry);
			Emit(state, entries, entry);
			return;
		}

		if (string.Equals(eventType, "task_started", StringComparison.Ordinal))
		{
			UpdateContextUsage(state, payload, "task_started");
			var summary = TryGetString(payload, "title") ?? TryGetString(payload, "message") ?? "Task started";
			var entry = state.CreateEntry("system", "Task Started", Truncate(summary, 240), timestamp, eventType, compact: true);
			state.MarkTaskStart(entry);
			var taskModel = !string.IsNullOrWhiteSpace(state.LatestTurnModel) ? state.LatestTurnModel : state.CurrentSessionModel;
			if (!string.IsNullOrWhiteSpace(taskModel) && !string.IsNullOrWhiteSpace(entry.TaskId))
			{
				state.TaskModelByTaskId[entry.TaskId] = taskModel;
			}
			Emit(state, entries, entry);
			return;
		}

		if (string.Equals(eventType, "task_complete", StringComparison.Ordinal))
		{
			UpdateContextUsage(state, payload, "task_complete");
			var summary = TryGetString(payload, "message") ?? "Task complete";
			var taskModel = string.Empty;
			if (!string.IsNullOrWhiteSpace(state.CurrentTaskId) &&
				state.TaskModelByTaskId.TryGetValue(state.CurrentTaskId, out var trackedModel))
			{
				taskModel = trackedModel;
			}
			if (string.IsNullOrWhiteSpace(taskModel))
			{
				taskModel = !string.IsNullOrWhiteSpace(state.LatestTurnModel) ? state.LatestTurnModel : state.CurrentSessionModel;
			}

			var contextLeft = FormatContextLeftLabel(state.ContextUsage);
			var parts = new List<string> { summary };
			if (!string.IsNullOrWhiteSpace(contextLeft))
			{
				parts.Add(contextLeft);
			}
			if (!string.IsNullOrWhiteSpace(taskModel))
			{
				parts.Add($"Model: {taskModel}");
			}
			var entry = state.CreateEntry("system", "Task Complete", Truncate(string.Join(" | ", parts), 240), timestamp, eventType, compact: true);
			state.MarkTaskEnd(entry);
			if (!string.IsNullOrWhiteSpace(entry.TaskId))
			{
				state.TaskModelByTaskId.Remove(entry.TaskId);
			}
			Emit(state, entries, entry);
			return;
		}

		if (string.Equals(eventType, "agent_message", StringComparison.Ordinal) ||
			string.Equals(eventType, "agent_reasoning", StringComparison.Ordinal) ||
			string.Equals(eventType, "user_message", StringComparison.Ordinal))
		{
			return;
		}

		var genericMessage = TryGetString(payload, "message") ?? TryGetString(payload, "summary");
		if (!string.IsNullOrWhiteSpace(genericMessage))
		{
			var entry = state.CreateEntry("system", $"Event: {eventType}", Truncate(genericMessage, 1200), timestamp, eventType, compact: false);
			state.AttachTaskContext(entry);
			Emit(state, entries, entry);
		}
	}

	private static void UpdateContextUsage(TimelineProjectionState state, JsonElement payload, string sourceTag)
	{
		var payloadType = TryGetString(payload, "type") ?? string.Empty;
		if (string.Equals(payloadType, "token_count", StringComparison.Ordinal))
		{
			var next = ReadTokenUsage(payload);
			if (next is not null)
			{
				state.ApplyContext(next, sourceTag);
			}
			return;
		}

		if (string.Equals(payloadType, "task_started", StringComparison.Ordinal))
		{
			var modelContextWindow = TryReadDouble(TryGetString(payload, "model_context_window") ?? TryGetString(payload, "modelContextWindow"));
			if (modelContextWindow is not null)
			{
				state.ApplyContext(new TimelineContextUsage(state.ContextUsage?.UsedTokens, modelContextWindow, state.ContextUsage?.PercentLeft), sourceTag);
			}
			return;
		}

		if (!string.Equals(payloadType, "thread_compacted", StringComparison.Ordinal) &&
			!string.Equals(payloadType, "thread/compacted", StringComparison.Ordinal))
		{
			return;
		}

		var contextWindow = TryReadDouble(
			TryGetString(payload, "contextWindow")
			?? TryGetString(payload, "context_window")
			?? TryGetString(payload, "modelContextWindow")
			?? TryGetString(payload, "model_context_window"));
		var usedTokens = TryReadDouble(
			TryGetString(payload, "usedTokensAfter")
			?? TryGetString(payload, "used_tokens_after")
			?? TryGetString(payload, "tokensAfter")
			?? TryGetString(payload, "tokens_after")
			?? TryGetString(payload, "usedTokens")
			?? TryGetString(payload, "used_tokens"));
		var percentLeft = TryReadDouble(
			TryGetString(payload, "percentLeft")
			?? TryGetString(payload, "percent_left")
			?? TryGetString(payload, "contextPercentLeft")
			?? TryGetString(payload, "context_percent_left"));
		state.ApplyContext(new TimelineContextUsage(usedTokens, contextWindow, percentLeft), sourceTag);
	}

	private static TimelineContextUsage? ReadTokenUsage(JsonElement payload)
	{
		var info = TryGetProperty(payload, "info");
		if (info is not JsonElement infoElement || infoElement.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		var contextWindow = TryReadDouble(TryGetString(infoElement, "model_context_window") ?? TryGetString(infoElement, "modelContextWindow"));
		var lastUsage = TryGetProperty(infoElement, "last_token_usage") ?? TryGetProperty(infoElement, "lastTokenUsage") ?? TryGetProperty(infoElement, "last");
		var totalUsage = TryGetProperty(infoElement, "total_token_usage") ?? TryGetProperty(infoElement, "totalTokenUsage") ?? TryGetProperty(infoElement, "total");

		var lastInput = ReadUsageNumber(lastUsage, "input_tokens", "inputTokens");
		var lastTotal = ReadUsageNumber(lastUsage, "total_tokens", "totalTokens");
		var totalInput = ReadUsageNumber(totalUsage, "input_tokens", "inputTokens");
		var cumulativeTotal = ReadUsageNumber(totalUsage, "total_tokens", "totalTokens");
		double? usedTokens = lastInput ?? lastTotal ?? totalInput ?? cumulativeTotal;
		if (contextWindow is null && usedTokens is null)
		{
			return null;
		}

		return new TimelineContextUsage(usedTokens, contextWindow, null);
	}

	private static double? ReadUsageNumber(JsonElement? usage, string snakeKey, string camelKey)
	{
		if (usage is not JsonElement element || element.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		return TryReadDouble(TryGetString(element, snakeKey) ?? TryGetString(element, camelKey));
	}

	private static string? FormatContextLeftLabel(TimelineContextUsage? usage)
	{
		if (usage is null || usage.PercentLeft is null)
		{
			return null;
		}

		var rounded = Math.Max(0, Math.Min(100, (int)Math.Round(usage.PercentLeft.Value, MidpointRounding.AwayFromZero)));
		return $"{rounded}% context left";
	}

	private static TimelinePermissionInfo? ReadPermission(JsonElement payload)
	{
		var approval = NormalizePermission(
			TryGetString(payload, "approval_policy")
			?? TryGetString(payload, "approvalPolicy")
			?? TryGetString(payload, "approval_mode")
			?? TryGetString(payload, "approvalMode"));
		var sandbox = NormalizePermission(
			TryGetString(payload, "sandbox_policy")
			?? TryGetString(payload, "sandboxPolicy")
			?? TryGetString(payload, "sandbox_mode")
			?? TryGetString(payload, "sandboxMode")
			?? TryGetString(payload, "sandbox"));
		if (string.IsNullOrWhiteSpace(approval) && string.IsNullOrWhiteSpace(sandbox))
		{
			return null;
		}

		return new TimelinePermissionInfo(approval ?? string.Empty, sandbox ?? string.Empty);
	}

	private static string? NormalizePermission(string? value)
	{
		return string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
	}

	private static string ExtractReasoningSummary(JsonElement payload)
	{
		var summary = TryGetProperty(payload, "summary");
		if (summary is JsonElement summaryElement)
		{
			if (summaryElement.ValueKind == JsonValueKind.String)
			{
				return NormalizeText(summaryElement.GetString());
			}
			if (summaryElement.ValueKind == JsonValueKind.Array)
			{
				var parts = new List<string>();
				foreach (var item in summaryElement.EnumerateArray())
				{
					if (item.ValueKind == JsonValueKind.String)
					{
						var text = NormalizeText(item.GetString());
						if (!string.IsNullOrWhiteSpace(text))
						{
							parts.Add(text);
						}
						continue;
					}

					if (item.ValueKind == JsonValueKind.Object)
					{
						var text = NormalizeText(TryGetString(item, "text"));
						if (!string.IsNullOrWhiteSpace(text))
						{
							parts.Add(text);
						}
					}
				}
				if (parts.Count > 0)
				{
					return string.Join("\n", parts);
				}
			}
		}

		var isReasoningType = string.Equals(TryGetString(payload, "type"), "reasoning", StringComparison.OrdinalIgnoreCase);
		if (isReasoningType)
		{
			return NormalizeText(TryGetString(payload, "message") ?? TryGetString(payload, "content"));
		}

		return string.Empty;
	}

	private static string ExtractModel(JsonElement payload)
	{
		var directKeys = new[] { "model", "modelName", "model_name", "selectedModel", "selected_model" };
		foreach (var key in directKeys)
		{
			var value = TryGetString(payload, key);
			if (!string.IsNullOrWhiteSpace(value))
			{
				var normalized = NormalizeText(value);
				return normalized.Length > 200 ? normalized[..200] : normalized;
			}
		}

		if (TryGetProperty(payload, "info") is JsonElement info && info.ValueKind == JsonValueKind.Object)
		{
			foreach (var key in directKeys)
			{
				var value = TryGetString(info, key);
				if (!string.IsNullOrWhiteSpace(value))
				{
					var normalized = NormalizeText(value);
					return normalized.Length > 200 ? normalized[..200] : normalized;
				}
			}
		}

		return string.Empty;
	}

	private static (string Text, List<string> Images) ReadMessageParts(JsonElement? content)
	{
		var images = new List<string>();
		if (content is not JsonElement contentElement)
		{
			return (string.Empty, images);
		}

		if (contentElement.ValueKind == JsonValueKind.String)
		{
			return (NormalizeText(contentElement.GetString()), images);
		}

		if (contentElement.ValueKind != JsonValueKind.Array)
		{
			return (string.Empty, images);
		}

		var chunks = new List<string>();
		foreach (var item in contentElement.EnumerateArray())
		{
			if (item.ValueKind != JsonValueKind.Object)
			{
				continue;
			}

			var text = ExtractText(item, 0);
			if (!string.IsNullOrWhiteSpace(text))
			{
				chunks.Add(text);
				continue;
			}

			var type = TryGetString(item, "type") ?? string.Empty;
			if (string.Equals(type, "input_image", StringComparison.Ordinal) ||
				string.Equals(type, "image", StringComparison.Ordinal) ||
				string.Equals(type, "image_url", StringComparison.Ordinal) ||
				string.Equals(type, "inputImage", StringComparison.Ordinal))
			{
				var url = TryGetString(item, "url")
					?? TryGetString(item, "image_url")
					?? TryGetString(TryGetProperty(item, "image_url"), "url")
					?? TryGetString(item, "imageUrl")
					?? TryGetString(TryGetProperty(item, "imageUrl"), "url");
				if (!string.IsNullOrWhiteSpace(url))
				{
					images.Add(url.Trim());
				}
			}
		}

		return (NormalizeText(string.Join("\n", chunks)), images);
	}

	private static string ExtractText(JsonElement value, int depth)
	{
		if (depth > 6)
		{
			return string.Empty;
		}

		switch (value.ValueKind)
		{
			case JsonValueKind.String:
				return NormalizeText(value.GetString());
			case JsonValueKind.Number:
			case JsonValueKind.True:
			case JsonValueKind.False:
				return value.ToString();
			case JsonValueKind.Array:
			{
				var chunks = new List<string>();
				foreach (var item in value.EnumerateArray())
				{
					var nested = ExtractText(item, depth + 1);
					if (!string.IsNullOrWhiteSpace(nested))
					{
						chunks.Add(nested);
					}
				}
				return string.Join("\n", chunks);
			}
			case JsonValueKind.Object:
			{
				var direct = TryGetString(value, "text")
					?? TryGetString(value, "value")
					?? TryGetString(value, "output_text")
					?? TryGetString(value, "outputText")
					?? TryGetString(value, "message");
				if (!string.IsNullOrWhiteSpace(direct))
				{
					return NormalizeText(direct);
				}

				var nestedKeys = new[] { "content", "parts", "items", "message", "output", "data" };
				foreach (var key in nestedKeys)
				{
					var next = TryGetProperty(value, key);
					if (next is not JsonElement nestedElement)
					{
						continue;
					}

					var extracted = ExtractText(nestedElement, depth + 1);
					if (!string.IsNullOrWhiteSpace(extracted))
					{
						return extracted;
					}
				}
				return string.Empty;
			}
			default:
				return string.Empty;
		}
	}

	private static JsonElement? TryParseJson(string raw)
	{
		if (string.IsNullOrWhiteSpace(raw))
		{
			return null;
		}

		try
		{
			using var doc = JsonDocument.Parse(raw);
			return doc.RootElement.Clone();
		}
		catch
		{
			return null;
		}
	}

	private static string ExtractToolCommand(string toolName, string rawArguments)
	{
		if (string.IsNullOrWhiteSpace(rawArguments))
		{
			return string.Empty;
		}

		var parsed = TryParseJson(rawArguments);
		if (parsed is JsonElement args && args.ValueKind == JsonValueKind.Object)
		{
			var directCommand = TryGetString(args, "command");
			if (!string.IsNullOrWhiteSpace(directCommand))
			{
				return NormalizeText(directCommand);
			}

			if (string.Equals(toolName, "multi_tool_use.parallel", StringComparison.Ordinal) &&
				TryGetProperty(args, "tool_uses") is JsonElement uses &&
				uses.ValueKind == JsonValueKind.Array)
			{
				var lines = new List<string>();
				var idx = 0;
				foreach (var use in uses.EnumerateArray())
				{
					idx += 1;
					var recipient = TryGetString(use, "recipient_name") ?? "unknown_tool";
					var command = TryGetString(TryGetProperty(use, "parameters"), "command");
					if (!string.IsNullOrWhiteSpace(command))
					{
						lines.Add($"[{idx}] {recipient}: {NormalizeText(command)}");
					}
					else
					{
						lines.Add($"[{idx}] {recipient}");
					}
				}
				return string.Join("\n", lines);
			}
		}

		return Truncate(rawArguments, 1200);
	}

	private static List<string> ExtractToolDetails(string rawArguments)
	{
		var details = new List<string>();
		var parsed = TryParseJson(rawArguments);
		if (parsed is not JsonElement args || args.ValueKind != JsonValueKind.Object)
		{
			return details;
		}

		var workdir = TryGetString(args, "workdir");
		if (!string.IsNullOrWhiteSpace(workdir))
		{
			details.Add($"workdir={workdir}");
		}
		var timeout = TryGetString(args, "timeout_ms");
		if (!string.IsNullOrWhiteSpace(timeout))
		{
			details.Add($"timeoutMs={timeout}");
		}
		var sandbox = TryGetString(args, "sandbox_permissions");
		if (!string.IsNullOrWhiteSpace(sandbox))
		{
			details.Add($"sandbox={sandbox}");
		}
		var login = TryGetProperty(args, "login");
		if (login is JsonElement loginElement && (loginElement.ValueKind == JsonValueKind.True || loginElement.ValueKind == JsonValueKind.False))
		{
			details.Add($"login={loginElement.ToString()?.ToLowerInvariant()}");
		}
		return details;
	}

	private static string FormatToolOutput(JsonElement? outputElement)
	{
		if (outputElement is not JsonElement output || output.ValueKind == JsonValueKind.Null || output.ValueKind == JsonValueKind.Undefined)
		{
			return "(tool output unavailable)";
		}

		if (output.ValueKind == JsonValueKind.String)
		{
			return Truncate(output.GetString(), 5000);
		}

		return Truncate(output.ToString(), 5000);
	}

	private static string FormatToolEntryText(string command, IReadOnlyList<string> details, string output)
	{
		var lines = new List<string>
		{
			"Command:",
			string.IsNullOrWhiteSpace(command) ? "(command unavailable)" : command
		};
		if (details.Count > 0)
		{
			lines.Add(string.Empty);
			lines.Add("Context:");
			foreach (var detail in details)
			{
				lines.Add(detail);
			}
		}
		lines.Add(string.Empty);
		lines.Add("Result:");
		lines.Add(string.IsNullOrWhiteSpace(output) ? "(waiting for output)" : output);
		return string.Join("\n", lines);
	}
}

internal sealed class TimelineProjectionState
{
	private const int MaxTrackedEntries = 5000;
	private readonly Dictionary<long, TimelineProjectedEntry> _trackedById = new();
	private readonly Queue<long> _trackedOrder = new();

	public long NextEntryId { get; private set; } = 1;
	public long NextTaskGroupId { get; private set; } = 1;
	public List<string> ActiveTaskStack { get; } = new();
	public Dictionary<string, string> TaskModelByTaskId { get; } = new(StringComparer.Ordinal);
	public Dictionary<string, long> ToolEntryByCallId { get; } = new(StringComparer.Ordinal);
	public TimelineContextUsage? ContextUsage { get; private set; }
	public TimelinePermissionInfo? Permission { get; set; }
	public string CurrentSessionModel { get; set; } = string.Empty;
	public string LatestTurnModel { get; set; } = string.Empty;
	public string ReasoningSummary { get; set; } = string.Empty;
	public long LastCursor { get; set; }
	public long LastFileLength { get; set; }
	public string? CurrentTaskId => ActiveTaskStack.Count > 0 ? ActiveTaskStack[^1] : null;

	public void Reset()
	{
		NextEntryId = 1;
		NextTaskGroupId = 1;
		ActiveTaskStack.Clear();
		TaskModelByTaskId.Clear();
		ToolEntryByCallId.Clear();
		ContextUsage = null;
		Permission = null;
		CurrentSessionModel = string.Empty;
		LatestTurnModel = string.Empty;
		ReasoningSummary = string.Empty;
		LastCursor = 0;
		LastFileLength = 0;
		_trackedById.Clear();
		_trackedOrder.Clear();
	}

	public TimelineProjectedEntry CreateEntry(string role, string title, string text, string? timestamp, string rawType, bool compact)
	{
		var entry = new TimelineProjectedEntry
		{
			Id = NextEntryId,
			Role = string.IsNullOrWhiteSpace(role) ? "system" : role,
			Title = string.IsNullOrWhiteSpace(title) ? "System" : title,
			Text = text ?? string.Empty,
			Timestamp = string.IsNullOrWhiteSpace(timestamp) ? null : timestamp,
			RawType = rawType ?? string.Empty,
			Compact = compact
		};
		NextEntryId += 1;
		return entry;
	}

	public void AttachTaskContext(TimelineProjectedEntry entry)
	{
		if (ActiveTaskStack.Count <= 0)
		{
			return;
		}

		entry.TaskId = ActiveTaskStack[^1];
		entry.TaskDepth = ActiveTaskStack.Count;
	}

	public void MarkTaskStart(TimelineProjectedEntry entry)
	{
		var taskId = $"task-{NextTaskGroupId}";
		NextTaskGroupId += 1;
		ActiveTaskStack.Add(taskId);
		entry.TaskId = taskId;
		entry.TaskDepth = ActiveTaskStack.Count;
		entry.TaskBoundary = "start";
	}

	public void MarkTaskEnd(TimelineProjectedEntry entry)
	{
		var depth = ActiveTaskStack.Count;
		entry.TaskDepth = depth;
		entry.TaskId = depth > 0 ? ActiveTaskStack[^1] : null;
		entry.TaskBoundary = "end";
		if (depth > 0)
		{
			ActiveTaskStack.RemoveAt(depth - 1);
		}
	}

	public void Track(TimelineProjectedEntry entry)
	{
		if (!_trackedById.ContainsKey(entry.Id))
		{
			_trackedOrder.Enqueue(entry.Id);
		}
		_trackedById[entry.Id] = entry;

		while (_trackedById.Count > MaxTrackedEntries && _trackedOrder.Count > 0)
		{
			var removeId = _trackedOrder.Dequeue();
			_trackedById.Remove(removeId);
			foreach (var pair in ToolEntryByCallId.Where(x => x.Value == removeId).ToList())
			{
				ToolEntryByCallId.Remove(pair.Key);
			}
		}
	}

	public bool TryGetTrackedEntry(long entryId, out TimelineProjectedEntry entry)
	{
		return _trackedById.TryGetValue(entryId, out entry!);
	}

	public void ApplyContext(TimelineContextUsage incoming, string sourceTag)
	{
		var prior = ContextUsage;
		var contextWindow = incoming.ContextWindow ?? prior?.ContextWindow;
		var usedTokens = incoming.UsedTokens ?? prior?.UsedTokens;
		var percentLeft = incoming.PercentLeft;
		if (percentLeft is not null)
		{
			percentLeft = Math.Max(0, Math.Min(100, Math.Round(percentLeft.Value, MidpointRounding.AwayFromZero)));
		}

		if (contextWindow is not null && contextWindow > 0 && usedTokens is not null && usedTokens >= 0)
		{
			if (usedTokens > contextWindow * 1.1 && string.Equals(sourceTag, "token_count", StringComparison.Ordinal))
			{
				return;
			}

			var boundedUsed = Math.Min(usedTokens.Value, contextWindow.Value);
			var derivedLeft = Math.Max(0, Math.Min(100, Math.Round((1 - (boundedUsed / contextWindow.Value)) * 100, MidpointRounding.AwayFromZero)));
			ContextUsage = new TimelineContextUsage(boundedUsed, contextWindow, percentLeft ?? derivedLeft);
			return;
		}

		if (contextWindow is not null && contextWindow > 0 && percentLeft is not null)
		{
			var boundedLeft = Math.Max(0, Math.Min(100, percentLeft.Value));
			var derivedUsed = Math.Max(0, Math.Round(contextWindow.Value * (1 - boundedLeft / 100), MidpointRounding.AwayFromZero));
			ContextUsage = new TimelineContextUsage(derivedUsed, contextWindow, boundedLeft);
		}
	}
}

internal sealed record TimelineProjectionResult(
	IReadOnlyList<TimelineProjectedEntry> Entries,
	TimelineContextUsage? ContextUsage,
	TimelinePermissionInfo? Permission,
	string ReasoningSummary);

internal sealed record TimelineContextUsage(
	double? UsedTokens,
	double? ContextWindow,
	double? PercentLeft);

internal sealed record TimelinePermissionInfo(
	string Approval,
	string Sandbox);

internal sealed class TimelineProjectedEntry
{
	public long Id { get; set; }
	public string Role { get; set; } = "system";
	public string Title { get; set; } = "System";
	public string Text { get; set; } = string.Empty;
	public string? Timestamp { get; set; }
	public string RawType { get; set; } = string.Empty;
	public bool Compact { get; set; }
	public string? TaskId { get; set; }
	public int TaskDepth { get; set; }
	public string? TaskBoundary { get; set; }
	public string[] Images { get; set; } = Array.Empty<string>();
	public string Command { get; set; } = string.Empty;
	public List<string> Details { get; set; } = new();

	public TimelineProjectedEntry Clone()
	{
		return new TimelineProjectedEntry
		{
			Id = Id,
			Role = Role,
			Title = Title,
			Text = Text,
			Timestamp = Timestamp,
			RawType = RawType,
			Compact = Compact,
			TaskId = TaskId,
			TaskDepth = TaskDepth,
			TaskBoundary = TaskBoundary,
			Images = Images.ToArray(),
			Command = Command,
			Details = Details.ToList()
		};
	}
}
