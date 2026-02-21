using System.Text;

namespace BasicUtilities;

public static class Logs
{
	private static readonly object Sync = new();
	private static LogSettings _settings = new();
	private static string? _logFilePath;

	public sealed class LogSettings
	{
		public string Application { get; set; } = "Buffaly.CodexEmbedded.Web";
		public string DebugPath { get; set; } = Path.Combine(Environment.CurrentDirectory, "logs");
		public string DebugLevel { get; set; } = "VERBOSE";
	}

	public static void Config(LogSettings settings)
	{
		if (settings is null)
		{
			throw new ArgumentNullException(nameof(settings));
		}

		var application = string.IsNullOrWhiteSpace(settings.Application)
			? "Buffaly.CodexEmbedded.Web"
			: settings.Application.Trim();
		var debugPath = ResolveDebugPath(settings.DebugPath);
		var fileName = $"{SanitizeFileName(application)}-debug.log";
		var fullPath = Path.Combine(debugPath, fileName);

		lock (Sync)
		{
			Directory.CreateDirectory(debugPath);
			_settings = new LogSettings
			{
				Application = application,
				DebugPath = debugPath,
				DebugLevel = string.IsNullOrWhiteSpace(settings.DebugLevel) ? "VERBOSE" : settings.DebugLevel.Trim()
			};
			_logFilePath = fullPath;
		}
	}

	public static void LogError(Exception ex)
	{
		if (ex is null)
		{
			return;
		}

		WriteInternal("error", $"{ex.GetType().Name}: {ex.Message}{Environment.NewLine}{ex}");
	}

	public static class DebugLog
	{
		public static void WriteEvent(string category, string message)
		{
			WriteInternal(
				string.IsNullOrWhiteSpace(category) ? "debug" : category.Trim(),
				string.IsNullOrWhiteSpace(message) ? "(empty)" : message);
		}
	}

	private static void WriteInternal(string category, string message)
	{
		lock (Sync)
		{
			var targetPath = EnsureConfiguredAndGetPath();
			var line = $"{DateTimeOffset.Now:O} [{category}] {message}";
			File.AppendAllText(targetPath, line + Environment.NewLine, Encoding.UTF8);
		}
	}

	private static string EnsureConfiguredAndGetPath()
	{
		if (!string.IsNullOrWhiteSpace(_logFilePath))
		{
			return _logFilePath!;
		}

		Config(_settings);
		return _logFilePath!;
	}

	private static string ResolveDebugPath(string? debugPath)
	{
		if (string.IsNullOrWhiteSpace(debugPath))
		{
			return Path.Combine(Environment.CurrentDirectory, "logs");
		}

		if (Path.IsPathRooted(debugPath))
		{
			return debugPath;
		}

		return Path.Combine(Environment.CurrentDirectory, debugPath);
	}

	private static string SanitizeFileName(string value)
	{
		var invalidChars = Path.GetInvalidFileNameChars();
		var sb = new StringBuilder(value.Length);
		foreach (var ch in value)
		{
			sb.Append(invalidChars.Contains(ch) ? '_' : ch);
		}

		return sb.ToString();
	}
}
