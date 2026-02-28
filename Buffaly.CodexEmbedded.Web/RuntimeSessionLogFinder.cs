internal static class RuntimeSessionLogFinder
{
	public static string? ResolveLogPath(string logRootPath, string? requestedLogFileName)
	{
		if (!Directory.Exists(logRootPath))
		{
			return null;
		}

		if (!string.IsNullOrWhiteSpace(requestedLogFileName))
		{
			var fileName = Path.GetFileName(requestedLogFileName);
			if (string.IsNullOrWhiteSpace(fileName))
			{
				return null;
			}

			var exact = Path.Combine(logRootPath, fileName);
			if (File.Exists(exact) && IsAllowedRuntimeLog(fileName))
			{
				return exact;
			}
		}

		var candidates = Directory.EnumerateFiles(logRootPath, "session-*.log", SearchOption.TopDirectoryOnly)
			.Select(path =>
			{
				try
				{
					return new FileInfo(path);
				}
				catch
				{
					return null;
				}
			})
			.Where(info => info is not null)
			.Select(info => info!)
			.OrderByDescending(info => info.LastWriteTimeUtc)
			.ThenByDescending(info => info.Name, StringComparer.Ordinal)
			.ToList();

		return candidates.Count == 0 ? null : candidates[0].FullName;
	}

	private static bool IsAllowedRuntimeLog(string fileName)
	{
		return fileName.StartsWith("session-", StringComparison.OrdinalIgnoreCase) &&
			fileName.EndsWith(".log", StringComparison.OrdinalIgnoreCase);
	}
}
