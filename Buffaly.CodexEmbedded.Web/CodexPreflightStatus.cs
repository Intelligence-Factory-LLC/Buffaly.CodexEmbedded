using System.Diagnostics;

internal sealed class CodexPreflightStatus
{
	public required string ConfiguredCodexPath { get; init; }
	public string? ResolvedCodexPath { get; init; }
	public string? CodexHomePath { get; init; }
	public bool IsCodexInstalled { get; init; }
	public bool IsVersionCheckSuccessful { get; init; }
	public bool HasAuthArtifacts { get; init; }
	public string[] Messages { get; init; } = [];

	public static CodexPreflightStatus Evaluate(WebRuntimeDefaults defaults)
	{
		var configuredPath = string.IsNullOrWhiteSpace(defaults.CodexPath) ? "codex" : defaults.CodexPath.Trim();
		var messages = new List<string>(4);

		var resolvedPath = ResolveCodexExecutablePath(configuredPath);
		var isInstalled = !string.IsNullOrWhiteSpace(resolvedPath);

		var versionOk = false;
		if (!isInstalled)
		{
			messages.Add($"Codex executable was not found for configured CodexPath '{configuredPath}'.");
		}
		else
		{
			try
			{
				var startInfo = new ProcessStartInfo
				{
					FileName = resolvedPath!,
					Arguments = "--version",
					RedirectStandardOutput = true,
					RedirectStandardError = true,
					UseShellExecute = false,
					CreateNoWindow = true
				};
				using var process = Process.Start(startInfo);
				if (process is null)
				{
					messages.Add($"Codex executable '{resolvedPath}' did not start.");
				}
				else
				{
					if (!process.WaitForExit(8000))
					{
						try { process.Kill(entireProcessTree: true); } catch { }
						messages.Add($"Codex executable '{resolvedPath}' timed out during --version check.");
					}
					else if (process.ExitCode != 0)
					{
						messages.Add($"Codex executable '{resolvedPath}' returned exit code {process.ExitCode} for --version.");
					}
					else
					{
						versionOk = true;
					}
				}
			}
			catch (Exception ex)
			{
				messages.Add($"Codex executable '{resolvedPath}' failed --version check: {ex.Message}");
			}
		}

		var codexHomePath = ResolveCodexHomePath(defaults.CodexHomePath);
		var hasAuthArtifacts = HasCodexAuthArtifacts(codexHomePath);
		if (!hasAuthArtifacts)
		{
			messages.Add($"No Codex auth artifacts found under '{codexHomePath ?? "(unknown)"}'.");
		}

		return new CodexPreflightStatus
		{
			ConfiguredCodexPath = configuredPath,
			ResolvedCodexPath = resolvedPath,
			CodexHomePath = codexHomePath,
			IsCodexInstalled = isInstalled,
			IsVersionCheckSuccessful = versionOk,
			HasAuthArtifacts = hasAuthArtifacts,
			Messages = messages.ToArray()
		};
	}

	private static string? ResolveCodexExecutablePath(string configuredCodexPath)
	{
		if (string.IsNullOrWhiteSpace(configuredCodexPath))
		{
			return null;
		}

		var raw = configuredCodexPath.Trim();
		var hasPathSeparator = raw.IndexOfAny([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar]) >= 0;
		var isRooted = Path.IsPathRooted(raw);

		if (isRooted || hasPathSeparator)
		{
			if (File.Exists(raw))
			{
				return Path.GetFullPath(raw);
			}

			if (!Path.HasExtension(raw))
			{
				var cmdPath = raw + ".cmd";
				var exePath = raw + ".exe";
				if (File.Exists(cmdPath))
				{
					return Path.GetFullPath(cmdPath);
				}

				if (File.Exists(exePath))
				{
					return Path.GetFullPath(exePath);
				}
			}

			return null;
		}

		var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
		foreach (var entry in path.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
		{
			if (string.IsNullOrWhiteSpace(entry))
			{
				continue;
			}

			var candidate = Path.Combine(entry, raw);
			if (File.Exists(candidate))
			{
				return candidate;
			}

			if (!Path.HasExtension(raw))
			{
				var cmdPath = candidate + ".cmd";
				if (File.Exists(cmdPath))
				{
					return cmdPath;
				}

				var exePath = candidate + ".exe";
				if (File.Exists(exePath))
				{
					return exePath;
				}
			}
		}

		return null;
	}

	private static string ResolveCodexHomePath(string? configuredCodexHomePath)
	{
		if (!string.IsNullOrWhiteSpace(configuredCodexHomePath))
		{
			return configuredCodexHomePath.Trim();
		}

		var fromEnv = Environment.GetEnvironmentVariable("CODEX_HOME");
		if (!string.IsNullOrWhiteSpace(fromEnv))
		{
			return fromEnv.Trim();
		}

		var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
		return string.IsNullOrWhiteSpace(userProfile)
			? string.Empty
			: Path.Combine(userProfile, ".codex");
	}

	private static bool HasCodexAuthArtifacts(string codexHomePath)
	{
		if (string.IsNullOrWhiteSpace(codexHomePath))
		{
			return false;
		}

		foreach (var fileName in new[] { "auth.json", "credentials.json", "token.json" })
		{
			var path = Path.Combine(codexHomePath, fileName);
			if (File.Exists(path))
			{
				return true;
			}
		}

		return false;
	}
}

