using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

var builder = WebApplication.CreateBuilder(args);
ConfigureCodexAppLogs(builder.Configuration);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddDebug();

var defaults = WebRuntimeDefaults.Load(builder.Configuration);
var userSecretsOptions = UserSecretsOptions.Load(builder.Configuration);
builder.Services.AddSingleton(defaults);
builder.Services.AddSingleton(userSecretsOptions);
builder.Services.AddSingleton<RecapSettingsStore>();
builder.Services.AddSingleton<SessionOrchestrator>();
builder.Services.AddSingleton<ServerRuntimeStateTracker>();
builder.Services.AddSingleton<TimelineProjectionService>();
builder.Services.AddSingleton<UserIdentityResolver>();
builder.Services.AddSingleton<UserOpenAiKeyStore>();
builder.Services.AddSingleton<OpenAiTranscriptionClient>();
builder.Services.AddDataProtection();
builder.Services.AddHttpClient();

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets(new WebSocketOptions
{
	KeepAliveInterval = TimeSpan.FromSeconds(20)
});
app.Use(async (context, next) =>
{
	if (defaults.WebSocketAuthRequired &&
		!string.IsNullOrWhiteSpace(defaults.WebSocketAuthToken) &&
		!context.WebSockets.IsWebSocketRequest)
	{
		WebSocketAuthGuard.SetAuthCookie(context.Response, defaults.WebSocketAuthToken, context.Request.IsHttps);
	}

	await next();
});

app.MapGet("/logs", async context =>
{
	var webRoot = app.Environment.WebRootPath;
	if (string.IsNullOrWhiteSpace(webRoot))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	var logsPagePath = Path.Combine(webRoot, "logs.html");
	if (!File.Exists(logsPagePath))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	context.Response.ContentType = "text/html; charset=utf-8";
	await context.Response.SendFileAsync(logsPagePath);
});

app.MapGet("/watcher", async context =>
{
	var webRoot = app.Environment.WebRootPath;
	if (string.IsNullOrWhiteSpace(webRoot))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	var watcherPagePath = Path.Combine(webRoot, "watcher.html");
	if (!File.Exists(watcherPagePath))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	context.Response.ContentType = "text/html; charset=utf-8";
	await context.Response.SendFileAsync(watcherPagePath);
});

app.MapGet("/recap", async context =>
{
	var webRoot = app.Environment.WebRootPath;
	if (string.IsNullOrWhiteSpace(webRoot))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	var recapPagePath = Path.Combine(webRoot, "recap.html");
	if (!File.Exists(recapPagePath))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	context.Response.ContentType = "text/html; charset=utf-8";
	await context.Response.SendFileAsync(recapPagePath);
});

app.MapGet("/server", async context =>
{
	var webRoot = app.Environment.WebRootPath;
	if (string.IsNullOrWhiteSpace(webRoot))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	var serverPagePath = Path.Combine(webRoot, "server.html");
	if (!File.Exists(serverPagePath))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	context.Response.ContentType = "text/html; charset=utf-8";
	await context.Response.SendFileAsync(serverPagePath);
});

app.MapGet("/settings", async context =>
{
	var webRoot = app.Environment.WebRootPath;
	if (string.IsNullOrWhiteSpace(webRoot))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	var settingsPagePath = Path.Combine(webRoot, "settings.html");
	if (!File.Exists(settingsPagePath))
	{
		context.Response.StatusCode = StatusCodes.Status404NotFound;
		return;
	}

	context.Response.ContentType = "text/html; charset=utf-8";
	await context.Response.SendFileAsync(settingsPagePath);
});

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
			new JsonSerializerOptions
			{
				PropertyNameCaseInsensitive = true
			},
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
	return Results.Ok(new
	{
		reportsRootPath = settings.ReportsRootPath,
		defaultReportsRootPath = settings.DefaultReportsRootPath,
		isDefault = settings.IsDefault,
		settingsFilePath = settings.SettingsFilePath
	});
});

app.MapPut("/api/settings/recap", async (HttpRequest request, RecapSettingsStore recapSettingsStore, CancellationToken cancellationToken) =>
{
	RecapSettingsUpdateRequest? updateRequest;
	try
	{
		updateRequest = await JsonSerializer.DeserializeAsync<RecapSettingsUpdateRequest>(
			request.Body,
			new JsonSerializerOptions
			{
				PropertyNameCaseInsensitive = true
			},
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
		return Results.Ok(new
		{
			reportsRootPath = settings.ReportsRootPath,
			defaultReportsRootPath = settings.DefaultReportsRootPath,
			isDefault = settings.IsDefault,
			settingsFilePath = settings.SettingsFilePath
		});
	}
	catch (ArgumentException ex)
	{
		return Results.BadRequest(new { message = ex.Message });
	}
});

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
	var cursorRaw = request.Query["cursor"].ToString();
	long? cursor = null;
	if (!string.IsNullOrWhiteSpace(cursorRaw))
	{
		if (!long.TryParse(cursorRaw, out var parsedCursor) || parsedCursor < 0)
		{
			return Results.BadRequest(new { message = "cursor must be a non-negative integer." });
		}

		cursor = parsedCursor;
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
	try
	{
		var watch = orchestrator.WatchTurns(threadId, maxEntries, initial: true, cursor: null, includeActiveTurnDetail: false);
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
	var cursorRaw = request.Query["cursor"].ToString();
	long? cursor = null;
	if (!string.IsNullOrWhiteSpace(cursorRaw))
	{
		if (!long.TryParse(cursorRaw, out var parsedCursor) || parsedCursor < 0)
		{
			return Results.BadRequest(new { message = "cursor must be a non-negative integer." });
		}

		cursor = parsedCursor;
	}

	try
	{
		var watch = orchestrator.WatchTurns(threadId, maxEntries, initial, cursor, includeActiveTurnDetail: true);
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

	try
	{
		var detail = orchestrator.GetTurnDetail(threadId, turnId, maxEntries);
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

	var cursorRaw = request.Query["cursor"].ToString();
	long? cursor = null;
	if (!string.IsNullOrWhiteSpace(cursorRaw))
	{
		if (!long.TryParse(cursorRaw, out var parsedCursor) || parsedCursor < 0)
		{
			return Results.BadRequest(new { message = "cursor must be a non-negative integer." });
		}

		cursor = parsedCursor;
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

app.MapGet("/api/security/config", (WebRuntimeDefaults defaults) =>
{
	var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown";
	return Results.Ok(new
	{
		projectName = "Buffaly.CodexEmbedded",
		projectVersion = version,
		attribution = "Built by Buffaly (Intelligence Factory LLC)",
		attributionUrl = "https://buffa.ly",
		notAffiliated = "Not affiliated with OpenAI",
		securityDocPath = "docs/security.md",
		webSocketAuthRequired = defaults.WebSocketAuthRequired,
		publicExposureEnabled = defaults.PublicExposureEnabled,
		nonLocalBindConfigured = defaults.NonLocalBindConfigured,
		unsafeConfigurationDetected = defaults.UnsafeConfigurationDetected,
		unsafeReasons = defaults.UnsafeConfigurationReasons,
		securityWarningMessage = "Security warning: this UI can execute commands and modify files through Codex. Do not expose it to the public internet. Recommended: bind to localhost and access via Tailscale tailnet-only."
	});
});

app.MapGet("/api/settings/openai-key/status", async (
	HttpContext context,
	WebRuntimeDefaults defaults,
	UserIdentityResolver userIdentityResolver,
	UserOpenAiKeyStore userOpenAiKeyStore) =>
{
	if (!IsHttpRequestAuthorized(context.Request, defaults))
	{
		return Results.Unauthorized();
	}

	var userId = userIdentityResolver.ResolveUserId(context);
	var status = await userOpenAiKeyStore.GetStatusAsync(userId, context.RequestAborted);
	return Results.Ok(new
	{
		hasKey = status.HasKey,
		maskedKeyHint = status.MaskedKeyHint,
		updatedAtUtc = status.UpdatedAtUtc
	});
});

app.MapPut("/api/settings/openai-key", async (
	HttpContext context,
	OpenAiKeyUpdateRequest body,
	WebRuntimeDefaults defaults,
	UserIdentityResolver userIdentityResolver,
	UserOpenAiKeyStore userOpenAiKeyStore) =>
{
	if (!IsHttpRequestAuthorized(context.Request, defaults))
	{
		return Results.Unauthorized();
	}

	var apiKey = body?.ApiKey?.Trim() ?? string.Empty;
	if (string.IsNullOrWhiteSpace(apiKey))
	{
		return Results.BadRequest(new { message = "apiKey is required." });
	}

	var userId = userIdentityResolver.ResolveUserId(context);
	await userOpenAiKeyStore.SaveAsync(userId, apiKey, context.RequestAborted);
	var status = await userOpenAiKeyStore.GetStatusAsync(userId, context.RequestAborted);
	return Results.Ok(new
	{
		hasKey = status.HasKey,
		maskedKeyHint = status.MaskedKeyHint,
		updatedAtUtc = status.UpdatedAtUtc
	});
});

app.MapDelete("/api/settings/openai-key", async (
	HttpContext context,
	WebRuntimeDefaults defaults,
	UserIdentityResolver userIdentityResolver,
	UserOpenAiKeyStore userOpenAiKeyStore) =>
{
	if (!IsHttpRequestAuthorized(context.Request, defaults))
	{
		return Results.Unauthorized();
	}

	var userId = userIdentityResolver.ResolveUserId(context);
	await userOpenAiKeyStore.DeleteAsync(userId, context.RequestAborted);
	return Results.Ok(new
	{
		hasKey = false,
		maskedKeyHint = (string?)null,
		updatedAtUtc = (string?)null
	});
});

app.MapPost("/api/transcribe", async (
	HttpContext context,
	WebRuntimeDefaults defaults,
	UserIdentityResolver userIdentityResolver,
	UserOpenAiKeyStore userOpenAiKeyStore,
	OpenAiTranscriptionClient openAiTranscriptionClient) =>
{
	if (!IsHttpRequestAuthorized(context.Request, defaults))
	{
		return Results.Unauthorized();
	}

	var userId = userIdentityResolver.ResolveUserId(context);
	var apiKey = await userOpenAiKeyStore.TryGetApiKeyAsync(userId, context.RequestAborted);
	if (string.IsNullOrWhiteSpace(apiKey))
	{
		return Results.BadRequest(new { message = "OpenAI API key is not configured. Set it in Settings before using speech-to-text." });
	}

	if (!context.Request.HasFormContentType)
	{
		return Results.BadRequest(new { message = "Expected multipart form upload with field 'file'." });
	}

	IFormCollection form;
	try
	{
		form = await context.Request.ReadFormAsync(context.RequestAborted);
	}
	catch (InvalidDataException ex)
	{
		Logs.DebugLog.WriteEvent("Transcribe", $"Invalid multipart form payload: {ex.Message}");
		return Results.BadRequest(new { message = "Invalid audio upload payload. Retry recording and try again." });
	}
	catch (IOException ex)
	{
		Logs.DebugLog.WriteEvent("Transcribe", $"Failed reading upload payload: {ex.Message}");
		return Results.BadRequest(new { message = "Failed reading uploaded audio. Retry and try again." });
	}

	var file = form.Files.GetFile("file") ?? (form.Files.Count > 0 ? form.Files[0] : null);
	if (file is null)
	{
		return Results.BadRequest(new { message = "No audio file was uploaded." });
	}

	if (file.Length <= 0)
	{
		return Results.BadRequest(new { message = "Audio file is empty." });
	}
	if (file.Length > (15 * 1024 * 1024))
	{
		return Results.BadRequest(new { message = "Audio file exceeds 15 MB limit." });
	}

	byte[] audioBytes;
	try
	{
		using var memoryStream = new MemoryStream();
		await file.CopyToAsync(memoryStream, context.RequestAborted);
		audioBytes = memoryStream.ToArray();
	}
	catch (IOException ex)
	{
		Logs.DebugLog.WriteEvent("Transcribe", $"Failed copying upload payload: {ex.Message}");
		return Results.BadRequest(new { message = "Uploaded audio could not be processed. Retry recording and try again." });
	}

	try
	{
		var transcript = await openAiTranscriptionClient.TranscribeAsync(
			apiKey,
			audioBytes,
			file.FileName,
			file.ContentType,
			"whisper-1",
			context.RequestAborted);
		return Results.Text(transcript ?? string.Empty, "text/plain; charset=utf-8");
	}
	catch (OpenAiTranscriptionException ex)
	{
		Logs.DebugLog.WriteEvent("Transcribe", ex.Message);
		return Results.Problem(
			statusCode: StatusCodes.Status502BadGateway,
			title: "Transcription request failed.",
			detail: "OpenAI transcription request failed.");
	}
	catch (OperationCanceledException)
	{
		return Results.BadRequest(new { message = "Transcription request was canceled." });
	}
	catch (Exception ex)
	{
		Logs.LogError(ex);
		return Results.Problem(
			statusCode: StatusCodes.Status500InternalServerError,
			title: "Transcription failed.",
			detail: "Unable to transcribe uploaded audio.");
	}
});

app.MapGet("/api/server/state/current", (
	SessionOrchestrator orchestrator,
	WebRuntimeDefaults defaults,
	ServerRuntimeStateTracker runtimeTracker) =>
{
	var capturedAtUtc = DateTimeOffset.UtcNow;
	var threadNameById = new Dictionary<string, string>(StringComparer.Ordinal);
	foreach (var stored in CodexSessionCatalog.ListSessions(defaults.CodexHomePath, limit: 0))
	{
		if (string.IsNullOrWhiteSpace(stored.ThreadId) || string.IsNullOrWhiteSpace(stored.ThreadName))
		{
			continue;
		}

		if (!threadNameById.ContainsKey(stored.ThreadId))
		{
			threadNameById[stored.ThreadId] = stored.ThreadName;
		}
	}

	var snapshots = orchestrator.GetSessionSnapshots()
		.Select(snapshot =>
		{
			var normalizedCwd = ServerStateSnapshotBuilder.NormalizeProjectCwd(snapshot.Cwd);
			var pendingApproval = snapshot.PendingApproval;
			threadNameById.TryGetValue(snapshot.ThreadId, out var threadName);
			threadName = string.IsNullOrWhiteSpace(threadName) ? null : threadName;
			var sessionState = snapshot.IsTurnInFlight
				? "in_response"
				: pendingApproval is not null
					? "awaiting_approval"
					: snapshot.QueuedTurnCount > 0
						? "queued"
						: "idle";

			return new ServerStateSnapshotBuilder.ServerSessionRow(
				SessionId: snapshot.SessionId,
				ThreadId: snapshot.ThreadId,
				ThreadName: threadName,
				Cwd: snapshot.Cwd,
				NormalizedCwd: normalizedCwd,
				Model: snapshot.Model,
				ReasoningEffort: snapshot.ReasoningEffort,
				IsTurnInFlight: snapshot.IsTurnInFlight,
				IsTurnInFlightInferredFromLogs: snapshot.IsTurnInFlightInferredFromLogs,
				IsTurnInFlightLogOnly: snapshot.IsTurnInFlightLogOnly,
				State: sessionState,
				QueuedTurnCount: snapshot.QueuedTurnCount,
				TurnCountInMemory: snapshot.TurnCountInMemory,
				PendingApproval: pendingApproval is null
					? null
					: new ServerStateSnapshotBuilder.ServerPendingApprovalRow(
						ApprovalId: pendingApproval.ApprovalId,
						RequestType: pendingApproval.RequestType,
						Summary: pendingApproval.Summary,
						Reason: pendingApproval.Reason,
						Cwd: pendingApproval.Cwd,
						Actions: pendingApproval.Actions,
						CreatedAtUtc: pendingApproval.CreatedAtUtc.ToString("O")));
		})
		.OrderBy(row => row.NormalizedCwd, StringComparer.Ordinal)
		.ThenBy(row => row.ThreadId, StringComparer.Ordinal)
		.ThenBy(row => row.SessionId, StringComparer.Ordinal)
		.ToList();

	var projects = snapshots
		.GroupBy(row => row.NormalizedCwd, StringComparer.Ordinal)
		.Select(group =>
		{
			var orderedSessions = group
				.OrderBy(item => item.ThreadId, StringComparer.Ordinal)
				.ThenBy(item => item.SessionId, StringComparer.Ordinal)
				.ToArray();

			return new
			{
				projectKey = group.Key,
				cwd = orderedSessions.Length > 0 ? orderedSessions[0].Cwd : null,
				normalizedCwd = group.Key,
				sessionCount = orderedSessions.Length,
				turnsInFlight = orderedSessions.Count(item => item.IsTurnInFlight),
				turnsInFlightInferredFromLogs = orderedSessions.Count(item => item.IsTurnInFlightInferredFromLogs),
				turnsInFlightLogOnly = orderedSessions.Count(item => item.IsTurnInFlightLogOnly),
				pendingApprovals = orderedSessions.Count(item => item.PendingApproval is not null),
				queuedMessages = orderedSessions.Sum(item => item.QueuedTurnCount),
				turnsInMemory = orderedSessions.Sum(item => item.TurnCountInMemory),
				sessions = orderedSessions.Select(item => new
				{
					sessionId = item.SessionId,
					threadId = item.ThreadId,
					threadName = item.ThreadName,
					model = item.Model,
					reasoningEffort = item.ReasoningEffort,
					isTurnInFlight = item.IsTurnInFlight,
					isTurnInFlightInferredFromLogs = item.IsTurnInFlightInferredFromLogs,
					isTurnInFlightLogOnly = item.IsTurnInFlightLogOnly,
					state = item.State,
					queuedTurnCount = item.QueuedTurnCount,
					turnCountInMemory = item.TurnCountInMemory,
					pendingApprovalId = item.PendingApproval?.ApprovalId
				}).ToArray()
			};
		})
		.OrderByDescending(project => project.sessionCount)
		.ThenBy(project => project.normalizedCwd, StringComparer.Ordinal)
		.ToArray();

	var runtime = runtimeTracker.GetSnapshot(capturedAtUtc);
	var codexHomePath = CodexHomePaths.ResolveCodexHomePath(defaults.CodexHomePath);
	var turnsInFlight = snapshots.Count(row => row.IsTurnInFlight);
	var turnsInFlightInferredFromLogs = snapshots.Count(row => row.IsTurnInFlightInferredFromLogs);
	var turnsInFlightLogOnly = snapshots.Count(row => row.IsTurnInFlightLogOnly);
	var pendingApprovals = snapshots.Count(row => row.PendingApproval is not null);
	var queuedMessages = snapshots.Sum(row => row.QueuedTurnCount);
	var turnsInMemory = snapshots.Sum(row => row.TurnCountInMemory);

	return Results.Ok(new
	{
		capturedAtUtc = capturedAtUtc.ToString("O"),
		server = new
		{
			startedAtUtc = runtime.StartedAtUtc.ToString("O"),
			uptimeSeconds = runtime.UptimeSeconds,
			activeWebSocketConnections = runtime.ActiveWebSocketConnections,
			totalWebSocketConnectionsAccepted = runtime.TotalWebSocketConnectionsAccepted,
			lastWebSocketAcceptedUtc = runtime.LastWebSocketAcceptedUtc?.ToString("O"),
			codexPath = defaults.CodexPath,
			codexHomePath,
			defaultCwd = defaults.DefaultCwd,
			defaultModel = defaults.DefaultModel,
			turnTimeoutSeconds = defaults.TurnTimeoutSeconds,
			turnSlotWaitTimeoutSeconds = defaults.TurnSlotWaitTimeoutSeconds,
			turnSlotWaitPollSeconds = defaults.TurnSlotWaitPollSeconds
		},
		totals = new
		{
			activeProjects = projects.Length,
			activeSessions = snapshots.Count,
			turnsInFlight,
			turnsInFlightInferredFromLogs,
			turnsInFlightLogOnly,
			pendingApprovals,
			queuedMessages,
			turnsInMemory
		},
		projects,
		sessions = snapshots.Select(row => new
		{
			sessionId = row.SessionId,
			threadId = row.ThreadId,
			threadName = row.ThreadName,
			cwd = row.Cwd,
			normalizedCwd = row.NormalizedCwd,
			model = row.Model,
			reasoningEffort = row.ReasoningEffort,
			isTurnInFlight = row.IsTurnInFlight,
			isTurnInFlightInferredFromLogs = row.IsTurnInFlightInferredFromLogs,
			isTurnInFlightLogOnly = row.IsTurnInFlightLogOnly,
			state = row.State,
			queuedTurnCount = row.QueuedTurnCount,
			turnCountInMemory = row.TurnCountInMemory,
			pendingApproval = row.PendingApproval
		}).ToArray()
	});
});

app.Map("/ws", async context =>
{
	var remoteIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
	var origin = context.Request.Headers["Origin"].ToString();
	var userAgent = context.Request.Headers["User-Agent"].ToString();
	var wsVersion = context.Request.Headers["Sec-WebSocket-Version"].ToString();
	var wsProtocol = context.Request.Headers["Sec-WebSocket-Protocol"].ToString();
	var queryState = context.Request.QueryString.HasValue ? "present" : "none";
	Logs.DebugLog.WriteEvent(
		"WebSocket",
		$"Incoming request ip={remoteIp} path={context.Request.Path} query={queryState} isWs={context.WebSockets.IsWebSocketRequest} origin={origin} wsVersion={wsVersion} wsProtocol={wsProtocol} ua={userAgent}");

	if (!context.WebSockets.IsWebSocketRequest)
	{
		Logs.DebugLog.WriteEvent("WebSocket", $"Rejected non-websocket request for /ws from {remoteIp}");
		context.Response.StatusCode = StatusCodes.Status400BadRequest;
		await context.Response.WriteAsync("WebSocket expected.");
		return;
	}

	if (defaults.WebSocketAuthRequired &&
		!string.IsNullOrWhiteSpace(defaults.WebSocketAuthToken) &&
		!WebSocketAuthGuard.IsAuthorized(context.Request, defaults.WebSocketAuthToken))
	{
		Logs.DebugLog.WriteEvent("WebSocket", $"Rejected unauthorized websocket request for /ws from {remoteIp}");
		context.Response.StatusCode = StatusCodes.Status401Unauthorized;
		await context.Response.WriteAsync("Unauthorized.");
		return;
	}

	try
	{
		var orchestrator = context.RequestServices.GetRequiredService<SessionOrchestrator>();
		var runtimeTracker = context.RequestServices.GetRequiredService<ServerRuntimeStateTracker>();
		using var socket = await context.WebSockets.AcceptWebSocketAsync();
		runtimeTracker.OnWebSocketAccepted();
		Logs.DebugLog.WriteEvent(
			"WebSocket",
			$"Accepted websocket connection id={context.Connection.Id} subProtocol={socket.SubProtocol ?? "(none)"}");
		try
		{
			await using var session = new MultiSessionWebCliSocketSession(socket, defaults, orchestrator, context.Connection.Id);
			await session.RunAsync(context.RequestAborted);
			Logs.DebugLog.WriteEvent(
				"WebSocket",
				$"Closed websocket connection id={context.Connection.Id} state={socket.State} closeStatus={socket.CloseStatus} closeDescription={socket.CloseStatusDescription}");
		}
		finally
		{
			runtimeTracker.OnWebSocketClosed();
		}
	}
	catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
	{
		Logs.DebugLog.WriteEvent("WebSocket", $"Websocket request canceled id={context.Connection.Id}");
	}
	catch (WebSocketException ex) when (IsExpectedWebSocketDisconnect(ex))
	{
		Logs.DebugLog.WriteEvent("WebSocket", $"Websocket disconnected abruptly id={context.Connection.Id}: {ex.Message}");
	}
	catch (Exception ex)
	{
		Logs.LogError(ex);
		throw;
	}
});

static bool IsExpectedWebSocketDisconnect(WebSocketException ex)
{
	if (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
	{
		return true;
	}

	if (ex.InnerException is SocketException socketEx &&
		(socketEx.SocketErrorCode == SocketError.ConnectionReset || socketEx.SocketErrorCode == SocketError.OperationAborted))
	{
		return true;
	}

	if (ex.InnerException is IOException ioEx &&
		ioEx.InnerException is SocketException nestedSocketEx &&
		(nestedSocketEx.SocketErrorCode == SocketError.ConnectionReset || nestedSocketEx.SocketErrorCode == SocketError.OperationAborted))
	{
		return true;
	}

	return false;
}

static bool IsHttpRequestAuthorized(HttpRequest request, WebRuntimeDefaults defaults)
{
	if (!defaults.WebSocketAuthRequired || string.IsNullOrWhiteSpace(defaults.WebSocketAuthToken))
	{
		return true;
	}

	return WebSocketAuthGuard.IsAuthorized(request, defaults.WebSocketAuthToken);
}

try
{
	Logs.DebugLog.WriteEvent("Startup", "Buffaly.CodexEmbedded.Web starting.");
	app.Run();
}
catch (Exception ex)
{
	Logs.LogError(ex);
	throw;
}

static void ConfigureCodexAppLogs(IConfiguration configuration)
{
	var logSettings = configuration.GetSection("LogSettings").Get<Logs.LogSettings>();
	if (logSettings is null)
	{
		throw new InvalidOperationException("Could not load configuration: LogSettings");
	}

	try
	{
		if (!string.IsNullOrWhiteSpace(logSettings.DebugPath))
		{
			Directory.CreateDirectory(logSettings.DebugPath);
		}

		Logs.Config(logSettings);
	}
	catch (Exception ex)
	{
		var originalDebugPath = logSettings.DebugPath;
		var fallbackPath = Path.Combine(Environment.CurrentDirectory, "logs", "Buffaly.CodexEmbedded.Web");
		Directory.CreateDirectory(fallbackPath);
		logSettings.DebugPath = fallbackPath;
		Logs.Config(logSettings);
		Logs.LogError(new InvalidOperationException($"Failed to use LogSettings.DebugPath '{originalDebugPath}'. Fallback '{fallbackPath}' was applied.", ex));
	}
}
