using System.Globalization;
using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

public sealed record CodexStoredSessionInfo(
	string ThreadId,
	string? ThreadName,
	DateTimeOffset? UpdatedAtUtc,
	string? Cwd,
	string? Model,
	string? SessionFilePath);

public static class CodexSessionCatalog
{
	public static IReadOnlyList<CodexStoredSessionInfo> ListSessions(string? codexHomePath = null, int limit = 500)
	{
		var byThreadId = new Dictionary<string, SessionBuilder>(StringComparer.Ordinal);

		LoadFromSessionIndex(codexHomePath, byThreadId);
		LoadFromSessionFiles(codexHomePath, byThreadId);

		var ordered = byThreadId.Values
			.Select(x => x.Build())
			.OrderByDescending(x => x.UpdatedAtUtc ?? DateTimeOffset.MinValue)
			.ThenBy(x => x.ThreadId, StringComparer.Ordinal)
			.ToList();

		if (limit > 0 && ordered.Count > limit)
		{
			return ordered.Take(limit).ToList();
		}

		return ordered;
	}

	private static void LoadFromSessionIndex(string? codexHomePath, Dictionary<string, SessionBuilder> byThreadId)
	{
		var sessionIndexPath = CodexHomePaths.ResolveSessionIndexPath(codexHomePath);
		if (!File.Exists(sessionIndexPath))
		{
			return;
		}

		try
		{
			foreach (var line in File.ReadLines(sessionIndexPath))
			{
				if (string.IsNullOrWhiteSpace(line))
				{
					continue;
				}

				try
				{
					using var doc = JsonDocument.Parse(line);
					var root = doc.RootElement;
					var id = JsonPath.TryGetString(root, "id");
					if (string.IsNullOrWhiteSpace(id))
					{
						continue;
					}

					var builder = GetOrAdd(byThreadId, id);
					builder.ThreadName = JsonPath.TryGetString(root, "thread_name") ?? builder.ThreadName;

					var updatedAtRaw = JsonPath.TryGetString(root, "updated_at");
					if (TryParseUtc(updatedAtRaw, out var updatedAtUtc))
					{
						builder.UpdatedAtUtc = Max(builder.UpdatedAtUtc, updatedAtUtc);
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

	private static void LoadFromSessionFiles(string? codexHomePath, Dictionary<string, SessionBuilder> byThreadId)
	{
		var sessionsRoot = CodexHomePaths.ResolveSessionsRootPath(codexHomePath);
		if (!Directory.Exists(sessionsRoot))
		{
			return;
		}

		IEnumerable<string> files;
		try
		{
			files = Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories);
		}
		catch
		{
			return;
		}

		foreach (var file in files)
		{
			if (!TryReadSessionMeta(file, out var meta))
			{
				continue;
			}

			var builder = GetOrAdd(byThreadId, meta.ThreadId);
			builder.Cwd = meta.Cwd ?? builder.Cwd;
			builder.Model = meta.Model ?? builder.Model;
			builder.SessionFilePath = PreferNewerPath(builder.SessionFilePath, file, builder.UpdatedAtUtc, meta.UpdatedAtUtc);
			builder.UpdatedAtUtc = Max(builder.UpdatedAtUtc, meta.UpdatedAtUtc);
		}
	}

	private static string? PreferNewerPath(
		string? currentPath,
		string candidatePath,
		DateTimeOffset? currentUpdatedAtUtc,
		DateTimeOffset? candidateUpdatedAtUtc)
	{
		if (string.IsNullOrWhiteSpace(currentPath))
		{
			return candidatePath;
		}

		if (candidateUpdatedAtUtc is null)
		{
			return currentPath;
		}

		if (currentUpdatedAtUtc is null || candidateUpdatedAtUtc > currentUpdatedAtUtc)
		{
			return candidatePath;
		}

		return currentPath;
	}

	private static bool TryReadSessionMeta(string filePath, out SessionMeta meta)
	{
		meta = default;

		FileInfo? fileInfo = null;
		try
		{
			fileInfo = new FileInfo(filePath);
		}
		catch
		{
		}

		try
		{
			using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
			using var reader = new StreamReader(fs);

			for (var i = 0; i < 100 && !reader.EndOfStream; i++)
			{
				var line = reader.ReadLine();
				if (string.IsNullOrWhiteSpace(line))
				{
					continue;
				}

				using var doc = JsonDocument.Parse(line);
				var root = doc.RootElement;
				if (!string.Equals(JsonPath.TryGetString(root, "type"), "session_meta", StringComparison.Ordinal))
				{
					continue;
				}

				if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
				{
					continue;
				}

				var threadId = JsonPath.TryGetString(payload, "id");
				if (string.IsNullOrWhiteSpace(threadId))
				{
					continue;
				}

				var updatedAt = fileInfo?.LastWriteTimeUtc;
				var payloadTimestampRaw = JsonPath.TryGetString(payload, "timestamp");
				if (TryParseUtc(payloadTimestampRaw, out var payloadTimestamp))
				{
					updatedAt = Max(updatedAt, payloadTimestamp);
				}

				meta = new SessionMeta(
					threadId,
					JsonPath.TryGetString(payload, "cwd"),
					JsonPath.TryGetString(payload, "model"),
					updatedAt is null ? null : new DateTimeOffset(updatedAt.Value, TimeSpan.Zero));
				return true;
			}
		}
		catch
		{
		}

		return false;
	}

	private static bool TryParseUtc(string? value, out DateTimeOffset parsedUtc)
	{
		parsedUtc = default;
		if (string.IsNullOrWhiteSpace(value))
		{
			return false;
		}

		if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
		{
			return false;
		}

		parsedUtc = parsed.ToUniversalTime();
		return true;
	}

	private static SessionBuilder GetOrAdd(Dictionary<string, SessionBuilder> byThreadId, string threadId)
	{
		if (!byThreadId.TryGetValue(threadId, out var builder))
		{
			builder = new SessionBuilder(threadId);
			byThreadId[threadId] = builder;
		}

		return builder;
	}

	private static DateTimeOffset? Max(DateTimeOffset? current, DateTimeOffset? next)
	{
		if (current is null)
		{
			return next;
		}

		if (next is null)
		{
			return current;
		}

		return current.Value >= next.Value ? current : next;
	}

	private static DateTime? Max(DateTime? current, DateTimeOffset next)
	{
		var nextUtc = next.UtcDateTime;
		if (current is null || nextUtc > current.Value)
		{
			return nextUtc;
		}

		return current;
	}

	private sealed class SessionBuilder
	{
		public string ThreadId { get; }
		public string? ThreadName { get; set; }
		public DateTimeOffset? UpdatedAtUtc { get; set; }
		public string? Cwd { get; set; }
		public string? Model { get; set; }
		public string? SessionFilePath { get; set; }

		public SessionBuilder(string threadId)
		{
			ThreadId = threadId;
		}

		public CodexStoredSessionInfo Build()
		{
			return new CodexStoredSessionInfo(ThreadId, ThreadName, UpdatedAtUtc, Cwd, Model, SessionFilePath);
		}
	}

	private readonly record struct SessionMeta(
		string ThreadId,
		string? Cwd,
		string? Model,
		DateTimeOffset? UpdatedAtUtc);
}
