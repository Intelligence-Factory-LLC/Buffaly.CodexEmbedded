using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

internal sealed class GitWorktreeDiffService
{
	private static readonly Regex DiffHeaderRegex = new("^diff --git a/(.+?) b/(.+)$", RegexOptions.Compiled);
	private const string RecentCommitMarker = "__CODX_COMMIT__";
	private const int RecentCommitPreviewFileLimit = 4;

	public GitWorktreeDiffSnapshot GetSnapshot(
		string cwd,
		int maxFiles,
		int maxPatchChars,
		int contextLines,
		CancellationToken cancellationToken)
	{
		var repo = ResolveRepoContext(cwd, cancellationToken);
		if (!repo.IsGitRepo || string.IsNullOrWhiteSpace(repo.RepoRoot))
		{
			return new GitWorktreeDiffSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: null,
				Branch: null,
				HeadSha: null,
				IsGitRepo: false,
				IsTimedOut: repo.IsTimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				ChangeCount: 0,
				Files: Array.Empty<GitWorktreeFileDiff>());
		}

		var statusResult = RunGit(repo.RepoRoot, "status --porcelain=v1", timeoutMs: 6000, cancellationToken);
		if (!statusResult.Success)
		{
			return new GitWorktreeDiffSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: statusResult.TimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				ChangeCount: 0,
				Files: Array.Empty<GitWorktreeFileDiff>());
		}

		var unifiedContext = BuildUnifiedContextArgument(contextLines);
		var patchResult = RunGit(repo.RepoRoot, $"diff --no-color --find-renames {unifiedContext} HEAD", timeoutMs: 12000, cancellationToken);
		var numStatResult = RunGit(repo.RepoRoot, "diff --no-color --numstat HEAD", timeoutMs: 6000, cancellationToken);
		var patchByPath = ParsePatchByPath(TrimToLength(patchResult.StdOut, maxPatchChars));
		var binaryPaths = ParseBinaryPathsFromNumStat(numStatResult.StdOut);
		var files = BuildFileDiffs(
			ParseStatus(statusResult.StdOut),
			patchByPath,
			binaryPaths,
			maxFiles);

		return new GitWorktreeDiffSnapshot(
			Cwd: repo.Cwd,
			RepoRoot: repo.RepoRoot,
			Branch: repo.Branch,
			HeadSha: repo.HeadSha,
			IsGitRepo: true,
			IsTimedOut: patchResult.TimedOut || numStatResult.TimedOut,
			GeneratedAtUtc: DateTimeOffset.UtcNow,
			ChangeCount: files.Length,
			Files: files);
	}

	public GitRecentCommitCatalogSnapshot GetRecentCommits(
		string cwd,
		int limit,
		CancellationToken cancellationToken)
	{
		var repo = ResolveRepoContext(cwd, cancellationToken);
		if (!repo.IsGitRepo || string.IsNullOrWhiteSpace(repo.RepoRoot))
		{
			return new GitRecentCommitCatalogSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: null,
				Branch: null,
				HeadSha: null,
				IsGitRepo: false,
				IsTimedOut: repo.IsTimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Commits: Array.Empty<GitRecentCommitInfo>());
		}

		var safeLimit = Math.Clamp(limit, 1, 200);
		var logResult = RunGit(
			repo.RepoRoot,
			$"log -n {safeLimit} --date=iso-strict --numstat --pretty=format:{RecentCommitMarker}%H%x1f%h%x1f%ad%x1f%an%x1f%s",
			timeoutMs: 7000,
			cancellationToken);
		if (!logResult.Success)
		{
			return new GitRecentCommitCatalogSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: logResult.TimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Commits: Array.Empty<GitRecentCommitInfo>());
		}

		var commits = ParseRecentCommitLogWithNumStat(logResult.StdOut);
		return new GitRecentCommitCatalogSnapshot(
			Cwd: repo.Cwd,
			RepoRoot: repo.RepoRoot,
			Branch: repo.Branch,
			HeadSha: repo.HeadSha,
			IsGitRepo: true,
			IsTimedOut: logResult.TimedOut,
			GeneratedAtUtc: DateTimeOffset.UtcNow,
			Commits: commits);
	}

	public GitCommitDiffSnapshot GetCommitSnapshot(
		string cwd,
		string commitSha,
		int maxFiles,
		int maxPatchChars,
		int contextLines,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(commitSha))
		{
			throw new ArgumentException("commit query parameter is required.", nameof(commitSha));
		}

		var repo = ResolveRepoContext(cwd, cancellationToken);
		if (!repo.IsGitRepo || string.IsNullOrWhiteSpace(repo.RepoRoot))
		{
			return new GitCommitDiffSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: null,
				Branch: null,
				HeadSha: null,
				IsGitRepo: false,
				IsTimedOut: repo.IsTimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				CommitSha: null,
				CommitShortSha: null,
				CommitSubject: null,
				CommitAuthorName: null,
				CommitCommittedAtUtc: null,
				ChangeCount: 0,
				Files: Array.Empty<GitWorktreeFileDiff>());
		}

		var commitToken = commitSha.Trim();
		var resolvedCommitResult = RunGit(
			repo.RepoRoot,
			$"rev-parse --verify {QuoteGitArgument(commitToken)}^{{commit}}",
			timeoutMs: 4000,
			cancellationToken);
		if (!resolvedCommitResult.Success || string.IsNullOrWhiteSpace(resolvedCommitResult.StdOut))
		{
			throw new ArgumentException($"Commit was not found: '{commitToken}'.", nameof(commitSha));
		}

		var resolvedCommitSha = resolvedCommitResult.StdOut.Trim();
		var metadataResult = RunGit(
			repo.RepoRoot,
			$"show -s --no-color --date=iso-strict --pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s {QuoteGitArgument(resolvedCommitSha)}",
			timeoutMs: 5000,
			cancellationToken);
		var metadata = ParseCommitMetadata(metadataResult.StdOut)
			?? new GitCommitMetadata(
				Sha: resolvedCommitSha,
				ShortSha: resolvedCommitSha.Length > 8 ? resolvedCommitSha[..8] : resolvedCommitSha,
				Subject: string.Empty,
				AuthorName: string.Empty,
				CommittedAtUtc: null);

		var unifiedContext = BuildUnifiedContextArgument(contextLines);
		var patchResult = RunGit(
			repo.RepoRoot,
			$"show --no-color --find-renames {unifiedContext} --format= {QuoteGitArgument(resolvedCommitSha)}",
			timeoutMs: 12000,
			cancellationToken);
		var numStatResult = RunGit(
			repo.RepoRoot,
			$"show --no-color --numstat --format= {QuoteGitArgument(resolvedCommitSha)}",
			timeoutMs: 7000,
			cancellationToken);
		var nameStatusResult = RunGit(
			repo.RepoRoot,
			$"show --no-color --find-renames --name-status --format= {QuoteGitArgument(resolvedCommitSha)}",
			timeoutMs: 7000,
			cancellationToken);
		if (!nameStatusResult.Success)
		{
			return new GitCommitDiffSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: patchResult.TimedOut || numStatResult.TimedOut || nameStatusResult.TimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				CommitSha: metadata.Sha,
				CommitShortSha: metadata.ShortSha,
				CommitSubject: metadata.Subject,
				CommitAuthorName: metadata.AuthorName,
				CommitCommittedAtUtc: metadata.CommittedAtUtc,
				ChangeCount: 0,
				Files: Array.Empty<GitWorktreeFileDiff>());
		}

		var patchByPath = ParsePatchByPath(TrimToLength(patchResult.StdOut, maxPatchChars));
		var binaryPaths = ParseBinaryPathsFromNumStat(numStatResult.StdOut);
		var files = BuildFileDiffs(
			ParseNameStatus(nameStatusResult.StdOut),
			patchByPath,
			binaryPaths,
			maxFiles);

		return new GitCommitDiffSnapshot(
			Cwd: repo.Cwd,
			RepoRoot: repo.RepoRoot,
			Branch: repo.Branch,
			HeadSha: repo.HeadSha,
			IsGitRepo: true,
			IsTimedOut: patchResult.TimedOut || numStatResult.TimedOut || nameStatusResult.TimedOut,
			GeneratedAtUtc: DateTimeOffset.UtcNow,
			CommitSha: metadata.Sha,
			CommitShortSha: metadata.ShortSha,
			CommitSubject: metadata.Subject,
			CommitAuthorName: metadata.AuthorName,
			CommitCommittedAtUtc: metadata.CommittedAtUtc,
			ChangeCount: files.Length,
			Files: files);
	}

	public GitDiffFileContentSnapshot GetFileContentSnapshot(
		string cwd,
		string path,
		string? commitSha,
		int maxContentChars,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(path))
		{
			throw new ArgumentException("path query parameter is required.", nameof(path));
		}

		var repo = ResolveRepoContext(cwd, cancellationToken);
		if (!repo.IsGitRepo || string.IsNullOrWhiteSpace(repo.RepoRoot))
		{
			return new GitDiffFileContentSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: null,
				Branch: null,
				HeadSha: null,
				IsGitRepo: false,
				IsTimedOut: repo.IsTimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Path: path.Trim(),
				CommitSha: null,
				Exists: false,
				IsBinary: false,
				IsTruncated: false,
				Content: string.Empty,
				Message: "Not a git repository.");
		}

		var normalizedPath = NormalizeGitRelativePath(path);
		if (string.IsNullOrWhiteSpace(normalizedPath))
		{
			throw new ArgumentException("path query parameter is invalid.", nameof(path));
		}

		var safeMaxChars = Math.Clamp(maxContentChars, 4000, 2_000_000);
		var commitToken = string.IsNullOrWhiteSpace(commitSha) ? null : commitSha.Trim();
		if (!string.IsNullOrWhiteSpace(commitToken))
		{
			var resolvedCommitResult = RunGit(
				repo.RepoRoot,
				$"rev-parse --verify {QuoteGitArgument(commitToken)}^{{commit}}",
				timeoutMs: 4000,
				cancellationToken);
			if (!resolvedCommitResult.Success || string.IsNullOrWhiteSpace(resolvedCommitResult.StdOut))
			{
				throw new ArgumentException($"Commit was not found: '{commitToken}'.", nameof(commitSha));
			}

			var resolvedCommitSha = resolvedCommitResult.StdOut.Trim();
			var objectSpec = $"{resolvedCommitSha}:{normalizedPath}";
			var contentResult = RunGit(
				repo.RepoRoot,
				$"show --no-color {QuoteGitArgument(objectSpec)}",
				timeoutMs: 10000,
				cancellationToken);
			if (!contentResult.Success)
			{
				return new GitDiffFileContentSnapshot(
					Cwd: repo.Cwd,
					RepoRoot: repo.RepoRoot,
					Branch: repo.Branch,
					HeadSha: repo.HeadSha,
					IsGitRepo: true,
					IsTimedOut: contentResult.TimedOut,
					GeneratedAtUtc: DateTimeOffset.UtcNow,
					Path: normalizedPath,
					CommitSha: resolvedCommitSha,
					Exists: false,
					IsBinary: false,
					IsTruncated: false,
					Content: string.Empty,
					Message: "File does not exist at selected commit.");
			}

			var content = contentResult.StdOut ?? string.Empty;
			var isBinary = ContainsNullCharacter(content);
			var isTruncated = !isBinary && content.Length > safeMaxChars;
			var trimmedContent = isBinary ? string.Empty : TrimToLength(content, safeMaxChars);
			return new GitDiffFileContentSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: contentResult.TimedOut,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Path: normalizedPath,
				CommitSha: resolvedCommitSha,
				Exists: true,
				IsBinary: isBinary,
				IsTruncated: isTruncated,
				Content: trimmedContent,
				Message: isBinary ? "File is binary and cannot be shown inline." : null);
		}

		var fullPath = TryResolvePathWithinRepo(repo.RepoRoot, normalizedPath);
		if (string.IsNullOrWhiteSpace(fullPath))
		{
			return new GitDiffFileContentSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: false,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Path: normalizedPath,
				CommitSha: null,
				Exists: false,
				IsBinary: false,
				IsTruncated: false,
				Content: string.Empty,
				Message: "Invalid path.");
		}

		if (!File.Exists(fullPath))
		{
			return new GitDiffFileContentSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: false,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Path: normalizedPath,
				CommitSha: null,
				Exists: false,
				IsBinary: false,
				IsTruncated: false,
				Content: string.Empty,
				Message: "File does not exist in working tree.");
		}

		byte[] bytes;
		try
		{
			bytes = File.ReadAllBytes(fullPath);
		}
		catch (Exception ex)
		{
			return new GitDiffFileContentSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: false,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Path: normalizedPath,
				CommitSha: null,
				Exists: false,
				IsBinary: false,
				IsTruncated: false,
				Content: string.Empty,
				Message: ex.Message);
		}

		var workingTreeIsBinary = LooksBinary(bytes);
		if (workingTreeIsBinary)
		{
			return new GitDiffFileContentSnapshot(
				Cwd: repo.Cwd,
				RepoRoot: repo.RepoRoot,
				Branch: repo.Branch,
				HeadSha: repo.HeadSha,
				IsGitRepo: true,
				IsTimedOut: false,
				GeneratedAtUtc: DateTimeOffset.UtcNow,
				Path: normalizedPath,
				CommitSha: null,
				Exists: true,
				IsBinary: true,
				IsTruncated: false,
				Content: string.Empty,
				Message: "File is binary and cannot be shown inline.");
		}

		var decoded = Encoding.UTF8.GetString(bytes);
		var workingTreeTruncated = decoded.Length > safeMaxChars;
		return new GitDiffFileContentSnapshot(
			Cwd: repo.Cwd,
			RepoRoot: repo.RepoRoot,
			Branch: repo.Branch,
			HeadSha: repo.HeadSha,
			IsGitRepo: true,
			IsTimedOut: false,
			GeneratedAtUtc: DateTimeOffset.UtcNow,
			Path: normalizedPath,
			CommitSha: null,
			Exists: true,
			IsBinary: false,
			IsTruncated: workingTreeTruncated,
			Content: TrimToLength(decoded, safeMaxChars),
			Message: null);
	}

	private static GitRepoContext ResolveRepoContext(string cwd, CancellationToken cancellationToken)
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
			return new GitRepoContext(
				Cwd: normalizedCwd,
				RepoRoot: null,
				Branch: null,
				HeadSha: null,
				IsGitRepo: false,
				IsTimedOut: repoRootResult.TimedOut);
		}

		var repoRoot = repoRootResult.StdOut.Trim();
		var branchResult = RunGit(repoRoot, "rev-parse --abbrev-ref HEAD", timeoutMs: 4000, cancellationToken);
		var headResult = RunGit(repoRoot, "rev-parse HEAD", timeoutMs: 4000, cancellationToken);
		var branch = branchResult.StdOut.Trim();
		var headSha = headResult.StdOut.Trim();
		return new GitRepoContext(
			Cwd: normalizedCwd,
			RepoRoot: repoRoot,
			Branch: string.IsNullOrWhiteSpace(branch) ? null : branch,
			HeadSha: string.IsNullOrWhiteSpace(headSha) ? null : headSha,
			IsGitRepo: true,
			IsTimedOut: repoRootResult.TimedOut || branchResult.TimedOut || headResult.TimedOut);
	}

	private static GitWorktreeFileDiff[] BuildFileDiffs(
		IReadOnlyList<GitStatusFile> files,
		Dictionary<string, string> patchByPath,
		HashSet<string> binaryPaths,
		int maxFiles)
	{
		return files
			.Take(Math.Max(1, maxFiles))
			.Select(file =>
			{
				var patch = string.Empty;
				var hasPatch = TryGetPatchForFile(patchByPath, file, out var byPathPatch);
				var isBinary = binaryPaths.Contains(file.Path) || (!string.IsNullOrWhiteSpace(file.OriginalPath) && binaryPaths.Contains(file.OriginalPath));
				if (hasPatch && !string.IsNullOrWhiteSpace(byPathPatch))
				{
					if (byPathPatch.Contains("\nBinary files ", StringComparison.Ordinal)
						|| byPathPatch.Contains("\nGIT binary patch", StringComparison.Ordinal)
						|| byPathPatch.StartsWith("Binary files ", StringComparison.Ordinal))
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
	}

	private static bool TryGetPatchForFile(
		Dictionary<string, string> patchByPath,
		GitStatusFile file,
		out string patch)
	{
		if (patchByPath.TryGetValue(file.Path, out patch!))
		{
			return true;
		}

		if (!string.IsNullOrWhiteSpace(file.OriginalPath)
			&& patchByPath.TryGetValue(file.OriginalPath, out patch!))
		{
			return true;
		}

		patch = string.Empty;
		return false;
	}

	private static string QuoteGitArgument(string value)
	{
		var escaped = (value ?? string.Empty).Replace("\"", "\\\"");
		return $"\"{escaped}\"";
	}

	private static string BuildUnifiedContextArgument(int contextLines)
	{
		var safeContext = Math.Clamp(contextLines, 0, 200000);
		return $"-U{safeContext}";
	}

	private static string NormalizeGitRelativePath(string path)
	{
		return (path ?? string.Empty)
			.Trim()
			.Replace('\\', '/')
			.TrimStart('/');
	}

	private static string? TryResolvePathWithinRepo(string repoRoot, string relativePath)
	{
		try
		{
			var combined = Path.GetFullPath(Path.Combine(repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
			var normalizedRoot = Path.GetFullPath(repoRoot);
			if (!combined.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase))
			{
				return null;
			}

			return combined;
		}
		catch
		{
			return null;
		}
	}

	private static bool ContainsNullCharacter(string text)
	{
		return !string.IsNullOrEmpty(text) && text.IndexOf('\0') >= 0;
	}

	private static bool LooksBinary(byte[] bytes)
	{
		if (bytes is null || bytes.Length == 0)
		{
			return false;
		}

		var inspectLength = Math.Min(bytes.Length, 4096);
		for (var i = 0; i < inspectLength; i += 1)
		{
			if (bytes[i] == 0)
			{
				return true;
			}
		}

		return false;
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
					var oldPath = match.Groups[1].Value.Trim();
					var newPath = match.Groups[2].Value.Trim();
					currentPath = string.Equals(newPath, "dev/null", StringComparison.Ordinal)
						? oldPath
						: newPath;
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

	private static IReadOnlyList<GitStatusFile> ParseNameStatus(string output)
	{
		var result = new List<GitStatusFile>();
		if (string.IsNullOrWhiteSpace(output))
		{
			return result;
		}

		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var line = rawLine.TrimEnd('\r');
			if (string.IsNullOrWhiteSpace(line))
			{
				continue;
			}

			var parts = line.Split('\t');
			if (parts.Length < 2)
			{
				continue;
			}

			var rawStatus = parts[0].Trim();
			if (string.IsNullOrWhiteSpace(rawStatus))
			{
				continue;
			}

			var statusChar = char.ToUpperInvariant(rawStatus[0]);
			var statusCode = statusChar.ToString();
			string? originalPath = null;
			string path;
			if (statusChar == 'R' || statusChar == 'C')
			{
				if (parts.Length < 3)
				{
					continue;
				}

				originalPath = parts[1].Trim();
				path = parts[2].Trim();
			}
			else
			{
				path = parts[1].Trim();
			}

			if (string.IsNullOrWhiteSpace(path))
			{
				continue;
			}

			result.Add(new GitStatusFile(
				StatusCode: statusCode,
				StatusLabel: DescribeSingleStatus(statusChar),
				Path: path,
				OriginalPath: string.IsNullOrWhiteSpace(originalPath) ? null : originalPath));
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

	private static IReadOnlyList<GitRecentCommitInfo> ParseRecentCommitLog(string output)
	{
		var commits = new List<GitRecentCommitInfo>();
		if (string.IsNullOrWhiteSpace(output))
		{
			return commits;
		}

		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var commit = ParseCommitLine(rawLine);
			if (commit is null)
			{
				continue;
			}

			commits.Add(new GitRecentCommitInfo(
				Sha: commit.Sha,
				ShortSha: commit.ShortSha,
				Subject: commit.Subject,
				AuthorName: commit.AuthorName,
				CommittedAtUtc: commit.CommittedAtUtc,
				FilesChanged: 0,
				Insertions: 0,
				Deletions: 0,
				FileStats: Array.Empty<GitRecentCommitFileStat>()));
		}

		return commits;
	}

	private static IReadOnlyList<GitRecentCommitInfo> ParseRecentCommitLogWithNumStat(string output)
	{
		var commits = new List<GitRecentCommitInfo>();
		if (string.IsNullOrWhiteSpace(output))
		{
			return commits;
		}

		GitCommitMetadata? current = null;
		var filesChanged = 0;
		var additions = 0;
		var deletions = 0;
		var fileStats = new List<GitRecentCommitFileStat>();
		void FlushCurrent()
		{
			if (current is null)
			{
				return;
			}

			commits.Add(new GitRecentCommitInfo(
				Sha: current.Sha,
				ShortSha: current.ShortSha,
				Subject: current.Subject,
				AuthorName: current.AuthorName,
				CommittedAtUtc: current.CommittedAtUtc,
				FilesChanged: filesChanged,
				Insertions: additions,
				Deletions: deletions,
				FileStats: fileStats.ToArray()));
		}

		foreach (var rawLine in output.Split('\n'))
		{
			var line = (rawLine ?? string.Empty).TrimEnd('\r');
			if (line.StartsWith(RecentCommitMarker, StringComparison.Ordinal))
			{
				FlushCurrent();
				current = ParseCommitLine(line[RecentCommitMarker.Length..]);
				filesChanged = 0;
				additions = 0;
				deletions = 0;
				fileStats.Clear();
				continue;
			}

			if (current is null || string.IsNullOrWhiteSpace(line))
			{
				continue;
			}

			if (!TryParseNumStatLine(line, out var add, out var del, out var path, out var isBinary))
			{
				continue;
			}

			filesChanged += 1;
			additions += add;
			deletions += del;
			if (fileStats.Count < RecentCommitPreviewFileLimit)
			{
				fileStats.Add(new GitRecentCommitFileStat(
					Path: path,
					Insertions: add,
					Deletions: del,
					IsBinary: isBinary));
			}
		}

		FlushCurrent();
		return commits;
	}

	private static bool TryParseNumStatLine(string line, out int additions, out int deletions, out string path, out bool isBinary)
	{
		additions = 0;
		deletions = 0;
		path = string.Empty;
		isBinary = false;
		if (string.IsNullOrWhiteSpace(line))
		{
			return false;
		}

		var parts = line.Split('\t');
		if (parts.Length < 3)
		{
			return false;
		}

		var addRaw = parts[0].Trim();
		var delRaw = parts[1].Trim();
		path = parts[2].Trim();
		if (string.IsNullOrWhiteSpace(path))
		{
			return false;
		}
		isBinary = addRaw == "-" && delRaw == "-";
		if (addRaw != "-" && int.TryParse(addRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedAdd))
		{
			additions = Math.Max(0, parsedAdd);
		}

		if (delRaw != "-" && int.TryParse(delRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedDel))
		{
			deletions = Math.Max(0, parsedDel);
		}

		return true;
	}

	private static GitCommitMetadata? ParseCommitMetadata(string output)
	{
		if (string.IsNullOrWhiteSpace(output))
		{
			return null;
		}

		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var parsed = ParseCommitLine(rawLine);
			if (parsed is not null)
			{
				return parsed;
			}
		}

		return null;
	}

	private static GitCommitMetadata? ParseCommitLine(string rawLine)
	{
		var line = (rawLine ?? string.Empty).TrimEnd('\r');
		if (string.IsNullOrWhiteSpace(line))
		{
			return null;
		}

		var parts = line.Split('\u001f');
		if (parts.Length < 5)
		{
			return null;
		}

		var sha = parts[0].Trim();
		var shortSha = parts[1].Trim();
		var committedAtRaw = parts[2].Trim();
		var author = parts[3].Trim();
		var subject = parts[4].Trim();
		if (string.IsNullOrWhiteSpace(sha))
		{
			return null;
		}

		DateTimeOffset? committedAtUtc = null;
		if (DateTimeOffset.TryParse(
			committedAtRaw,
			CultureInfo.InvariantCulture,
			DateTimeStyles.AllowWhiteSpaces,
			out var parsedDate))
		{
			committedAtUtc = parsedDate.ToUniversalTime();
		}

		return new GitCommitMetadata(
			Sha: sha,
			ShortSha: string.IsNullOrWhiteSpace(shortSha) ? (sha.Length > 8 ? sha[..8] : sha) : shortSha,
			Subject: subject,
			AuthorName: author,
			CommittedAtUtc: committedAtUtc);
	}

	private static string DescribeStatus(char x, char y)
	{
		if (x == '?' && y == '?')
		{
			return "Untracked";
		}

		if (x != ' ')
		{
			return DescribeSingleStatus(char.ToUpperInvariant(x));
		}

		if (y != ' ')
		{
			return DescribeSingleStatus(char.ToUpperInvariant(y));
		}

		return "Changed";
	}

	private static string DescribeSingleStatus(char status)
	{
		return status switch
		{
			'U' => "Unmerged",
			'R' => "Renamed",
			'C' => "Copied",
			'A' => "Added",
			'D' => "Deleted",
			'M' => "Modified",
			'T' => "Type changed",
			'?' => "Untracked",
			_ => "Changed"
		};
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

	private sealed record GitRepoContext(
		string Cwd,
		string? RepoRoot,
		string? Branch,
		string? HeadSha,
		bool IsGitRepo,
		bool IsTimedOut);

	private sealed record GitStatusFile(
		string StatusCode,
		string StatusLabel,
		string Path,
		string? OriginalPath);

	private sealed record GitCommitMetadata(
		string Sha,
		string ShortSha,
		string Subject,
		string AuthorName,
		DateTimeOffset? CommittedAtUtc);

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

internal sealed record GitCommitDiffSnapshot(
	string Cwd,
	string? RepoRoot,
	string? Branch,
	string? HeadSha,
	bool IsGitRepo,
	bool IsTimedOut,
	DateTimeOffset GeneratedAtUtc,
	string? CommitSha,
	string? CommitShortSha,
	string? CommitSubject,
	string? CommitAuthorName,
	DateTimeOffset? CommitCommittedAtUtc,
	int ChangeCount,
	IReadOnlyList<GitWorktreeFileDiff> Files);

internal sealed record GitRecentCommitCatalogSnapshot(
	string Cwd,
	string? RepoRoot,
	string? Branch,
	string? HeadSha,
	bool IsGitRepo,
	bool IsTimedOut,
	DateTimeOffset GeneratedAtUtc,
	IReadOnlyList<GitRecentCommitInfo> Commits);

internal sealed record GitRecentCommitInfo(
	string Sha,
	string ShortSha,
	string Subject,
	string AuthorName,
	DateTimeOffset? CommittedAtUtc,
	int FilesChanged,
	int Insertions,
	int Deletions,
	IReadOnlyList<GitRecentCommitFileStat> FileStats);

internal sealed record GitRecentCommitFileStat(
	string Path,
	int Insertions,
	int Deletions,
	bool IsBinary);

internal sealed record GitDiffFileContentSnapshot(
	string Cwd,
	string? RepoRoot,
	string? Branch,
	string? HeadSha,
	bool IsGitRepo,
	bool IsTimedOut,
	DateTimeOffset GeneratedAtUtc,
	string Path,
	string? CommitSha,
	bool Exists,
	bool IsBinary,
	bool IsTruncated,
	string Content,
	string? Message);

internal sealed record GitWorktreeFileDiff(
	string StatusCode,
	string StatusLabel,
	string Path,
	string? OriginalPath,
	string Patch,
	bool IsBinary);
