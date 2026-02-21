using System.Globalization;
using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

public sealed record CodexTaskRecoveryAnalysis(
	int OutstandingTaskCount,
	DateTimeOffset? LastTaskStartedAtUtc,
	DateTimeOffset? LastTaskCompletedAtUtc,
	DateTimeOffset? LastTaskEventAtUtc)
{
	public bool HasOutstandingTask => OutstandingTaskCount > 0;
}

public static class CodexTaskStateRecovery
{
	public static CodexTaskRecoveryAnalysis AnalyzeJsonLines(IEnumerable<string> jsonLines)
	{
		var outstandingTaskCount = 0;
		DateTimeOffset? lastStartedAtUtc = null;
		DateTimeOffset? lastCompletedAtUtc = null;
		DateTimeOffset? lastTaskEventAtUtc = null;

		foreach (var line in jsonLines)
		{
			if (string.IsNullOrWhiteSpace(line))
			{
				continue;
			}

			if (line.IndexOf("task_started", StringComparison.Ordinal) < 0 &&
				line.IndexOf("task_complete", StringComparison.Ordinal) < 0)
			{
				continue;
			}

			try
			{
				using var doc = JsonDocument.Parse(line);
				var root = doc.RootElement;
				if (!string.Equals(JsonPath.TryGetString(root, "type"), "event_msg", StringComparison.Ordinal))
				{
					continue;
				}

				if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
				{
					continue;
				}

				var payloadType = JsonPath.TryGetString(payload, "type");
				if (!string.Equals(payloadType, "task_started", StringComparison.Ordinal) &&
					!string.Equals(payloadType, "task_complete", StringComparison.Ordinal))
				{
					continue;
				}

				var eventTimestamp = TryParseUtc(JsonPath.TryGetString(root, "timestamp"));
				lastTaskEventAtUtc = Max(lastTaskEventAtUtc, eventTimestamp);

				if (string.Equals(payloadType, "task_started", StringComparison.Ordinal))
				{
					outstandingTaskCount += 1;
					lastStartedAtUtc = Max(lastStartedAtUtc, eventTimestamp);
				}
				else
				{
					outstandingTaskCount = Math.Max(0, outstandingTaskCount - 1);
					lastCompletedAtUtc = Max(lastCompletedAtUtc, eventTimestamp);
				}
			}
			catch
			{
			}
		}

		return new CodexTaskRecoveryAnalysis(
			outstandingTaskCount,
			lastStartedAtUtc,
			lastCompletedAtUtc,
			lastTaskEventAtUtc);
	}

	public static bool IsLikelyProcessing(CodexTaskRecoveryAnalysis analysis, DateTimeOffset nowUtc, TimeSpan staleAfter)
	{
		if (!analysis.HasOutstandingTask)
		{
			return false;
		}

		if (staleAfter <= TimeSpan.Zero)
		{
			return true;
		}

		if (analysis.LastTaskEventAtUtc is null)
		{
			return false;
		}

		return (nowUtc - analysis.LastTaskEventAtUtc.Value) <= staleAfter;
	}

	private static DateTimeOffset? TryParseUtc(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
		{
			return null;
		}

		return parsed.ToUniversalTime();
	}

	private static DateTimeOffset? Max(DateTimeOffset? current, DateTimeOffset? candidate)
	{
		if (current is null)
		{
			return candidate;
		}

		if (candidate is null)
		{
			return current;
		}

		return current.Value >= candidate.Value ? current : candidate;
	}
}
