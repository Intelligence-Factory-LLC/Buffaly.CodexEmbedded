namespace Buffaly.CodexEmbedded.Core;

public static class CodexHomePaths
{
	public static string ResolveCodexHomePath(string? configuredCodexHomePath = null)
	{
		if (!string.IsNullOrWhiteSpace(configuredCodexHomePath))
		{
			return Path.GetFullPath(configuredCodexHomePath);
		}

		var fromEnv = Environment.GetEnvironmentVariable("CODEX_HOME");
		if (!string.IsNullOrWhiteSpace(fromEnv))
		{
			return Path.GetFullPath(fromEnv);
		}

		var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
		if (!string.IsNullOrWhiteSpace(userProfile))
		{
			return Path.Combine(userProfile, ".codex");
		}

		return Path.Combine(Environment.CurrentDirectory, ".codex");
	}

	public static string ResolveSessionIndexPath(string? configuredCodexHomePath = null)
	{
		return Path.Combine(ResolveCodexHomePath(configuredCodexHomePath), "session_index.jsonl");
	}

	public static string ResolveSessionsRootPath(string? configuredCodexHomePath = null)
	{
		return Path.Combine(ResolveCodexHomePath(configuredCodexHomePath), "sessions");
	}
}
