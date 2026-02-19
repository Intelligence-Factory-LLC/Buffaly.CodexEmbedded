using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core.Tests;

internal static class TestRuntime
{
	public static bool IsLiveCodexTestsEnabled()
	{
		var fromLocal = ReadLocalTestSetting("RunLiveCodexTests");
		if (TryParseTruthy(fromLocal))
		{
			return true;
		}

		// Back-compat: allow the old key name in local appsettings.
		var legacyFromLocal = ReadLocalTestSetting("RUN_LIVE_CODEX_TESTS");
		return TryParseTruthy(legacyFromLocal);
	}

	public static string ResolveCodexPath()
	{
		var fromEnv = Environment.GetEnvironmentVariable("CODEX_TEST_CODEX_PATH");
		if (!string.IsNullOrWhiteSpace(fromEnv))
		{
			return fromEnv;
		}

		var fromSettings = ReadHarnessSetting("CodexPath");
		if (!string.IsNullOrWhiteSpace(fromSettings))
		{
			return fromSettings;
		}

		return "codex";
	}

	public static string ResolveDefaultCwd()
	{
		var fromEnv = Environment.GetEnvironmentVariable("CODEX_TEST_CWD");
		if (!string.IsNullOrWhiteSpace(fromEnv))
		{
			Directory.CreateDirectory(fromEnv);
			return fromEnv;
		}

		var fromSettings = ReadHarnessSetting("DefaultCwd");
		if (!string.IsNullOrWhiteSpace(fromSettings))
		{
			Directory.CreateDirectory(fromSettings);
			return fromSettings;
		}

		var fallback = Path.Combine(Directory.GetCurrentDirectory(), "working");
		Directory.CreateDirectory(fallback);
		return fallback;
	}

	public static string? ResolveCodexHome()
	{
		var fromEnv = Environment.GetEnvironmentVariable("CODEX_TEST_HOME");
		if (!string.IsNullOrWhiteSpace(fromEnv))
		{
			Directory.CreateDirectory(fromEnv);
			return fromEnv;
		}

		return null;
	}

	public static string CreateLogPath(string testName)
	{
		var root = Path.Combine(ResolveDefaultCwd(), "logs", "core-tests");
		Directory.CreateDirectory(root);
		var safeName = string.Join("_", testName.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries));
		return Path.Combine(root, $"{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{safeName}.log");
	}

	private static string? ReadHarnessSetting(string key)
	{
		try
		{
			var root = ResolveRepoRoot();
			var appSettingsPath = Path.Combine(root, "Buffaly.CodexEmbedded.Cli", "appsettings.json");
			if (!File.Exists(appSettingsPath))
			{
				return null;
			}

			using var doc = JsonDocument.Parse(File.ReadAllText(appSettingsPath));
			if (doc.RootElement.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
			{
				return value.GetString();
			}

			return null;
		}
		catch
		{
			return null;
		}
	}

	private static string? ReadLocalTestSetting(string key)
	{
		try
		{
			var root = ResolveRepoRoot();
			var appSettingsPath = Path.Combine(root, "Buffaly.CodexEmbedded.Core.Tests", "appsettings.json");
			if (!File.Exists(appSettingsPath))
			{
				return null;
			}

			using var doc = JsonDocument.Parse(File.ReadAllText(appSettingsPath));
			if (!doc.RootElement.TryGetProperty(key, out var value))
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
		catch
		{
			return null;
		}
	}

	private static bool TryParseTruthy(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return false;
		}

		if (string.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(value, "on", StringComparison.OrdinalIgnoreCase))
		{
			return true;
		}

		return false;
	}

	private static string ResolveRepoRoot()
	{
		var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
		while (dir is not null)
		{
			if (File.Exists(Path.Combine(dir.FullName, "Buffaly.CodexEmbedded.sln")))
			{
				return dir.FullName;
			}
			dir = dir.Parent;
		}

		return Directory.GetCurrentDirectory();
	}
}

