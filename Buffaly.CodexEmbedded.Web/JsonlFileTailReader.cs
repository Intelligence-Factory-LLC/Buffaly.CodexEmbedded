using System.Text;

internal sealed record JsonlWatchResult(
	long Cursor,
	long NextCursor,
	long FileLength,
	bool Reset,
	bool Truncated,
	IReadOnlyList<string> Lines);

internal static class JsonlFileTailReader
{
	private const int MaxWatchLineChars = 250_000;
	private const int MaxNoisyControlLineChars = 12_000;
	private const int TypeProbeChars = 256;

	public static JsonlWatchResult ReadInitial(string path, int maxLines)
	{
		using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
		var fileLength = fs.Length;
		using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096, leaveOpen: true);

		var ring = new Queue<string>(Math.Max(1, maxLines));
		var truncated = false;
		while (true)
		{
			var line = reader.ReadLine();
			if (line is null)
			{
				break;
			}

			// Defensive guard: oversized JSONL lines (often compacted replacement histories or large data URLs)
			// can stall timeline/log endpoints and freeze the browser when echoed back.
			if (ShouldSkipForWatch(line))
			{
				truncated = true;
				continue;
			}

			ring.Enqueue(line);
			if (ring.Count > maxLines)
			{
				ring.Dequeue();
				truncated = true;
			}
		}

		var lines = ring.ToArray();
		return new JsonlWatchResult(
			Cursor: fileLength,
			NextCursor: fileLength,
			FileLength: fileLength,
			Reset: false,
			Truncated: truncated,
			Lines: lines);
	}

	public static JsonlWatchResult ReadFromCursor(string path, long cursor, int maxLines)
	{
		using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
		var fileLength = fs.Length;
		var startCursor = cursor;
		var reset = false;
		if (startCursor > fileLength)
		{
			startCursor = 0;
			reset = true;
		}

		fs.Seek(startCursor, SeekOrigin.Begin);
		using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096, leaveOpen: true);

		var truncated = false;
		var lines = new List<string>();
		while (true)
		{
			var line = reader.ReadLine();
			if (line is null)
			{
				break;
			}

			if (ShouldSkipForWatch(line))
			{
				truncated = true;
				continue;
			}

			lines.Add(line);
		}

		if (lines.Count > maxLines)
		{
			lines = lines.Skip(lines.Count - maxLines).ToList();
			truncated = true;
		}

		var nextCursor = fs.Position;
		return new JsonlWatchResult(
			Cursor: startCursor,
			NextCursor: nextCursor,
			FileLength: fileLength,
			Reset: reset,
			Truncated: truncated,
			Lines: lines);
	}

	private static bool ShouldSkipForWatch(string line)
	{
		if (line.Length > MaxWatchLineChars)
		{
			return true;
		}

		// turn_context and compaction control lines are noisy and can be very large without adding user-facing value.
		// Skip extremely large variants early so timeline/watch responses stay responsive.
		if (line.Length > MaxNoisyControlLineChars && IsLargeNoisyControlLine(line))
		{
			return true;
		}

		return false;
	}

	private static bool IsLargeNoisyControlLine(string line)
	{
		if (LooksLikeTopLevelType(line, "\"type\":\"turn_context\""))
		{
			return true;
		}

		return LooksLikeTopLevelType(line, "\"type\":\"event_msg\"") &&
			(line.IndexOf("thread_compacted", StringComparison.Ordinal) >= 0 ||
			 line.IndexOf("thread/compacted", StringComparison.Ordinal) >= 0);
	}

	private static bool LooksLikeTopLevelType(string line, string typeMarker)
	{
		var probeLength = Math.Min(TypeProbeChars, line.Length);
		var idx = line.IndexOf(typeMarker, 0, probeLength, StringComparison.Ordinal);
		return idx >= 0;
	}
}
