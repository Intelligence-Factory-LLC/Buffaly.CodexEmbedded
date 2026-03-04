using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

internal sealed class GitWorktreeDiffService
{
	private static readonly Regex DiffHeaderRegex = new("^diff --git a/(.+?) b/(.+)$", RegexOptions.Compiled);

	public GitWorktreeDiffSnapshot GetSnapshot(
		string cwd,
		int maxFiles,
		int maxPatchChars,
		CancellationToken cancellationToken)
	{
		var normalizedCwd = string.IsNullOrWhiteSpace(cwd)
			? string.Empty
			: Path.GetFullPath(cwd.Trim());
		if (string.IsNullOrWhiteSpace(normalizedCwd) || !Directory.Exists(normalizedCwd))
		{
			throw new DirectoryNotFoundException($"Working directory does not exist: '{cwd}'.");
		}

		var repoRootResult = RunGit(normalizedCwd, "rev-parse --show-toplevel", timeoutMs: 4000, cancellationToken);
		if (!repoRootResult.Success || string.IsNullOrWhiteSpace(repoRootResult.StdOut))
		{
			return new GitWorktreeDiffSnapshot(
				Cwd: normalizedCwd,
				RepoRoot: null,
				Branch: null,
				HeadSha: null,
				IsGitRepo: false,
				IsTimedOut: repoRootResult.TimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				ChangeCount: 0,
				Files: Array.Empty<GitWorktreeFileDiff>());
		}

		var repoRoot = repoRootResult.StdOut.Trim();
		var branch = RunGit(repoRoot, "rev-parse --abbrev-ref HEAD", timeoutMs: 4000, cancellationToken).StdOut.Trim();
		var headSha = RunGit(repoRoot, "rev-parse HEAD", timeoutMs: 4000, cancellationToken).StdOut.Trim();

		var statusResult = RunGit(repoRoot, "status --porcelain=v1", timeoutMs: 6000, cancellationToken);
		if (!statusResult.Success)
		{
			return new GitWorktreeDiffSnapshot(
				Cwd: normalizedCwd,
				RepoRoot: repoRoot,
				Branch: branch,
				HeadSha: headSha,
				IsGitRepo: true,
				IsTimedOut: statusResult.TimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				ChangeCount: 0,
				Files: Array.Empty<GitWorktreeFileDiff>());
		}

		var patchResult = RunGit(repoRoot, "diff --no-color --find-renames HEAD", timeoutMs: 12000, cancellationToken);
		var numStatResult = RunGit(repoRoot, "diff --no-color --numstat HEAD", timeoutMs: 6000, cancellationToken);
		var patchByPath = ParsePatchByPath(TrimToLength(patchResult.StdOut, maxPatchChars));
		var binaryPaths = ParseBinaryPathsFromNumStat(numStatResult.StdOut);
		var files = ParseStatus(statusResult.StdOut)
			.Take(Math.Max(1, maxFiles))
			.Select(file =>
			{
				var patch = string.Empty;
				var hasPatch = patchByPath.TryGetValue(file.Path, out var byPathPatch);
				var isBinary = binaryPaths.Contains(file.Path);
				if (hasPatch && !string.IsNullOrWhiteSpace(byPathPatch))
				{
					if (byPathPatch.Contains("\nBinary files ", StringComparison.Ordinal) ||
						byPathPatch.Contains("\nGIT binary patch", StringComparison.Ordinal) ||
						byPathPatch.StartsWith("Binary files ", StringComparison.Ordinal))
					{
						isBinary = true;
					}
					else if (!isBinary)
					{
						patch = byPathPatch;
					}
				}
				return new GitWorktreeFileDiff(
					StatusCode: file.StatusCode,
					StatusLabel: file.StatusLabel,
					Path: file.Path,
					OriginalPath: file.OriginalPath,
					Patch: patch,
					IsBinary: isBinary);
			})
			.ToArray();

		return new GitWorktreeDiffSnapshot(
			Cwd: normalizedCwd,
			RepoRoot: repoRoot,
			Branch: string.IsNullOrWhiteSpace(branch) ? null : branch,
			HeadSha: string.IsNullOrWhiteSpace(headSha) ? null : headSha,
			IsGitRepo: true,
			IsTimedOut: patchResult.TimedOut,
			GeneratedAtUtc: DateTimeOffset.UtcNow,
			ChangeCount: files.Length,
			Files: files);
	}

	private static string TrimToLength(string value, int maxChars)
	{
		if (maxChars <= 0 || string.IsNullOrEmpty(value) || value.Length <= maxChars)
		{
			return value ?? string.Empty;
		}

		return value[..maxChars];
	}

	private static Dictionary<string, string> ParsePatchByPath(string diffText)
	{
		var result = new Dictionary<string, string>(StringComparer.Ordinal);
		if (string.IsNullOrWhiteSpace(diffText))
		{
			return result;
		}

		var normalized = diffText.Replace("\r\n", "\n");
		var lines = normalized.Split('\n');
		var current = new StringBuilder();
		var currentPath = string.Empty;

		void Flush()
		{
			if (string.IsNullOrWhiteSpace(currentPath) || current.Length == 0)
			{
				return;
			}

			result[currentPath] = current.ToString().TrimEnd();
			current.Clear();
		}

		foreach (var rawLine in lines)
		{
			var line = rawLine ?? string.Empty;
			if (line.StartsWith("diff --git ", StringComparison.Ordinal))
			{
				Flush();
				currentPath = string.Empty;
				var match = DiffHeaderRegex.Match(line);
				if (match.Success)
				{
					currentPath = match.Groups[2].Value.Trim();
				}
			}

			if (current.Length > 0)
			{
				current.Append('\n');
			}
			current.Append(line);
		}

		Flush();
		return result;
	}

	private static IReadOnlyList<GitStatusFile> ParseStatus(string output)
	{
		var result = new List<GitStatusFile>();
		if (string.IsNullOrWhiteSpace(output))
		{
			return result;
		}

		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var line = rawLine.TrimEnd('\r');
			if (line.Length < 4)
			{
				continue;
			}

			var x = line[0];
			var y = line[1];
			var statusCode = $"{x}{y}";
			var rawPath = line[3..].Trim();
			if (string.IsNullOrWhiteSpace(rawPath))
			{
				continue;
			}

			string? originalPath = null;
			var path = rawPath;
			var arrowIndex = rawPath.IndexOf(" -> ", StringComparison.Ordinal);
			if (arrowIndex > 0)
			{
				originalPath = rawPath[..arrowIndex].Trim();
				path = rawPath[(arrowIndex + 4)..].Trim();
			}

			result.Add(new GitStatusFile(
				StatusCode: statusCode,
				StatusLabel: DescribeStatus(x, y),
				Path: path,
				OriginalPath: originalPath));
		}

		return result;
	}

	private static HashSet<string> ParseBinaryPathsFromNumStat(string output)
	{
		var result = new HashSet<string>(StringComparer.Ordinal);
		if (string.IsNullOrWhiteSpace(output))
		{
			return result;
		}

		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var line = rawLine.TrimEnd('\r');
			var parts = line.Split('\t');
			if (parts.Length < 3)
			{
				continue;
			}

			var add = parts[0].Trim();
			var del = parts[1].Trim();
			var path = parts[2].Trim();
			if (string.IsNullOrWhiteSpace(path))
			{
				continue;
			}

			if (add == "-" && del == "-")
			{
				result.Add(path);
			}
		}

		return result;
	}

	private static string DescribeStatus(char x, char y)
	{
		if (x == '?' && y == '?')
		{
			return "Untracked";
		}

		if (x == 'U' || y == 'U')
		{
			return "Unmerged";
		}

		if (x == 'R' || y == 'R')
		{
			return "Renamed";
		}

		if (x == 'A' || y == 'A')
		{
			return "Added";
		}

		if (x == 'D' || y == 'D')
		{
			return "Deleted";
		}

		if (x == 'M' || y == 'M')
		{
			return "Modified";
		}

		return "Changed";
	}

	private static GitCommandResult RunGit(
		string workingDirectory,
		string arguments,
		int timeoutMs,
		CancellationToken cancellationToken)
	{
		using var process = new Process();
		process.StartInfo = new ProcessStartInfo
		{
			FileName = "git",
			Arguments = $"-C \"{workingDirectory}\" {arguments}",
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			CreateNoWindow = true
		};

		try
		{
			if (!process.Start())
			{
				return new GitCommandResult(false, false, string.Empty, "git did not start");
			}
		}
		catch (Exception ex)
		{
			return new GitCommandResult(false, false, string.Empty, ex.Message);
		}

		var stdOutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
		var stdErrTask = process.StandardError.ReadToEndAsync(cancellationToken);
		var exited = process.WaitForExit(timeoutMs);
		if (!exited)
		{
			try { process.Kill(entireProcessTree: true); } catch { }
			return new GitCommandResult(false, true, string.Empty, "Timed out");
		}

		Task.WaitAll(new Task[] { stdOutTask, stdErrTask }, timeoutMs);
		var stdOut = stdOutTask.IsCompletedSuccessfully ? stdOutTask.Result : string.Empty;
		var stdErr = stdErrTask.IsCompletedSuccessfully ? stdErrTask.Result : string.Empty;

		return new GitCommandResult(process.ExitCode == 0, false, stdOut ?? string.Empty, stdErr ?? string.Empty);
	}

	private sealed record GitStatusFile(
		string StatusCode,
		string StatusLabel,
		string Path,
		string? OriginalPath);

	private sealed record GitCommandResult(
		bool Success,
		bool TimedOut,
		string StdOut,
		string StdErr);
}

internal sealed record GitWorktreeDiffSnapshot(
	string Cwd,
	string? RepoRoot,
	string? Branch,
	string? HeadSha,
	bool IsGitRepo,
	bool IsTimedOut,
	DateTimeOffset GeneratedAtUtc,
	int ChangeCount,
	IReadOnlyList<GitWorktreeFileDiff> Files);

internal sealed record GitWorktreeFileDiff(
	string StatusCode,
	string StatusLabel,
	string Path,
	string? OriginalPath,
	string Patch,
	bool IsBinary);
