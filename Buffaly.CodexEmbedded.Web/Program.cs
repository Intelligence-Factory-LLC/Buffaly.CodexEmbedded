using System.IO;
using System.Net.WebSockets;
using System.Reflection;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;
using Microsoft.AspNetCore.DataProtection;

var builder = WebApplication.CreateBuilder(args);
ConfigureCodexAppLogs(builder.Configuration);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddDebug();

var defaults = WebRuntimeDefaults.Load(builder.Configuration);
var codexPreflight = CodexPreflightStatus.Evaluate(defaults);
var userSecretsOptions = UserSecretsOptions.Load(builder.Configuration);
builder.Services.AddSingleton(defaults);
builder.Services.AddSingleton(codexPreflight);
builder.Services.AddSingleton(userSecretsOptions);
builder.Services.AddSingleton<RecapSettingsStore>();
builder.Services.AddSingleton<SessionOrchestrator>();
builder.Services.AddSingleton<ServerRuntimeStateTracker>();
builder.Services.AddSingleton<TimelineProjectionService>();
builder.Services.AddSingleton<UserIdentityResolver>();
builder.Services.AddSingleton<UserOpenAiKeyStore>();
builder.Services.AddSingleton<OpenAiTranscriptionClient>();
builder.Services.AddSingleton<GitWorktreeDiffService>();
var dataProtectionKeyPath = ResolveDataProtectionKeyPath();
Directory.CreateDirectory(dataProtectionKeyPath);
builder.Services.AddDataProtection()
	.SetApplicationName("Buffaly.CodexEmbedded")
	.PersistKeysToFileSystem(new DirectoryInfo(dataProtectionKeyPath));
builder.Services.AddHttpClient();

var app = builder.Build();

if (!codexPreflight.IsCodexInstalled)
{
	Logs.DebugLog.WriteEvent(
		"Startup",
		$"Codex preflight failed. configuredPath={codexPreflight.ConfiguredCodexPath} resolvedPath={codexPreflight.ResolvedCodexPath ?? "(missing)"}");
}

app.Use(async (context, next) =>
{
	if (!codexPreflight.IsCodexInstalled && ShouldRedirectToCodexInstallHelp(context.Request.Path))
	{
		context.Response.Redirect(defaults.CodexInstallHelpUrl, permanent: false);
		return;
	}

	await next();
});

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

app.MapStaticHtmlPageEndpoints();
app.MapSessionCatalogAndRecapEndpoints();
app.MapTimelineAndRuntimeLogEndpoints();

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
		webLaunchUrl = defaults.WebLaunchUrl,
		codexInstallHelpUrl = defaults.CodexInstallHelpUrl,
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
			turnSlotWaitPollSeconds = defaults.TurnSlotWaitPollSeconds,
			turnStartAckTimeoutSeconds = defaults.TurnStartAckTimeoutSeconds
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

app.MapGet("/api/runtime/codex-preflight", (CodexPreflightStatus preflight) =>
{
	return Results.Ok(new
	{
		configuredCodexPath = preflight.ConfiguredCodexPath,
		resolvedCodexPath = preflight.ResolvedCodexPath,
		codexHomePath = preflight.CodexHomePath,
		isCodexInstalled = preflight.IsCodexInstalled,
		isVersionCheckSuccessful = preflight.IsVersionCheckSuccessful,
		hasAuthArtifacts = preflight.HasAuthArtifacts,
		isReady = preflight.IsCodexInstalled && preflight.IsVersionCheckSuccessful,
		messages = preflight.Messages
	});
});

app.MapPost("/api/server/session/reset-thread", (
	ServerThreadResetRequest body,
	SessionOrchestrator orchestrator) =>
{
	var sessionId = body?.SessionId?.Trim() ?? string.Empty;
	if (string.IsNullOrWhiteSpace(sessionId))
	{
		return Results.BadRequest(new { message = "sessionId is required." });
	}

	if (!orchestrator.TryResetThreadSession(sessionId, out var errorMessage))
	{
		var message = string.IsNullOrWhiteSpace(errorMessage) ? "Unable to reset thread session." : errorMessage!;
		if (message.StartsWith("Unknown session:", StringComparison.Ordinal))
		{
			return Results.NotFound(new { message });
		}

		return Results.BadRequest(new { message });
	}

	return Results.Ok(new
	{
		sessionId,
		status = "recovering",
		message = "Manual thread reset requested."
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
	catch (WebSocketException ex) when (WebSocketDisconnectClassifier.IsExpected(ex))
	{
		Logs.DebugLog.WriteEvent("WebSocket", $"Websocket disconnected abruptly id={context.Connection.Id}: {ex.Message}");
	}
	catch (Exception ex)
	{
		Logs.LogError(ex);
		throw;
	}
});

static bool IsHttpRequestAuthorized(HttpRequest request, WebRuntimeDefaults defaults)
{
	if (!defaults.WebSocketAuthRequired || string.IsNullOrWhiteSpace(defaults.WebSocketAuthToken))
	{
		return true;
	}

	return WebSocketAuthGuard.IsAuthorized(request, defaults.WebSocketAuthToken);
}

static bool ShouldRedirectToCodexInstallHelp(PathString path)
{
	if (!path.HasValue)
	{
		return true;
	}

	var value = path.Value ?? string.Empty;
	if (string.Equals(value, "/", StringComparison.Ordinal) ||
		string.Equals(value, "/index.html", StringComparison.OrdinalIgnoreCase) ||
		string.Equals(value, "/logs", StringComparison.OrdinalIgnoreCase) ||
		string.Equals(value, "/watcher", StringComparison.OrdinalIgnoreCase) ||
		string.Equals(value, "/recap", StringComparison.OrdinalIgnoreCase) ||
		string.Equals(value, "/server", StringComparison.OrdinalIgnoreCase) ||
		string.Equals(value, "/settings", StringComparison.OrdinalIgnoreCase))
	{
		return true;
	}

	return false;
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
		logSettings.DebugPath = ResolvePreferredDebugPath(logSettings.DebugPath);
		if (!string.IsNullOrWhiteSpace(logSettings.DebugPath))
		{
			Directory.CreateDirectory(logSettings.DebugPath);
			EnsureDirectoryWritable(logSettings.DebugPath);
		}

		Logs.Config(logSettings);
	}
	catch (Exception ex)
	{
		var originalDebugPath = logSettings.DebugPath;
		var fallbackPath = ResolveFallbackDebugPath();
		Directory.CreateDirectory(fallbackPath);
		logSettings.DebugPath = fallbackPath;
		Logs.Config(logSettings);
		Logs.LogError(new InvalidOperationException($"Failed to use LogSettings.DebugPath '{originalDebugPath}'. Fallback '{fallbackPath}' was applied.", ex));
	}
}

static string ResolvePreferredDebugPath(string? configuredPath)
{
	var baseRoot = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
	if (string.IsNullOrWhiteSpace(baseRoot))
	{
		baseRoot = Environment.CurrentDirectory;
	}
	else
	{
		baseRoot = Path.Combine(baseRoot, "Buffaly.CodexEmbedded");
	}

	if (string.IsNullOrWhiteSpace(configuredPath))
	{
		return Path.Combine(baseRoot, "logs", "Buffaly.CodexEmbedded.Web");
	}

	var trimmed = configuredPath.Trim();
	if (Path.IsPathRooted(trimmed))
	{
		return trimmed;
	}

	return Path.Combine(baseRoot, trimmed);
}

static string ResolveFallbackDebugPath()
{
	var baseRoot = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
	if (string.IsNullOrWhiteSpace(baseRoot))
	{
		baseRoot = Environment.CurrentDirectory;
	}
	else
	{
		baseRoot = Path.Combine(baseRoot, "Buffaly.CodexEmbedded");
	}

	return Path.Combine(baseRoot, "logs", "Buffaly.CodexEmbedded.Web");
}

static string ResolveDataProtectionKeyPath()
{
	var baseRoot = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
	if (string.IsNullOrWhiteSpace(baseRoot))
	{
		baseRoot = Environment.CurrentDirectory;
	}
	else
	{
		baseRoot = Path.Combine(baseRoot, "Buffaly.CodexEmbedded");
	}

	return Path.Combine(baseRoot, "secrets", "data-protection-keys");
}

static void EnsureDirectoryWritable(string directoryPath)
{
	var probePath = Path.Combine(directoryPath, ".write-test.tmp");
	File.AppendAllText(probePath, "ok");
	File.Delete(probePath);
}
