using System.Globalization;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

internal static class WebEndpointMappings
{
	public static void MapStaticHtmlPageEndpoints(this WebApplication app)
	{
		MapStaticHtmlPage(app, "/logs", "logs.html");
		MapStaticHtmlPage(app, "/watcher", "watcher.html");
		MapStaticHtmlPage(app, "/recap", "recap.html");
		MapStaticHtmlPage(app, "/server", "server.html");
		MapStaticHtmlPage(app, "/settings", "settings.html");
		MapStaticHtmlPage(app, "/help/codex-install", "codex-install-help.html");
	}

	public static void MapSessionCatalogAndRecapEndpoints(this WebApplication app)
	{
		app.MapGet("/api/logs/sessions", (HttpRequest request, WebRuntimeDefaults defaults) =>
		{
			var limit = QueryValueParser.GetPositiveInt(request.Query["limit"], fallback: 20, max: 100);
			var sessions = CodexSessionCatalog.ListSessions(defaults.CodexHomePath, limit: 0)
				.Where(x => !string.IsNullOrWhiteSpace(x.SessionFilePath))
				.OrderByDescending(x => x.UpdatedAtUtc ?? DateTimeOffset.MinValue)
				.ThenBy(x => x.ThreadId, StringComparer.Ordinal)
				.Take(limit)
				.Select(x => new
				{
					threadId = x.ThreadId,
					threadName = x.ThreadName,
					updatedAtUtc = x.UpdatedAtUtc?.ToString("O"),
					cwd = x.Cwd,
					model = x.Model,
					sessionFilePath = x.SessionFilePath
				})
				.ToArray();

			return Results.Ok(new
			{
				codexHomePath = CodexHomePaths.ResolveCodexHomePath(defaults.CodexHomePath),
				sessions
			});
		});

		app.MapGet("/api/recap/projects", (WebRuntimeDefaults defaults) =>
		{
			var sessions = CodexSessionCatalog.ListSessions(defaults.CodexHomePath, limit: 0)
				.Where(x => !string.IsNullOrWhiteSpace(x.SessionFilePath))
				.ToArray();

			var projects = sessions
				.GroupBy(x => string.IsNullOrWhiteSpace(x.Cwd) ? "(unknown)" : x.Cwd!, StringComparer.OrdinalIgnoreCase)
				.Select(group => new
				{
					cwd = group.Key,
					sessionCount = group.Count(),
					lastUpdatedUtc = group.Max(x => x.UpdatedAtUtc)?.ToString("O")
				})
				.OrderBy(x => x.cwd, StringComparer.OrdinalIgnoreCase)
				.ToArray();

			return Results.Ok(new
			{
				codexHomePath = CodexHomePaths.ResolveCodexHomePath(defaults.CodexHomePath),
				projects
			});
		});

		app.MapPost("/api/recap/export", async (HttpRequest request, WebRuntimeDefaults defaults, RecapSettingsStore recapSettingsStore, CancellationToken cancellationToken) =>
		{
			RecapExportRequest? exportRequest;
			try
			{
				exportRequest = await JsonSerializer.DeserializeAsync<RecapExportRequest>(
					request.Body,
					RecapJsonOptions,
					cancellationToken);
			}
			catch (Exception ex)
			{
				return Results.BadRequest(new { message = $"Invalid request JSON: {ex.Message}" });
			}

			if (exportRequest is null || string.IsNullOrWhiteSpace(exportRequest.StartUtc) || string.IsNullOrWhiteSpace(exportRequest.EndUtc))
			{
				return Results.BadRequest(new { message = "startUtc and endUtc are required." });
			}

			if (!DateTimeOffset.TryParse(exportRequest.StartUtc, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var startUtc))
			{
				return Results.BadRequest(new { message = "startUtc must be a valid ISO timestamp." });
			}
			if (!DateTimeOffset.TryParse(exportRequest.EndUtc, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var endUtc))
			{
				return Results.BadRequest(new { message = "endUtc must be a valid ISO timestamp." });
			}

			startUtc = startUtc.ToUniversalTime();
			endUtc = endUtc.ToUniversalTime();
			if (endUtc < startUtc)
			{
				return Results.BadRequest(new { message = "endUtc must be greater than or equal to startUtc." });
			}

			var selectedProjects = (exportRequest.Projects ?? Array.Empty<string>())
				.Where(x => !string.IsNullOrWhiteSpace(x))
				.Select(x => x.Trim())
				.Distinct(StringComparer.OrdinalIgnoreCase)
				.ToHashSet(StringComparer.OrdinalIgnoreCase);
			var includeAllDetails = string.Equals(exportRequest.DetailLevel, "all", StringComparison.OrdinalIgnoreCase);

			var sessions = CodexSessionCatalog.ListSessions(defaults.CodexHomePath, limit: 0)
				.Where(x => !string.IsNullOrWhiteSpace(x.SessionFilePath))
				.Where(x => selectedProjects.Count == 0 || selectedProjects.Contains(string.IsNullOrWhiteSpace(x.Cwd) ? "(unknown)" : x.Cwd!))
				.OrderBy(x => x.Cwd ?? string.Empty, StringComparer.OrdinalIgnoreCase)
				.ThenByDescending(x => x.UpdatedAtUtc ?? DateTimeOffset.MinValue)
				.ThenBy(x => x.ThreadId, StringComparer.Ordinal)
				.ToArray();

			var report = RecapMarkdownBuilder.BuildReport(
				sessions,
				startUtc,
				endUtc,
				includeAllDetails);

			var reportsRoot = recapSettingsStore.GetReportsRootPath();
			Directory.CreateDirectory(reportsRoot);
			var fileName = $"recap-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.md";
			var fullPath = Path.Combine(reportsRoot, fileName);
			await File.WriteAllTextAsync(fullPath, report.Markdown, new UTF8Encoding(false), cancellationToken);
			var preview = RecapMarkdownBuilder.BuildUtf8Preview(report.Markdown, maxBytes: 2 * 1024 * 1024, out var previewTruncated, out var totalBytes);

			return Results.Ok(new
			{
				fileName,
				filePath = fullPath,
				downloadUrl = $"/api/recap/reports/{Uri.EscapeDataString(fileName)}",
				createdAtUtc = DateTimeOffset.UtcNow.ToString("O"),
				projectCount = report.ProjectCount,
				sessionCount = report.SessionCount,
				entryCount = report.EntryCount,
				previewMarkdown = preview,
				previewTruncated,
				previewBytes = Encoding.UTF8.GetByteCount(preview),
				totalBytes
			});
		});

		app.MapGet("/api/recap/reports", (HttpRequest request, RecapSettingsStore recapSettingsStore) =>
		{
			var limit = QueryValueParser.GetPositiveInt(request.Query["limit"], fallback: 200, max: 1000);
			var reportsRoot = recapSettingsStore.GetReportsRootPath();
			if (!Directory.Exists(reportsRoot))
			{
				return Results.Ok(new
				{
					reportsRoot,
					reports = Array.Empty<object>()
				});
			}

			var reports = Directory.EnumerateFiles(reportsRoot, "*.md", SearchOption.TopDirectoryOnly)
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
				.Take(limit)
				.Select(info => new
				{
					fileName = info.Name,
					filePath = info.FullName,
					lastWriteUtc = new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero).ToString("O"),
					sizeBytes = info.Length,
					downloadUrl = $"/api/recap/reports/{Uri.EscapeDataString(info.Name)}"
				})
				.ToArray();

			return Results.Ok(new
			{
				reportsRoot,
				reports
			});
		});

		app.MapGet("/api/recap/reports/{fileName}", (string fileName, RecapSettingsStore recapSettingsStore) =>
		{
			var safeFileName = Path.GetFileName(fileName ?? string.Empty);
			if (string.IsNullOrWhiteSpace(safeFileName) || !safeFileName.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
			{
				return Results.BadRequest(new { message = "Invalid report file name." });
			}

			var reportsRoot = recapSettingsStore.GetReportsRootPath();
			var fullPath = Path.Combine(reportsRoot, safeFileName);
			if (!File.Exists(fullPath))
			{
				return Results.NotFound(new { message = $"Report not found: {safeFileName}" });
			}

			return Results.File(fullPath, "text/markdown; charset=utf-8", fileDownloadName: safeFileName);
		});

		app.MapGet("/api/settings/recap", (RecapSettingsStore recapSettingsStore) =>
		{
			var settings = recapSettingsStore.GetSnapshot();
			return Results.Ok(BuildRecapSettingsPayload(settings));
		});

		app.MapPut("/api/settings/recap", async (HttpRequest request, RecapSettingsStore recapSettingsStore, CancellationToken cancellationToken) =>
		{
			RecapSettingsUpdateRequest? updateRequest;
			try
			{
				updateRequest = await JsonSerializer.DeserializeAsync<RecapSettingsUpdateRequest>(
					request.Body,
					RecapJsonOptions,
					cancellationToken);
			}
			catch (Exception ex)
			{
				return Results.BadRequest(new { message = $"Invalid request JSON: {ex.Message}" });
			}

			updateRequest ??= new RecapSettingsUpdateRequest();
			try
			{
				var settings = recapSettingsStore.SaveReportsRootPath(updateRequest.ReportsRootPath, updateRequest.UseDefault);
				return Results.Ok(BuildRecapSettingsPayload(settings));
			}
			catch (ArgumentException ex)
			{
				return Results.BadRequest(new { message = ex.Message });
			}
		});
	}

	public static void MapTimelineAndRuntimeLogEndpoints(this WebApplication app)
	{
		app.MapGet("/api/logs/watch", (HttpRequest request, WebRuntimeDefaults defaults) =>
		{
			var threadId = request.Query["threadId"].ToString();
			if (string.IsNullOrWhiteSpace(threadId))
			{
				return Results.BadRequest(new { message = "threadId query parameter is required." });
			}

			var session = CodexSessionCatalog.ListSessions(defaults.CodexHomePath, limit: 0)
				.FirstOrDefault(x => string.Equals(x.ThreadId, threadId, StringComparison.Ordinal));

			if (session is null || string.IsNullOrWhiteSpace(session.SessionFilePath))
			{
				return Results.NotFound(new { message = $"No session file found for threadId '{threadId}'." });
			}

			var path = Path.GetFullPath(session.SessionFilePath);
			if (!File.Exists(path))
			{
				return Results.NotFound(new { message = $"Session file does not exist: '{path}'." });
			}

			var maxLines = QueryValueParser.GetPositiveInt(request.Query["maxLines"], fallback: 200, max: 1000);
			var initial = QueryValueParser.GetBool(request.Query["initial"]);
			var cursor = ParseNonNegativeLongQuery(request, "cursor");
			if (cursor is null && !string.IsNullOrWhiteSpace(request.Query["cursor"]))
			{
				return Results.BadRequest(new { message = "cursor must be a non-negative integer." });
			}

			JsonlWatchResult watchResult;
			try
			{
				watchResult = initial || cursor is null
					? JsonlFileTailReader.ReadInitial(path, maxLines)
					: JsonlFileTailReader.ReadFromCursor(path, cursor.Value, maxLines);
			}
			catch (Exception ex)
			{
				return Results.Problem(
					statusCode: StatusCodes.Status500InternalServerError,
					title: "Failed to read session log file.",
					detail: ex.Message);
			}

			return Results.Ok(new
			{
				threadId = session.ThreadId,
				threadName = session.ThreadName,
				sessionFilePath = path,
				updatedAtUtc = session.UpdatedAtUtc?.ToString("O"),
				cursor = watchResult.Cursor,
				nextCursor = watchResult.NextCursor,
				fileLength = watchResult.FileLength,
				reset = watchResult.Reset,
				truncated = watchResult.Truncated,
				lines = watchResult.Lines
			});
		});

		app.MapGet("/api/turns/bootstrap", (HttpRequest request, SessionOrchestrator orchestrator) =>
		{
			var threadId = request.Query["threadId"].ToString();
			if (string.IsNullOrWhiteSpace(threadId))
			{
				return Results.BadRequest(new { message = "threadId query parameter is required." });
			}

			var maxEntries = QueryValueParser.GetPositiveInt(request.Query["maxEntries"], fallback: 6000, max: 20000);
			var diag = QueryValueParser.GetBool(request.Query["diag"]);
			try
			{
				var watchStopwatch = Stopwatch.StartNew();
				var watch = orchestrator.WatchTurns(threadId, maxEntries, initial: true, cursor: null, includeActiveTurnDetail: false);
				watchStopwatch.Stop();
				if (diag)
				{
					WriteTimelineDiagnostics(
						endpoint: "bootstrap",
						requestedThreadId: threadId,
						maxEntries: maxEntries,
						initial: true,
						cursor: null,
						watch,
						watchStopwatch.ElapsedMilliseconds);
				}
				return Results.Ok(new
				{
					threadId = watch.ThreadId,
					threadName = watch.ThreadName,
					sessionFilePath = watch.SessionFilePath,
					updatedAtUtc = watch.UpdatedAtUtc?.ToString("O"),
					mode = watch.Mode,
					cursor = watch.Cursor,
					nextCursor = watch.NextCursor,
					reset = watch.Reset,
					truncated = watch.Truncated,
					turnCountInMemory = watch.TurnCountInMemory,
					contextUsage = watch.ContextUsage,
					permission = watch.Permission,
					reasoningSummary = watch.ReasoningSummary,
					turns = watch.Turns
				});
			}
			catch (FileNotFoundException ex)
			{
				return Results.NotFound(new { message = ex.Message });
			}
			catch (Exception ex)
			{
				return Results.Problem(
					statusCode: StatusCodes.Status500InternalServerError,
					title: "Failed to build turn timeline.",
					detail: ex.Message);
			}
		});

		app.MapGet("/api/turns/watch", (HttpRequest request, SessionOrchestrator orchestrator) =>
		{
			var threadId = request.Query["threadId"].ToString();
			if (string.IsNullOrWhiteSpace(threadId))
			{
				return Results.BadRequest(new { message = "threadId query parameter is required." });
			}

			var maxEntries = QueryValueParser.GetPositiveInt(request.Query["maxEntries"], fallback: 6000, max: 20000);
			var initial = QueryValueParser.GetBool(request.Query["initial"]);
			var diag = QueryValueParser.GetBool(request.Query["diag"]);
			var cursor = ParseNonNegativeLongQuery(request, "cursor");
			if (cursor is null && !string.IsNullOrWhiteSpace(request.Query["cursor"]))
			{
				return Results.BadRequest(new { message = "cursor must be a non-negative integer." });
			}

			try
			{
				var watchStopwatch = Stopwatch.StartNew();
				var watch = orchestrator.WatchTurns(threadId, maxEntries, initial, cursor, includeActiveTurnDetail: true);
				watchStopwatch.Stop();
				if (diag)
				{
					WriteTimelineDiagnostics(
						endpoint: "watch",
						requestedThreadId: threadId,
						maxEntries: maxEntries,
						initial: initial,
						cursor: cursor,
						watch,
						watchStopwatch.ElapsedMilliseconds);
				}
				return Results.Ok(new
				{
					threadId = watch.ThreadId,
					threadName = watch.ThreadName,
					sessionFilePath = watch.SessionFilePath,
					updatedAtUtc = watch.UpdatedAtUtc?.ToString("O"),
					mode = watch.Mode,
					cursor = watch.Cursor,
					nextCursor = watch.NextCursor,
					reset = watch.Reset,
					truncated = watch.Truncated,
					turnCountInMemory = watch.TurnCountInMemory,
					contextUsage = watch.ContextUsage,
					permission = watch.Permission,
					reasoningSummary = watch.ReasoningSummary,
					turns = watch.Turns,
					activeTurnDetail = watch.ActiveTurnDetail
				});
			}
			catch (FileNotFoundException ex)
			{
				return Results.NotFound(new { message = ex.Message });
			}
			catch (Exception ex)
			{
				return Results.Problem(
					statusCode: StatusCodes.Status500InternalServerError,
					title: "Failed to build turn timeline.",
					detail: ex.Message);
			}
		});

		app.MapGet("/api/turns/detail", (HttpRequest request, SessionOrchestrator orchestrator) =>
		{
			var threadId = request.Query["threadId"].ToString();
			if (string.IsNullOrWhiteSpace(threadId))
			{
				return Results.BadRequest(new { message = "threadId query parameter is required." });
			}

			var turnId = request.Query["turnId"].ToString();
			if (string.IsNullOrWhiteSpace(turnId))
			{
				return Results.BadRequest(new { message = "turnId query parameter is required." });
			}

			var maxEntries = QueryValueParser.GetPositiveInt(request.Query["maxEntries"], fallback: 6000, max: 20000);
			var diag = QueryValueParser.GetBool(request.Query["diag"]);

			try
			{
				var detailStopwatch = Stopwatch.StartNew();
				var detail = orchestrator.GetTurnDetail(threadId, turnId, maxEntries);
				detailStopwatch.Stop();
				if (diag)
				{
					var textChars = 0;
					var imageCount = 0;
					AccumulateTurnEntryDiagnostics(detail.User, ref textChars, ref imageCount);
					if (detail.AssistantFinal is not null)
					{
						AccumulateTurnEntryDiagnostics(detail.AssistantFinal, ref textChars, ref imageCount);
					}
					foreach (var entry in detail.Intermediate)
					{
						AccumulateTurnEntryDiagnostics(entry, ref textChars, ref imageCount);
					}

					Logs.DebugLog.WriteEvent(
						"TimelineDiag",
						$"endpoint=detail requestedThread={threadId.Trim()} turnId={turnId.Trim()} maxEntries={maxEntries} elapsedMs={detailStopwatch.ElapsedMilliseconds} intermediateCount={detail.Intermediate.Count} textChars={textChars} imageCount={imageCount}");
				}
				return Results.Ok(new
				{
					threadId = threadId.Trim(),
					turn = detail
				});
			}
			catch (FileNotFoundException ex)
			{
				return Results.NotFound(new { message = ex.Message });
			}
			catch (KeyNotFoundException ex)
			{
				return Results.NotFound(new { message = ex.Message });
			}
			catch (InvalidOperationException ex)
			{
				return Results.BadRequest(new { message = ex.Message });
			}
			catch (Exception ex)
			{
				return Results.Problem(
					statusCode: StatusCodes.Status500InternalServerError,
					title: "Failed to read turn detail.",
					detail: ex.Message);
			}
		});

		app.MapGet("/api/worktree/diff/current", (HttpRequest request, GitWorktreeDiffService gitDiffService, CancellationToken cancellationToken) =>
		{
			var cwd = request.Query["cwd"].ToString();
			if (string.IsNullOrWhiteSpace(cwd))
			{
				Logs.DebugLog.WriteEvent("Audit.Diff", "event=diff_count_request_rejected reason=missing_cwd");
				return Results.BadRequest(new { message = "cwd query parameter is required." });
			}

			var maxFiles = QueryValueParser.GetPositiveInt(request.Query["maxFiles"], fallback: 200, max: 1000);
			var maxPatchChars = QueryValueParser.GetPositiveInt(request.Query["maxPatchChars"], fallback: 250000, max: 1000000);
			Logs.DebugLog.WriteEvent(
				"Audit.Diff",
				$"event=diff_count_requested cwd={cwd} maxFiles={maxFiles} maxPatchChars={maxPatchChars}");
			try
			{
				var snapshot = gitDiffService.GetSnapshot(cwd, maxFiles, maxPatchChars, cancellationToken);
				Logs.DebugLog.WriteEvent(
					"Audit.Diff",
					$"event=diff_count_completed cwd={cwd} repoRoot={snapshot.RepoRoot ?? "(none)"} isGitRepo={snapshot.IsGitRepo} changeCount={snapshot.ChangeCount} fileCount={snapshot.Files.Count} timedOut={snapshot.IsTimedOut}");
				return Results.Ok(new
				{
					cwd = snapshot.Cwd,
					repoRoot = snapshot.RepoRoot,
					branch = snapshot.Branch,
					headSha = snapshot.HeadSha,
					isGitRepo = snapshot.IsGitRepo,
					isTimedOut = snapshot.IsTimedOut,
					generatedAtUtc = snapshot.GeneratedAtUtc.ToString("O"),
					changeCount = snapshot.ChangeCount,
					files = snapshot.Files
				});
			}
			catch (DirectoryNotFoundException ex)
			{
				Logs.DebugLog.WriteEvent("Audit.Diff", $"event=diff_count_failed cwd={cwd} error={ex.Message}");
				return Results.NotFound(new { message = ex.Message });
			}
			catch (OperationCanceledException)
			{
				Logs.DebugLog.WriteEvent("Audit.Diff", $"event=diff_count_canceled cwd={cwd}");
				return Results.BadRequest(new { message = "git diff request was canceled." });
			}
			catch (Exception ex)
			{
				Logs.DebugLog.WriteEvent("Audit.Diff", $"event=diff_count_failed cwd={cwd} error={ex.Message}");
				return Results.Problem(
					statusCode: StatusCodes.Status500InternalServerError,
					title: "Failed to read git worktree diff.",
					detail: ex.Message);
			}
		});

		app.MapGet("/api/logs/realtime/current", (HttpRequest request, WebRuntimeDefaults defaults) =>
		{
			var maxLines = QueryValueParser.GetPositiveInt(request.Query["maxLines"], fallback: 200, max: 1000);
			var initial = QueryValueParser.GetBool(request.Query["initial"]);
			var logFileName = request.Query["logFile"].ToString();
			var logPath = RuntimeSessionLogFinder.ResolveLogPath(defaults.LogRootPath, logFileName);

			if (string.IsNullOrWhiteSpace(logPath))
			{
				return Results.NotFound(new { message = "No runtime session log file found." });
			}

			if (!File.Exists(logPath))
			{
				return Results.NotFound(new { message = $"Runtime log file does not exist: '{logPath}'." });
			}

			var cursor = ParseNonNegativeLongQuery(request, "cursor");
			if (cursor is null && !string.IsNullOrWhiteSpace(request.Query["cursor"]))
			{
				return Results.BadRequest(new { message = "cursor must be a non-negative integer." });
			}

			JsonlWatchResult watchResult;
			try
			{
				watchResult = initial || cursor is null
					? JsonlFileTailReader.ReadInitial(logPath, maxLines)
					: JsonlFileTailReader.ReadFromCursor(logPath, cursor.Value, maxLines);
			}
			catch (Exception ex)
			{
				return Results.Problem(
					statusCode: StatusCodes.Status500InternalServerError,
					title: "Failed to read runtime log file.",
					detail: ex.Message);
			}

			return Results.Ok(new
			{
				logFile = Path.GetFileName(logPath),
				logPath,
				cursor = watchResult.Cursor,
				nextCursor = watchResult.NextCursor,
				fileLength = watchResult.FileLength,
				reset = watchResult.Reset,
				truncated = watchResult.Truncated,
				lines = watchResult.Lines
			});
		});
	}

	private static readonly JsonSerializerOptions RecapJsonOptions = new()
	{
		PropertyNameCaseInsensitive = true
	};

	private static long? ParseNonNegativeLongQuery(HttpRequest request, string key)
	{
		var raw = request.Query[key].ToString();
		if (string.IsNullOrWhiteSpace(raw))
		{
			return null;
		}

		return long.TryParse(raw, out var value) && value >= 0 ? value : null;
	}

	private static void WriteTimelineDiagnostics(
		string endpoint,
		string requestedThreadId,
		int maxEntries,
		bool initial,
		long? cursor,
		SessionOrchestrator.TurnWatchSnapshot watch,
		long elapsedMilliseconds)
	{
		var turns = watch.Turns ?? Array.Empty<SessionOrchestrator.ConsolidatedTurnSnapshot>();
		var turnCount = turns.Count;
		var inFlightTurns = 0;
		var intermediateVisibleCount = 0;
		var intermediateTotalCount = 0;
		var textChars = 0;
		var imageCount = 0;

		foreach (var turn in turns)
		{
			if (turn.IsInFlight)
			{
				inFlightTurns += 1;
			}

			intermediateVisibleCount += turn.Intermediate?.Count ?? 0;
			intermediateTotalCount += Math.Max(turn.IntermediateCount, turn.Intermediate?.Count ?? 0);
			AccumulateTurnEntryDiagnostics(turn.User, ref textChars, ref imageCount);
			if (turn.AssistantFinal is not null)
			{
				AccumulateTurnEntryDiagnostics(turn.AssistantFinal, ref textChars, ref imageCount);
			}

			var intermediate = turn.Intermediate ?? new List<SessionOrchestrator.TurnEntrySnapshot>();
			foreach (var entry in intermediate)
			{
				AccumulateTurnEntryDiagnostics(entry, ref textChars, ref imageCount);
			}
		}

		var activeDetailIntermediateCount = watch.ActiveTurnDetail?.Intermediate?.Count ?? 0;
		var activeDetailIntermediateTotal = watch.ActiveTurnDetail?.IntermediateCount ?? 0;
		Logs.DebugLog.WriteEvent(
			"TimelineDiag",
			$"endpoint={endpoint} requestedThread={requestedThreadId.Trim()} resolvedThread={watch.ThreadId} maxEntries={maxEntries} initial={initial} cursor={(cursor?.ToString() ?? "(none)")} elapsedMs={elapsedMilliseconds} mode={watch.Mode} reset={watch.Reset} truncated={watch.Truncated} turnCount={turnCount} turnCountInMemory={watch.TurnCountInMemory} inFlightTurns={inFlightTurns} intermediateVisible={intermediateVisibleCount} intermediateTotal={intermediateTotalCount} activeDetailIntermediateVisible={activeDetailIntermediateCount} activeDetailIntermediateTotal={activeDetailIntermediateTotal} textChars={textChars} imageCount={imageCount}");
	}

	private static void AccumulateTurnEntryDiagnostics(SessionOrchestrator.TurnEntrySnapshot? entry, ref int textChars, ref int imageCount)
	{
		if (entry is null)
		{
			return;
		}

		if (!string.IsNullOrEmpty(entry.Text))
		{
			textChars += entry.Text.Length;
		}

		imageCount += entry.Images?.Length ?? 0;
	}

	private static object BuildRecapSettingsPayload(RecapSettingsSnapshot settings)
	{
		return new
		{
			reportsRootPath = settings.ReportsRootPath,
			defaultReportsRootPath = settings.DefaultReportsRootPath,
			isDefault = settings.IsDefault,
			settingsFilePath = settings.SettingsFilePath
		};
	}

	private static void MapStaticHtmlPage(WebApplication app, string route, string fileName)
	{
		app.MapGet(route, async context =>
		{
			var webRoot = app.Environment.WebRootPath;
			if (string.IsNullOrWhiteSpace(webRoot))
			{
				context.Response.StatusCode = StatusCodes.Status404NotFound;
				return;
			}

			var pagePath = Path.Combine(webRoot, fileName);
			if (!File.Exists(pagePath))
			{
				context.Response.StatusCode = StatusCodes.Status404NotFound;
				return;
			}

			context.Response.ContentType = "text/html; charset=utf-8";
			context.Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
			context.Response.Headers["Pragma"] = "no-cache";
			context.Response.Headers["Expires"] = "0";
			await context.Response.SendFileAsync(pagePath);
		});
	}
}
