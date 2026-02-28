using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;

internal sealed class WebRuntimeDefaults
{
	public required string CodexPath { get; init; }
	public required string DefaultCwd { get; init; }
	public required int TurnTimeoutSeconds { get; init; }
	public required int TurnSlotWaitTimeoutSeconds { get; init; }
	public required int TurnSlotWaitPollSeconds { get; init; }
	public required string LogRootPath { get; init; }
	public string? CodexHomePath { get; init; }
	public string? DefaultModel { get; init; }
	public required bool WebSocketAuthRequired { get; init; }
	public string? WebSocketAuthToken { get; init; }
	public required bool PublicExposureEnabled { get; init; }
	public required bool NonLocalBindConfigured { get; init; }
	public required bool UnsafeConfigurationDetected { get; init; }
	public required string[] UnsafeConfigurationReasons { get; init; }
	public required int RunningRecoveryRefreshSeconds { get; init; }
	public required int RunningRecoveryActiveWindowMinutes { get; init; }
	public required int RunningRecoveryTailLineLimit { get; init; }
	public required int RunningRecoveryScanMaxSessions { get; init; }

	// Loads runtime defaults from appsettings and user-level codex config.
	public static WebRuntimeDefaults Load(IConfiguration configuration)
	{
		var defaultModel = LoadModelFromCodexConfig();
		var codexPath = configuration["CodexPath"];
		var defaultCwd = configuration["DefaultCwd"];
		var codexHomePath = configuration["CodexHomePath"];
		var timeout = configuration.GetValue<int?>("TurnTimeoutSeconds") ?? 300;
		var turnSlotWaitTimeoutSeconds = configuration.GetValue<int?>("TurnSlotWaitTimeoutSeconds") ?? timeout;
		var turnSlotWaitPollSeconds = configuration.GetValue<int?>("TurnSlotWaitPollSeconds") ?? 2;
		var logRoot = configuration["LogRootPath"];
		var webSocketAuthRequired = configuration.GetValue<bool?>("WebSocketAuthRequired") ?? true;
		var webSocketAuthToken = ResolveWebSocketAuthToken(configuration["WebSocketAuthToken"], webSocketAuthRequired);
		var publicExposureEnabled = configuration.GetValue<bool?>("PublicExposureEnabled") ?? false;
		var runningRecoveryRefreshSeconds = configuration.GetValue<int?>("RunningRecoveryRefreshSeconds") ?? 5;
		var runningRecoveryActiveWindowMinutes = configuration.GetValue<int?>("RunningRecoveryActiveWindowMinutes") ?? 120;
		var runningRecoveryTailLineLimit = configuration.GetValue<int?>("RunningRecoveryTailLineLimit") ?? 3000;
		var runningRecoveryScanMaxSessions = configuration.GetValue<int?>("RunningRecoveryScanMaxSessions") ?? 200;
		var configuredUrls = LoadConfiguredUrls(configuration);
		var nonLocalBindConfigured = configuredUrls.Any(IsUnsafeBindHost);
		var unsafeReasons = BuildUnsafeReasons(nonLocalBindConfigured, !webSocketAuthRequired, publicExposureEnabled);

		return new WebRuntimeDefaults
		{
			CodexPath = string.IsNullOrWhiteSpace(codexPath) ? "codex" : codexPath,
			DefaultCwd = string.IsNullOrWhiteSpace(defaultCwd) ? Environment.CurrentDirectory : defaultCwd,
			TurnTimeoutSeconds = timeout > 0 ? timeout : 300,
			TurnSlotWaitTimeoutSeconds = Math.Clamp(turnSlotWaitTimeoutSeconds, 5, 3600),
			TurnSlotWaitPollSeconds = Math.Clamp(turnSlotWaitPollSeconds, 1, 30),
			LogRootPath = string.IsNullOrWhiteSpace(logRoot) ? Path.Combine(Environment.CurrentDirectory, "logs", "web") : ResolvePath(logRoot),
			CodexHomePath = string.IsNullOrWhiteSpace(codexHomePath) ? null : ResolvePath(codexHomePath),
			DefaultModel = defaultModel,
			WebSocketAuthRequired = webSocketAuthRequired,
			WebSocketAuthToken = webSocketAuthToken,
			PublicExposureEnabled = publicExposureEnabled,
			NonLocalBindConfigured = nonLocalBindConfigured,
			UnsafeConfigurationDetected = unsafeReasons.Length > 0,
			UnsafeConfigurationReasons = unsafeReasons,
			RunningRecoveryRefreshSeconds = Math.Clamp(runningRecoveryRefreshSeconds, 1, 3600),
			RunningRecoveryActiveWindowMinutes = Math.Clamp(runningRecoveryActiveWindowMinutes, 1, 7 * 24 * 60),
			RunningRecoveryTailLineLimit = Math.Clamp(runningRecoveryTailLineLimit, 100, 10000),
			RunningRecoveryScanMaxSessions = Math.Clamp(runningRecoveryScanMaxSessions, 1, 1000)
		};
	}

	private static string ResolvePath(string path)
	{
		if (Path.IsPathRooted(path))
		{
			return path;
		}

		return Path.Combine(Environment.CurrentDirectory, path);
	}

	private static string? ResolveWebSocketAuthToken(string? configuredToken, bool required)
	{
		if (!required)
		{
			return null;
		}

		if (!string.IsNullOrWhiteSpace(configuredToken))
		{
			return configuredToken.Trim();
		}

		throw new InvalidOperationException(
			"WebSocketAuthRequired is true but WebSocketAuthToken is missing or blank. " +
			"Set WebSocketAuthToken in configuration before starting Buffaly.CodexEmbedded.Web.");
	}

	private static string[] LoadConfiguredUrls(IConfiguration configuration)
	{
		var urlsRaw = configuration["urls"];
		if (string.IsNullOrWhiteSpace(urlsRaw))
		{
			urlsRaw = configuration["ASPNETCORE_URLS"];
		}

		if (string.IsNullOrWhiteSpace(urlsRaw))
		{
			return Array.Empty<string>();
		}

		return urlsRaw
			.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
			.Where(x => !string.IsNullOrWhiteSpace(x))
			.ToArray();
	}

	private static bool IsUnsafeBindHost(string url)
	{
		if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
		{
			return false;
		}

		var host = uri.Host?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(host))
		{
			return false;
		}

		if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		if (string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		if (string.Equals(host, "0.0.0.0", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(host, "::", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(host, "*", StringComparison.OrdinalIgnoreCase) ||
			string.Equals(host, "+", StringComparison.OrdinalIgnoreCase))
		{
			return true;
		}

		return true;
	}

	private static string[] BuildUnsafeReasons(bool nonLocalBindConfigured, bool authDisabled, bool publicExposureEnabled)
	{
		var reasons = new List<string>(3);
		if (nonLocalBindConfigured)
		{
			reasons.Add("Server bind host is not localhost/127.0.0.1.");
		}

		if (authDisabled)
		{
			reasons.Add("WebSocket auth is disabled.");
		}

		if (publicExposureEnabled)
		{
			reasons.Add("Public exposure flag is enabled.");
		}

		return reasons.ToArray();
	}

	// Reads the default model from %USERPROFILE%\.codex\config.toml.
	private static string? LoadModelFromCodexConfig()
	{
		try
		{
			var configPath = Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
				".codex",
				"config.toml");

			if (!File.Exists(configPath))
			{
				return null;
			}

			var toml = File.ReadAllText(configPath);
			var match = Regex.Match(toml, @"(?m)^\s*model\s*=\s*""(?<model>[^""]+)""\s*$");
			if (!match.Success)
			{
				return null;
			}

			var model = match.Groups["model"].Value.Trim();
			return string.IsNullOrWhiteSpace(model) ? null : model;
		}
		catch
		{
			return null;
		}
	}
}
