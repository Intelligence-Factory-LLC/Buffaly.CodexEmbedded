using System.Globalization;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;

internal static class RecapMarkdownBuilder
{
	public static string BuildUtf8Preview(string markdown, int maxBytes, out bool truncated, out int totalBytes)
	{
		var text = markdown ?? string.Empty;
		var utf8 = Encoding.UTF8;
		totalBytes = utf8.GetByteCount(text);
		if (maxBytes <= 0 || totalBytes <= maxBytes)
		{
			truncated = false;
			return text;
		}

		var builder = new StringBuilder();
		var usedBytes = 0;
		foreach (var ch in text)
		{
			var nextBytes = utf8.GetByteCount(new[] { ch });
			if (usedBytes + nextBytes > maxBytes)
			{
				break;
			}

			builder.Append(ch);
			usedBytes += nextBytes;
		}

		truncated = true;
		return builder.ToString();
	}

	public static RecapReportBuildResult BuildReport(
		IReadOnlyList<CodexStoredSessionInfo> sessions,
		DateTimeOffset startUtc,
		DateTimeOffset endUtc,
		bool includeAllDetails)
	{
		var byProject = new Dictionary<string, List<(CodexStoredSessionInfo Session, List<RecapExportEntry> Entries)>>(StringComparer.OrdinalIgnoreCase);
		var totalEntries = 0;
		var includedSessions = 0;

		foreach (var session in sessions)
		{
			var path = session.SessionFilePath;
			if (string.IsNullOrWhiteSpace(path))
			{
				continue;
			}

			var fullPath = Path.GetFullPath(path);
			if (!File.Exists(fullPath))
			{
				continue;
			}

			List<RecapExportEntry> entries;
			try
			{
				entries = ReadEntries(fullPath, startUtc, endUtc, includeAllDetails);
			}
			catch
			{
				continue;
			}

			if (entries.Count == 0)
			{
				continue;
			}

			var project = string.IsNullOrWhiteSpace(session.Cwd) ? "(unknown)" : session.Cwd!;
			if (!byProject.TryGetValue(project, out var sessionsForProject))
			{
				sessionsForProject = new List<(CodexStoredSessionInfo Session, List<RecapExportEntry> Entries)>();
				byProject[project] = sessionsForProject;
			}

			sessionsForProject.Add((session, entries));
			totalEntries += entries.Count;
			includedSessions += 1;
		}

		var markdown = RenderMarkdown(byProject, startUtc, endUtc, includeAllDetails, includedSessions, totalEntries);
		return new RecapReportBuildResult(
			Markdown: markdown,
			ProjectCount: byProject.Count,
			SessionCount: includedSessions,
			EntryCount: totalEntries);
	}

	private static string RenderMarkdown(
		Dictionary<string, List<(CodexStoredSessionInfo Session, List<RecapExportEntry> Entries)>> byProject,
		DateTimeOffset startUtc,
		DateTimeOffset endUtc,
		bool includeAllDetails,
		int sessionCount,
		int entryCount)
	{
		var sb = new StringBuilder();
		sb.AppendLine("# Recap Export");
		sb.AppendLine();
		sb.AppendLine($"- Generated: {DateTimeOffset.UtcNow:yyyy-MM-dd HH:mm:ss} UTC");
		sb.AppendLine($"- Window: {startUtc:yyyy-MM-dd HH:mm:ss} UTC to {endUtc:yyyy-MM-dd HH:mm:ss} UTC");
		sb.AppendLine($"- Detail level: {(includeAllDetails ? "all" : "messages")}");
		sb.AppendLine($"- Sessions: {sessionCount}");
		sb.AppendLine($"- Entries: {entryCount}");
		sb.AppendLine();

		foreach (var project in byProject.Keys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
		{
			var sessions = byProject[project]
				.OrderByDescending(x => x.Session.UpdatedAtUtc ?? DateTimeOffset.MinValue)
				.ThenBy(x => x.Session.ThreadId, StringComparer.Ordinal)
				.ToList();

			sb.AppendLine($"## Project: {project}");
			sb.AppendLine();
			foreach (var item in sessions)
			{
				var session = item.Session;
				var entries = item.Entries.OrderBy(x => x.TimestampUtc).ToList();
				var sessionTitle = string.IsNullOrWhiteSpace(session.ThreadName)
					? session.ThreadId
					: $"{session.ThreadName} ({session.ThreadId})";

				sb.AppendLine($"### Session: {sessionTitle}");
				sb.AppendLine();
				sb.AppendLine($"- Updated: {(session.UpdatedAtUtc.HasValue ? session.UpdatedAtUtc.Value.ToString("yyyy-MM-dd HH:mm:ss 'UTC'") : "unknown")}");
				sb.AppendLine($"- File: {session.SessionFilePath}");
				sb.AppendLine($"- Entries in window: {entries.Count}");
				sb.AppendLine();

				foreach (var entry in entries)
				{
					var label = string.IsNullOrWhiteSpace(entry.Label) ? entry.Role : entry.Label;
					sb.AppendLine($"- {entry.TimestampUtc:yyyy-MM-dd HH:mm:ss} UTC | **{label}**");
					foreach (var line in SplitLines(entry.Text))
					{
						sb.AppendLine($"  {line}");
					}
				}

				sb.AppendLine();
			}
		}

		if (sessionCount == 0)
		{
			sb.AppendLine("_No matching conversation entries were found for this window and project filter._");
			sb.AppendLine();
		}

		return sb.ToString();
	}

	private static IEnumerable<string> SplitLines(string? text)
	{
		var normalized = (text ?? string.Empty).Replace("\r", string.Empty);
		if (string.IsNullOrWhiteSpace(normalized))
		{
			yield return "(empty)";
			yield break;
		}

		var lines = normalized.Split('\n');
		foreach (var line in lines)
		{
			yield return string.IsNullOrWhiteSpace(line) ? string.Empty : line;
		}
	}

	private static List<RecapExportEntry> ReadEntries(
		string filePath,
		DateTimeOffset startUtc,
		DateTimeOffset endUtc,
		bool includeAllDetails)
	{
		var output = new List<RecapExportEntry>();
		foreach (var line in File.ReadLines(filePath))
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

				var timestampRaw = TryGetString(root, "timestamp");
				if (!TryParseTimestamp(timestampRaw, out var timestampUtc))
				{
					continue;
				}
				if (timestampUtc < startUtc || timestampUtc > endUtc)
				{
					continue;
				}

				var lineType = TryGetString(root, "type") ?? string.Empty;
				if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
				{
					continue;
				}

				if (string.Equals(lineType, "response_item", StringComparison.Ordinal))
				{
					var payloadType = TryGetString(payload, "type") ?? string.Empty;
					if (string.Equals(payloadType, "message", StringComparison.Ordinal))
					{
						var role = (TryGetString(payload, "role") ?? string.Empty).Trim().ToLowerInvariant();
						if (!string.Equals(role, "user", StringComparison.Ordinal) && !string.Equals(role, "assistant", StringComparison.Ordinal))
						{
							continue;
						}

						var text = ExtractTextFromContent(payload);
						if (string.IsNullOrWhiteSpace(text))
						{
							continue;
						}

						var label = string.Equals(role, "assistant", StringComparison.Ordinal) ? "Assistant" : "User";
						output.Add(new RecapExportEntry(timestampUtc, role, label, text));
						continue;
					}

					if (includeAllDetails &&
						(string.Equals(payloadType, "function_call", StringComparison.Ordinal)
						|| string.Equals(payloadType, "custom_tool_call", StringComparison.Ordinal)))
					{
						var name = TryGetString(payload, "name") ?? "tool";
						var arguments = TryGetString(payload, "arguments") ?? TryGetString(payload, "input") ?? string.Empty;
						output.Add(new RecapExportEntry(timestampUtc, "tool", $"Tool Call: {name}", arguments));
						continue;
					}

					if (includeAllDetails &&
						(string.Equals(payloadType, "function_call_output", StringComparison.Ordinal)
						|| string.Equals(payloadType, "custom_tool_call_output", StringComparison.Ordinal)))
					{
						var result = TryGetString(payload, "output")
							?? TryGetString(payload, "result")
							?? TryGetString(payload, "content")
							?? payload.ToString();
						output.Add(new RecapExportEntry(timestampUtc, "tool", "Tool Output", result ?? string.Empty));
						continue;
					}

					if (includeAllDetails && string.Equals(payloadType, "reasoning", StringComparison.Ordinal))
					{
						var reasoning = TryGetString(payload, "summary") ?? TryGetString(payload, "content") ?? string.Empty;
						if (!string.IsNullOrWhiteSpace(reasoning))
						{
							output.Add(new RecapExportEntry(timestampUtc, "reasoning", "Reasoning", reasoning));
						}
						continue;
					}

					continue;
				}

				if (includeAllDetails && string.Equals(lineType, "event_msg", StringComparison.Ordinal))
				{
					var eventType = TryGetString(payload, "type") ?? "event";
					if (string.Equals(eventType, "token_count", StringComparison.Ordinal))
					{
						continue;
					}

					var message = TryGetString(payload, "message")
						?? TryGetString(payload, "text")
						?? TryGetString(payload, "summary")
						?? payload.ToString();
					if (!string.IsNullOrWhiteSpace(message))
					{
						output.Add(new RecapExportEntry(timestampUtc, "event", $"Event: {eventType}", message));
					}
				}
			}
			catch
			{
			}
		}

		return output;
	}

	private static bool TryParseTimestamp(string? raw, out DateTimeOffset utc)
	{
		utc = default;
		if (string.IsNullOrWhiteSpace(raw))
		{
			return false;
		}

		if (!DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
		{
			return false;
		}

		utc = parsed.ToUniversalTime();
		return true;
	}

	private static string ExtractTextFromContent(JsonElement payload)
	{
		if (!payload.TryGetProperty("content", out var content))
		{
			return string.Empty;
		}

		if (content.ValueKind == JsonValueKind.String)
		{
			return content.GetString() ?? string.Empty;
		}

		if (content.ValueKind != JsonValueKind.Array)
		{
			return string.Empty;
		}

		var parts = new List<string>();
		foreach (var item in content.EnumerateArray())
		{
			if (item.ValueKind == JsonValueKind.String)
			{
				var raw = item.GetString();
				if (!string.IsNullOrWhiteSpace(raw))
				{
					parts.Add(raw!);
				}
				continue;
			}

			if (item.ValueKind != JsonValueKind.Object)
			{
				continue;
			}

			var text = TryGetString(item, "text")
				?? TryGetString(item, "value")
				?? TryGetString(item, "output_text")
				?? TryGetString(item, "message");
			if (!string.IsNullOrWhiteSpace(text))
			{
				parts.Add(text!);
			}
		}

		return string.Join("\n", parts);
	}

	private static string? TryGetString(JsonElement element, string propertyName)
	{
		if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
		{
			return null;
		}

		return value.ValueKind switch
		{
			JsonValueKind.String => value.GetString(),
			JsonValueKind.Number => value.ToString(),
			JsonValueKind.True => "true",
			JsonValueKind.False => "false",
			JsonValueKind.Null => null,
			_ => value.ToString()
		};
	}
}
