using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

var builder = WebApplication.CreateBuilder(args);
ConfigureCodexAppLogs(builder.Configuration);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddDebug();

var defaults = WebRuntimeDefaults.Load(builder.Configuration);
builder.Services.AddSingleton(defaults);

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
		using var socket = await context.WebSockets.AcceptWebSocketAsync();
		Logs.DebugLog.WriteEvent(
			"WebSocket",
			$"Accepted websocket connection id={context.Connection.Id} subProtocol={socket.SubProtocol ?? "(none)"}");
		var session = new MultiSessionWebCliSocketSession(socket, defaults, context.Connection.Id);
		await session.RunAsync(context.RequestAborted);
		Logs.DebugLog.WriteEvent(
			"WebSocket",
			$"Closed websocket connection id={context.Connection.Id} state={socket.State} closeStatus={socket.CloseStatus} closeDescription={socket.CloseStatusDescription}");
	}
	catch (Exception ex)
	{
		Logs.LogError(ex);
		throw;
	}
});

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

internal sealed class WebRuntimeDefaults
{
	public required string CodexPath { get; init; }
	public required string DefaultCwd { get; init; }
	public required int TurnTimeoutSeconds { get; init; }
	public required string LogRootPath { get; init; }
	public string? CodexHomePath { get; init; }
	public string? DefaultModel { get; init; }
	public required bool WebSocketAuthRequired { get; init; }
	public string? WebSocketAuthToken { get; init; }
	public required bool PublicExposureEnabled { get; init; }
	public required bool NonLocalBindConfigured { get; init; }
	public required bool UnsafeConfigurationDetected { get; init; }
	public required string[] UnsafeConfigurationReasons { get; init; }

	// Loads runtime defaults from appsettings and user-level codex config.
	public static WebRuntimeDefaults Load(IConfiguration configuration)
	{
		var defaultModel = LoadModelFromCodexConfig();
		var codexPath = configuration["CodexPath"];
		var defaultCwd = configuration["DefaultCwd"];
		var codexHomePath = configuration["CodexHomePath"];
		var timeout = configuration.GetValue<int?>("TurnTimeoutSeconds") ?? 300;
		var logRoot = configuration["LogRootPath"];
		var webSocketAuthRequired = configuration.GetValue<bool?>("WebSocketAuthRequired") ?? true;
		var webSocketAuthToken = ResolveWebSocketAuthToken(configuration["WebSocketAuthToken"], webSocketAuthRequired);
		var publicExposureEnabled = configuration.GetValue<bool?>("PublicExposureEnabled") ?? false;
		var configuredUrls = LoadConfiguredUrls(configuration);
		var nonLocalBindConfigured = configuredUrls.Any(IsUnsafeBindHost);
		var unsafeReasons = BuildUnsafeReasons(nonLocalBindConfigured, !webSocketAuthRequired, publicExposureEnabled);

		return new WebRuntimeDefaults
		{
			CodexPath = string.IsNullOrWhiteSpace(codexPath) ? "codex" : codexPath,
			DefaultCwd = string.IsNullOrWhiteSpace(defaultCwd) ? Environment.CurrentDirectory : defaultCwd,
			TurnTimeoutSeconds = timeout > 0 ? timeout : 300,
			LogRootPath = string.IsNullOrWhiteSpace(logRoot) ? Path.Combine(Environment.CurrentDirectory, "logs", "web") : ResolvePath(logRoot),
			CodexHomePath = string.IsNullOrWhiteSpace(codexHomePath) ? null : ResolvePath(codexHomePath),
			DefaultModel = defaultModel,
			WebSocketAuthRequired = webSocketAuthRequired,
			WebSocketAuthToken = webSocketAuthToken,
			PublicExposureEnabled = publicExposureEnabled,
			NonLocalBindConfigured = nonLocalBindConfigured,
			UnsafeConfigurationDetected = unsafeReasons.Length > 0,
			UnsafeConfigurationReasons = unsafeReasons
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

		var bytes = RandomNumberGenerator.GetBytes(32);
		return Convert.ToBase64String(bytes)
			.TrimEnd('=')
			.Replace('+', '-')
			.Replace('/', '_');
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

internal static class WebSocketAuthGuard
{
	private const string CookieName = "buffaly_ws_auth";
	private const string HeaderName = "X-Buffaly-Ws-Token";
	private const string QueryParameterName = "wsToken";

	public static void SetAuthCookie(HttpResponse response, string token, bool requestIsHttps)
	{
		response.Cookies.Append(
			CookieName,
			token,
			new CookieOptions
			{
				HttpOnly = true,
				Secure = requestIsHttps,
				SameSite = SameSiteMode.Strict,
				Path = "/"
			});
	}

	public static bool IsAuthorized(HttpRequest request, string expectedToken)
	{
		if (TryReadPresentedToken(request, out var presentedToken))
		{
			return TokensMatch(expectedToken, presentedToken);
		}

		return false;
	}

	private static bool TryReadPresentedToken(HttpRequest request, out string token)
	{
		token = string.Empty;

		if (request.Cookies.TryGetValue(CookieName, out var cookieToken) &&
			!string.IsNullOrWhiteSpace(cookieToken))
		{
			token = cookieToken.Trim();
			return true;
		}

		if (request.Headers.TryGetValue(HeaderName, out var headerValue) &&
			!string.IsNullOrWhiteSpace(headerValue))
		{
			token = headerValue.ToString().Trim();
			return true;
		}

		if (request.Query.TryGetValue(QueryParameterName, out var queryValue) &&
			!string.IsNullOrWhiteSpace(queryValue))
		{
			token = queryValue.ToString().Trim();
			return true;
		}

		return false;
	}

	private static bool TokensMatch(string expected, string actual)
	{
		var expectedBytes = Encoding.UTF8.GetBytes(expected);
		var actualBytes = Encoding.UTF8.GetBytes(actual);
		if (expectedBytes.Length != actualBytes.Length)
		{
			return false;
		}

		return CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
	}
}

internal sealed class WebCliSocketSession : IAsyncDisposable
{
	private readonly WebSocket _socket;
	private readonly WebRuntimeDefaults _defaults;
	private readonly LocalLogWriter _logWriter;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);
	private readonly SemaphoreSlim _socketSendLock = new(1, 1);
	private readonly SemaphoreSlim _processInputLock = new(1, 1);
	private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pendingRpc = new(StringComparer.Ordinal);
	private readonly SemaphoreSlim _turnLock = new(1, 1);
	private readonly object _approvalSync = new();

	private Process? _process;
	private Task? _stdoutPumpTask;
	private Task? _stderrPumpTask;
	private CancellationTokenSource? _sessionCts;
	private TaskCompletionSource<string>? _approvalResponse;
	private TaskCompletionSource<TurnResult>? _turnCompletion;
	private long _nextRequestId;
	private string? _threadId;
	private bool _assistantTextInProgress;

	public WebCliSocketSession(WebSocket socket, WebRuntimeDefaults defaults, string connectionId)
	{
		_socket = socket;
		_defaults = defaults;

		var logPath = Path.Combine(_defaults.LogRootPath, $"session-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Sanitize(connectionId)}.log");
		_logWriter = new LocalLogWriter(logPath);
	}

	// Drives websocket receive loop and manages the app-server session lifecycle.
	public async Task RunAsync(CancellationToken requestAborted)
	{
		await SendEventAsync("status", new { message = "Connected. Click Start Session to begin." }, requestAborted);

		try
		{
			while (_socket.State == WebSocketState.Open && !requestAborted.IsCancellationRequested)
			{
				var text = await ReceiveTextMessageAsync(requestAborted);
				if (text is null)
				{
					break;
				}

				await HandleClientMessageAsync(text, requestAborted);
			}
		}
		catch (OperationCanceledException)
		{
			Logs.DebugLog.WriteEvent("WebCliSocketSession", "Websocket receive loop canceled.");
		}
		catch (WebSocketException ex)
		{
			Logs.LogError(ex);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
		}
		finally
		{
			await StopSessionAsync(CancellationToken.None);
			await DisposeAsync();
		}
	}

	// Parses and routes client websocket commands.
	private async Task HandleClientMessageAsync(string message, CancellationToken cancellationToken)
	{
		await WriteLogAsync($"[client] raw {Truncate(message, 500)}", cancellationToken);

		JsonDocument document;
		try
		{
			document = JsonDocument.Parse(message);
		}
		catch (Exception ex)
		{
			await SendEventAsync("error", new { message = $"Invalid JSON: {ex.Message}" }, cancellationToken);
			await WriteLogAsync($"[client] invalid json: {ex.Message}", cancellationToken);
			return;
		}

		using (document)
		{
			var root = document.RootElement;
			var type = TryGetPathString(root, "type");
			if (string.IsNullOrWhiteSpace(type))
			{
				await SendEventAsync("error", new { message = "Message must include 'type'." }, cancellationToken);
				await WriteLogAsync("[client] rejected frame without type", cancellationToken);
				return;
			}
			await WriteLogAsync($"[client] type={type}", cancellationToken);

			try
			{
				switch (type)
				{
					case "start_session":
						await StartSessionAsync(root, cancellationToken);
						return;
					case "prompt":
						await StartTurnAsync(root, cancellationToken);
						return;
					case "approval_response":
						HandleApprovalResponse(root);
						return;
					case "stop_session":
						await StopSessionAsync(cancellationToken);
						return;
					case "ping":
						await SendEventAsync("pong", new { utc = DateTimeOffset.UtcNow.ToString("O") }, cancellationToken);
						return;
					default:
						await SendEventAsync("error", new { message = $"Unknown message type: {type}" }, cancellationToken);
						return;
				}
			}
			catch (Exception ex)
			{
				Logs.LogError(ex);
				await SendEventAsync("error", new { message = ex.Message }, CancellationToken.None);
			}
		}
	}

	// Starts codex app-server, initializes it, and opens a thread for this websocket session.
	private async Task StartSessionAsync(JsonElement request, CancellationToken cancellationToken)
	{
		if (_process is not null && !_process.HasExited)
		{
			await SendEventAsync("status", new { message = "Session already started." }, cancellationToken);
			return;
		}

		var model = TryGetPathString(request, "model") ?? _defaults.DefaultModel;
		var cwd = TryGetPathString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetPathString(request, "codexPath") ?? _defaults.CodexPath;

		var psi = new ProcessStartInfo
		{
			FileName = codexPath,
			Arguments = "app-server",
			WorkingDirectory = cwd,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
			StandardOutputEncoding = Encoding.UTF8,
			StandardErrorEncoding = Encoding.UTF8,
			UseShellExecute = false,
			CreateNoWindow = true
		};

		var process = new Process
		{
			StartInfo = psi,
			EnableRaisingEvents = true
		};
		process.Exited += (_, _) =>
		{
			try
			{
				var exitCode = process.ExitCode;
				var message = $"[session] process exited pid={process.Id} exitCode={exitCode} at={DateTimeOffset.Now:O}";
				_logWriter.Write(message);
				Logs.DebugLog.WriteEvent("WebCliSocketSession", message);
			}
			catch (Exception ex)
			{
				Logs.LogError(ex);
			}
		};
		if (!process.Start())
		{
			await SendEventAsync("error", new { message = "Failed to start codex app-server." }, cancellationToken);
			return;
		}

		_process = process;
		_sessionCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		_stdoutPumpTask = PumpStdoutAsync(_sessionCts.Token);
		_stderrPumpTask = PumpStderrAsync(_sessionCts.Token);

		await WriteLogAsync($"[session] started process pid={process.Id}", cancellationToken);
		await WriteLogAsync($"[session] codexPath={codexPath}", cancellationToken);

		using var startupTimeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		startupTimeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(_defaults.TurnTimeoutSeconds, 30, 300)));
		var startupToken = startupTimeoutCts.Token;
		var startupStopwatch = Stopwatch.StartNew();

		try
		{
			await WriteLogAsync("[startup] sending initialize", cancellationToken);
			await SendRpcAsync("initialize", new
			{
				clientInfo = new
				{
					name = "codex_web_cli",
					title = "Codex Web CLI",
					version = "0.1.0"
				}
			}, startupToken);
			await WriteLogAsync($"[startup] initialize response after {startupStopwatch.ElapsedMilliseconds}ms", cancellationToken);
		}
		catch (OperationCanceledException)
		{
			throw new InvalidOperationException($"Timed out waiting for codex app-server initialize response after {startupStopwatch.ElapsedMilliseconds}ms.");
		}

		var threadStartParams = new Dictionary<string, object?>
		{
			["cwd"] = cwd
		};

		if (!string.IsNullOrWhiteSpace(model))
		{
			threadStartParams["model"] = model;
		}

		JsonElement threadStartResult;
		try
		{
			await WriteLogAsync("[startup] sending thread/start", cancellationToken);
			threadStartResult = await SendRpcAsync("thread/start", threadStartParams, startupToken);
			await WriteLogAsync($"[startup] thread/start response after {startupStopwatch.ElapsedMilliseconds}ms", cancellationToken);
		}
		catch (OperationCanceledException)
		{
			throw new InvalidOperationException($"Timed out waiting for thread/start response from codex after {startupStopwatch.ElapsedMilliseconds}ms.");
		}
		_threadId = GetRequiredPathString(threadStartResult, "thread", "id");

		await WriteLogAsync($"[thread] started {_threadId}", cancellationToken);
		await SendEventAsync("session_started", new
		{
			threadId = _threadId,
			model,
			cwd,
			logPath = _logWriter.LogPath
		}, cancellationToken);
	}

	// Starts one turn on the active thread and streams output back to the browser.
	private async Task StartTurnAsync(JsonElement request, CancellationToken cancellationToken)
	{
		if (_process is null || _process.HasExited || string.IsNullOrWhiteSpace(_threadId))
		{
			await SendEventAsync("error", new { message = "Start a session before sending prompts." }, cancellationToken);
			return;
		}

		var prompt = TryGetPathString(request, "text");
		if (string.IsNullOrWhiteSpace(prompt))
		{
			await SendEventAsync("error", new { message = "Prompt text is required." }, cancellationToken);
			return;
		}

		if (!await _turnLock.WaitAsync(0, cancellationToken))
		{
			await SendEventAsync("error", new { message = "A turn is already in progress." }, cancellationToken);
			return;
		}

		_ = Task.Run(async () =>
		{
			try
			{
				await RunTurnAsync(prompt, cancellationToken);
			}
			catch (Exception ex)
			{
				await SendEventAsync("error", new { message = $"Turn failed: {ex.Message}" }, CancellationToken.None);
				await WriteLogAsync($"[turn] failed: {ex}", CancellationToken.None);
			}
			finally
			{
				_turnLock.Release();
			}
		}, CancellationToken.None);
	}

	// Executes turn/start and waits for turn/completed notification.
	private async Task RunTurnAsync(string prompt, CancellationToken cancellationToken)
	{
		_assistantTextInProgress = false;
		_turnCompletion = new TaskCompletionSource<TurnResult>(TaskCreationOptions.RunContinuationsAsynchronously);

		await SendEventAsync("status", new { message = "Turn started." }, cancellationToken);
		await WriteLogAsync($"[prompt] {prompt}", cancellationToken);

		var turnStartResult = await SendRpcAsync("turn/start", new
		{
			threadId = _threadId,
			input = new object[]
			{
				new
				{
					type = "text",
					text = prompt
				}
			}
		}, cancellationToken);

		var turnId = GetRequiredPathString(turnStartResult, "turn", "id");
		await WriteLogAsync($"[turn] started {turnId}", cancellationToken);

		using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeoutCts.CancelAfter(TimeSpan.FromSeconds(_defaults.TurnTimeoutSeconds));
		var turnResult = await _turnCompletion.Task.WaitAsync(timeoutCts.Token);

		if (_assistantTextInProgress)
		{
			await SendEventAsync("assistant_done", new { }, cancellationToken);
			_assistantTextInProgress = false;
		}

		await SendEventAsync("turn_complete", new
		{
			status = turnResult.Status,
			errorMessage = turnResult.ErrorMessage
		}, cancellationToken);
	}

	// Stops the codex process and clears active session state.
	private async Task StopSessionAsync(CancellationToken cancellationToken)
	{
		_approvalResponse?.TrySetResult("cancel");
		_turnCompletion?.TrySetResult(new TurnResult("interrupted", "Session stopped"));

		var sessionCts = _sessionCts;
		if (sessionCts is not null)
		{
			sessionCts.Cancel();
			sessionCts.Dispose();
			_sessionCts = null;
		}

		var process = _process;
		if (process is not null)
		{
			try
			{
				if (!process.HasExited)
				{
					try
					{
						process.StandardInput.Close();
					}
					catch
					{
					}

					var waitForExitTask = process.WaitForExitAsync(cancellationToken);
					var exited = await Task.WhenAny(waitForExitTask, Task.Delay(1500, cancellationToken));
					if (exited != waitForExitTask && !process.HasExited)
					{
						process.Kill(entireProcessTree: true);
						await process.WaitForExitAsync(cancellationToken);
					}
				}
			}
			catch
			{
			}
			finally
			{
				process.Dispose();
				_process = null;
			}
		}

		if (_stdoutPumpTask is not null)
		{
			try
			{
				await _stdoutPumpTask;
			}
			catch
			{
			}
			_stdoutPumpTask = null;
		}

		if (_stderrPumpTask is not null)
		{
			try
			{
				await _stderrPumpTask;
			}
			catch
			{
			}
			_stderrPumpTask = null;
		}

		_threadId = null;
		await SendEventAsync("session_stopped", new { message = "Session stopped." }, cancellationToken);
	}

	// Reads codex stdout JSONL and routes responses, notifications, and server requests.
	private async Task PumpStdoutAsync(CancellationToken cancellationToken)
	{
		_logWriter.Write("[pump] stdout started");
		try
		{
			while (!cancellationToken.IsCancellationRequested && _process is not null && !_process.HasExited)
			{
				var line = await _process.StandardOutput.ReadLineAsync();
				if (line is null)
				{
					break;
				}

				await WriteLogAsync($"[jsonl] {line}", cancellationToken);

				JsonDocument document;
				try
				{
					document = JsonDocument.Parse(line);
				}
				catch (Exception ex)
				{
					await WriteLogAsync($"[warn] invalid json frame: {ex.Message}", cancellationToken);
					continue;
				}

				using (document)
				{
					var root = document.RootElement;
					var hasMethod = root.TryGetProperty("method", out var methodElement) && methodElement.ValueKind == JsonValueKind.String;
					var hasId = TryGetRequestId(root, out var idElement, out var idKey);

					if (hasMethod && hasId)
					{
						await HandleServerRequestAsync(methodElement.GetString()!, idElement, root, cancellationToken);
						continue;
					}

					if (hasId)
					{
						HandleRpcResponse(root, idKey!);
						continue;
					}

					if (hasMethod)
					{
						await HandleNotificationAsync(methodElement.GetString()!, root, cancellationToken);
						continue;
					}

					await WriteLogAsync("[warn] unrecognized frame shape", cancellationToken);
				}
			}
		}
		catch (OperationCanceledException)
		{
		}
		catch (Exception ex)
		{
			await SendEventAsync("error", new { message = $"Stdout pump error: {ex.Message}" }, CancellationToken.None);
			await WriteLogAsync($"[error] stdout pump: {ex}", CancellationToken.None);
		}
		finally
		{
			_logWriter.Write("[pump] stdout ended");
			foreach (var pending in _pendingRpc.Values)
			{
				pending.TrySetException(new InvalidOperationException("Session ended before RPC response."));
			}
		}
	}

	// Reads codex stderr and forwards lines to log panel and file.
	private async Task PumpStderrAsync(CancellationToken cancellationToken)
	{
		_logWriter.Write("[pump] stderr started");
		try
		{
			while (!cancellationToken.IsCancellationRequested && _process is not null && !_process.HasExited)
			{
				var line = await _process.StandardError.ReadLineAsync();
				if (line is null)
				{
					break;
				}

				await WriteLogAsync($"[codex stderr] {line}", cancellationToken);
			}
		}
		catch (OperationCanceledException)
		{
		}
		catch (Exception ex)
		{
			await WriteLogAsync($"[error] stderr pump: {ex}", CancellationToken.None);
		}
		finally
		{
			_logWriter.Write("[pump] stderr ended");
		}
	}

	// Handles server-initiated request messages such as approval prompts.
	private async Task HandleServerRequestAsync(string method, JsonElement idElement, JsonElement root, CancellationToken cancellationToken)
	{
		var paramsElement = root.TryGetProperty("params", out var paramsValue) ? paramsValue : default;

		switch (method)
		{
			case "item/commandExecution/requestApproval":
			{
				var decision = await RequestApprovalDecisionAsync("command", paramsElement, cancellationToken);
				await SendRpcResultAsync(idElement, new { decision }, cancellationToken);
				return;
			}
			case "item/fileChange/requestApproval":
			{
				var decision = await RequestApprovalDecisionAsync("fileChange", paramsElement, cancellationToken);
				await SendRpcResultAsync(idElement, new { decision }, cancellationToken);
				return;
			}
			case "item/tool/requestUserInput":
			{
				await SendRpcResultAsync(idElement, new { answers = new Dictionary<string, object?>() }, cancellationToken);
				return;
			}
			case "item/tool/call":
			{
				await SendRpcResultAsync(idElement, new
				{
					success = false,
					contentItems = new object[]
					{
						new
						{
							type = "inputText",
							text = "Dynamic tool call is not implemented by this web harness."
						}
					}
				}, cancellationToken);
				return;
			}
			case "account/chatgptAuthTokens/refresh":
			{
				var accessToken = Environment.GetEnvironmentVariable("CODEX_CHATGPT_ACCESS_TOKEN");
				var accountId = Environment.GetEnvironmentVariable("CODEX_CHATGPT_ACCOUNT_ID");
				if (string.IsNullOrWhiteSpace(accessToken) || string.IsNullOrWhiteSpace(accountId))
				{
					await SendRpcErrorAsync(idElement, -32001, "Missing CODEX_CHATGPT_ACCESS_TOKEN/CODEX_CHATGPT_ACCOUNT_ID.", cancellationToken);
					return;
				}

				await SendRpcResultAsync(idElement, new
				{
					accessToken,
					chatgptAccountId = accountId,
					chatgptPlanType = (string?)null
				}, cancellationToken);
				return;
			}
			default:
			{
				await SendRpcErrorAsync(idElement, -32601, $"Unsupported server request method: {method}", cancellationToken);
				return;
			}
		}
	}

	// Handles server notifications and forwards user/log events to the browser.
	private async Task HandleNotificationAsync(string method, JsonElement root, CancellationToken cancellationToken)
	{
		var paramsElement = root.TryGetProperty("params", out var paramsValue) ? paramsValue : default;

		switch (method)
		{
			case "item/agentMessage/delta":
			{
				var delta = TryGetPathString(paramsElement, "delta");
				if (!string.IsNullOrWhiteSpace(delta))
				{
					_assistantTextInProgress = true;
					await SendEventAsync("assistant_delta", new { text = delta }, cancellationToken);
				}
				return;
			}
			case "turn/completed":
			{
				var status = TryGetPathString(paramsElement, "turn", "status") ?? "unknown";
				var errorMessage = TryGetPathString(paramsElement, "turn", "error", "message");

				await WriteLogAsync($"[turn] completed ({status})", cancellationToken);
				_turnCompletion?.TrySetResult(new TurnResult(status, errorMessage));
				return;
			}
			case "error":
			{
				var message = TryGetPathString(paramsElement, "error", "message")
					?? TryGetPathString(paramsElement, "message")
					?? "Unknown server error";

				await SendEventAsync("error", new { message }, cancellationToken);
				await WriteLogAsync($"[error] {message}", cancellationToken);
				return;
			}
			case "item/started":
			case "item/completed":
			{
				var itemType = TryGetPathString(paramsElement, "item", "type") ?? "unknown";
				var itemId = TryGetPathString(paramsElement, "item", "id") ?? "unknown";
				await WriteLogAsync($"[{method}] {itemType} ({itemId})", cancellationToken);
				return;
			}
			case "thread/started":
			{
				var id = TryGetPathString(paramsElement, "thread", "id") ?? "unknown";
				await WriteLogAsync($"[thread/started] {id}", cancellationToken);
				return;
			}
			case "turn/started":
			{
				var id = TryGetPathString(paramsElement, "turn", "id") ?? "unknown";
				await WriteLogAsync($"[turn/started] {id}", cancellationToken);
				return;
			}
			default:
			{
				await WriteLogAsync($"[notification] {method}", cancellationToken);
				return;
			}
		}
	}

	// Requests approval input from the connected web client and waits for decision.
	private async Task<string> RequestApprovalDecisionAsync(string requestType, JsonElement paramsElement, CancellationToken cancellationToken)
	{
		var reason = TryGetPathString(paramsElement, "reason");
		var cwd = TryGetPathString(paramsElement, "cwd");
		var actions = GetCommandActionSummaries(paramsElement);
		var summary = requestType == "command"
			? "Command execution requested."
			: "File change requested.";

		var approvalTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
		lock (_approvalSync)
		{
			_approvalResponse = approvalTcs;
		}

		await SendEventAsync("approval_request", new
		{
			requestType,
			summary,
			reason,
			cwd,
			actions,
			options = new[] { "accept", "acceptForSession", "decline", "cancel" }
		}, cancellationToken);

		await WriteLogAsync($"[approval:{requestType}] requested", cancellationToken);

		try
		{
			var decision = await approvalTcs.Task.WaitAsync(cancellationToken);
			await WriteLogAsync($"[approval:{requestType}] {decision}", cancellationToken);
			return decision;
		}
		catch (OperationCanceledException)
		{
			return "cancel";
		}
		finally
		{
			lock (_approvalSync)
			{
				if (ReferenceEquals(_approvalResponse, approvalTcs))
				{
					_approvalResponse = null;
				}
			}
		}
	}

	// Applies a client-sent approval decision to the pending approval request.
	private void HandleApprovalResponse(JsonElement request)
	{
		var decision = TryGetPathString(request, "decision");
		if (string.IsNullOrWhiteSpace(decision))
		{
			return;
		}

		lock (_approvalSync)
		{
			_approvalResponse?.TrySetResult(decision);
		}
	}

	// Sends one JSON-RPC request to codex and awaits the correlated response.
	private async Task<JsonElement> SendRpcAsync(string method, object? parameters, CancellationToken cancellationToken)
	{
		var id = Interlocked.Increment(ref _nextRequestId);
		var idKey = id.ToString(CultureInfo.InvariantCulture);
		var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
		_pendingRpc[idKey] = tcs;
		_logWriter.Write($"[rpc->codex] id={idKey} method={method}");

		var request = new Dictionary<string, object?>
		{
			["id"] = id,
			["method"] = method,
			["params"] = parameters
		};

		await WriteJsonLineToProcessAsync(request, cancellationToken);
		return await tcs.Task.WaitAsync(cancellationToken);
	}

	// Sends a server-request response result to codex.
	private async Task SendRpcResultAsync(JsonElement idElement, object result, CancellationToken cancellationToken)
	{
		await WriteJsonLineToProcessAsync(new
		{
			id = ConvertRequestIdForWrite(idElement),
			result
		}, cancellationToken);
	}

	// Sends a server-request response error to codex.
	private async Task SendRpcErrorAsync(JsonElement idElement, long code, string message, CancellationToken cancellationToken)
	{
		await WriteJsonLineToProcessAsync(new
		{
			id = ConvertRequestIdForWrite(idElement),
			error = new
			{
				code,
				message
			}
		}, cancellationToken);
	}

	// Writes a single JSON line into codex process stdin.
	private async Task WriteJsonLineToProcessAsync(object payload, CancellationToken cancellationToken)
	{
		if (_process is null || _process.HasExited)
		{
			throw new InvalidOperationException("Codex process is not running.");
		}

		var json = JsonSerializer.Serialize(payload, _jsonOptions);
		await _processInputLock.WaitAsync(cancellationToken);
		try
		{
			await _process.StandardInput.WriteLineAsync(json);
			await _process.StandardInput.FlushAsync();
		}
		finally
		{
			_processInputLock.Release();
		}
	}

	// Routes successful/error RPC responses back to waiting request tasks.
	private void HandleRpcResponse(JsonElement root, string idKey)
	{
		if (!_pendingRpc.TryRemove(idKey, out var tcs))
		{
			_logWriter.Write($"[rpc<-codex] untracked id={idKey}");
			return;
		}

		if (root.TryGetProperty("result", out var result))
		{
			_logWriter.Write($"[rpc<-codex] id={idKey} result");
			tcs.TrySetResult(result.Clone());
			return;
		}

		if (root.TryGetProperty("error", out var error))
		{
			var message = TryGetPathString(error, "message") ?? error.ToString();
			_logWriter.Write($"[rpc<-codex] id={idKey} error={message}");
			tcs.TrySetException(new InvalidOperationException(message));
			return;
		}

		_logWriter.Write($"[rpc<-codex] id={idKey} invalid-response");
		tcs.TrySetException(new InvalidOperationException("Missing result/error in RPC response."));
	}

	// Sends one JSON event frame to browser websocket.
	private async Task SendEventAsync(string type, object payload, CancellationToken cancellationToken)
	{
		if (_socket.State != WebSocketState.Open)
		{
			return;
		}

		var envelope = JsonSerializer.SerializeToElement(new
		{
			type,
			payload
		}, _jsonOptions);

		var bytes = Encoding.UTF8.GetBytes(envelope.GetRawText());
		await _socketSendLock.WaitAsync(cancellationToken);
		try
		{
			await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
		}
		catch (Exception ex)
		{
			_logWriter.Write($"[send-error] type={type} message={ex.Message}");
			Logs.DebugLog.WriteEvent("WebCliSocketSession", $"Failed sending event '{type}': {ex.Message}");
		}
		finally
		{
			_socketSendLock.Release();
		}
	}

	// Logs to file and pushes log lines to browser log panel.
	private async Task WriteLogAsync(string message, CancellationToken cancellationToken)
	{
		_logWriter.Write(message);
		Logs.DebugLog.WriteEvent("WebCliSocketSession", message);
		await SendEventAsync("log", new { message }, cancellationToken);
	}

	// Receives one full text message from browser websocket.
	private async Task<string?> ReceiveTextMessageAsync(CancellationToken cancellationToken)
	{
		var rented = ArrayPool<byte>.Shared.Rent(8192);
		try
		{
			using var ms = new MemoryStream();
			while (true)
			{
				var segment = new ArraySegment<byte>(rented);
				var result = await _socket.ReceiveAsync(segment, cancellationToken);
				if (result.MessageType == WebSocketMessageType.Close)
				{
					_logWriter.Write($"[ws-close] status={_socket.CloseStatus} description={_socket.CloseStatusDescription}");
					Logs.DebugLog.WriteEvent("WebCliSocketSession", $"Socket close frame received status={_socket.CloseStatus} description={_socket.CloseStatusDescription}");
					return null;
				}

				if (result.MessageType != WebSocketMessageType.Text)
				{
					_logWriter.Write($"[ws-nontext] type={result.MessageType} count={result.Count}");
					continue;
				}

				ms.Write(segment.Array!, segment.Offset, result.Count);
				if (result.EndOfMessage)
				{
					break;
				}
			}

			return Encoding.UTF8.GetString(ms.ToArray());
		}
		finally
		{
			ArrayPool<byte>.Shared.Return(rented);
		}
	}

	public async ValueTask DisposeAsync()
	{
		_processInputLock.Dispose();
		_socketSendLock.Dispose();
		_turnLock.Dispose();
		_logWriter.Dispose();

		if (_socket.State == WebSocketState.Open)
		{
			try
			{
				await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
			}
			catch
			{
			}
		}
	}

	private static object ConvertRequestIdForWrite(JsonElement idElement)
	{
		return idElement.ValueKind switch
		{
			JsonValueKind.String => idElement.GetString() ?? string.Empty,
			JsonValueKind.Number when idElement.TryGetInt64(out var longValue) => longValue,
			JsonValueKind.Number when idElement.TryGetDecimal(out var decimalValue) => decimalValue,
			_ => idElement.ToString()
		};
	}

	private static bool TryGetRequestId(JsonElement root, out JsonElement idElement, out string? idKey)
	{
		idElement = default;
		idKey = null;

		if (!root.TryGetProperty("id", out idElement))
		{
			return false;
		}

		idKey = idElement.ValueKind switch
		{
			JsonValueKind.String => idElement.GetString(),
			JsonValueKind.Number => idElement.ToString(),
			_ => null
		};

		return !string.IsNullOrWhiteSpace(idKey);
	}

	private static string GetRequiredPathString(JsonElement root, params string[] path)
	{
		var value = TryGetPathString(root, path);
		if (string.IsNullOrWhiteSpace(value))
		{
			throw new InvalidOperationException($"Missing required path: {string.Join(".", path)}");
		}

		return value;
	}

	private static string? TryGetPathString(JsonElement root, params string[] path)
	{
		var current = root;
		foreach (var segment in path)
		{
			if (current.ValueKind != JsonValueKind.Object)
			{
				return null;
			}

			if (!current.TryGetProperty(segment, out current))
			{
				return null;
			}
		}

		return current.ValueKind switch
		{
			JsonValueKind.String => current.GetString(),
			JsonValueKind.Null => null,
			_ => current.ToString()
		};
	}

	private static string Sanitize(string value)
	{
		var invalid = Path.GetInvalidFileNameChars();
		var sb = new StringBuilder(value.Length);
		foreach (var ch in value)
		{
			sb.Append(invalid.Contains(ch) ? '_' : ch);
		}

		return sb.ToString();
	}

	private static string Truncate(string value, int maxLength)
	{
		if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
		{
			return value;
		}

		return value[..maxLength] + "...";
	}

	private static List<string> GetCommandActionSummaries(JsonElement paramsElement)
	{
		var output = new List<string>();
		if (!paramsElement.TryGetProperty("commandActions", out var actionsElement) || actionsElement.ValueKind != JsonValueKind.Array)
		{
			return output;
		}

		foreach (var action in actionsElement.EnumerateArray())
		{
			var type = TryGetPathString(action, "type") ?? "unknown";
			var path = TryGetPathString(action, "path");
			var name = TryGetPathString(action, "name");
			var query = TryGetPathString(action, "query");

			switch (type)
			{
				case "read":
					output.Add($"read {(name ?? path ?? "(path unknown)")}");
					break;
				case "listFiles":
					output.Add($"listFiles {(path ?? "(path unknown)")}");
					break;
				case "search":
					output.Add($"search {(query ?? "(query unknown)")} in {(path ?? "(path unknown)")}");
					break;
				default:
					output.Add(type);
					break;
			}
		}

		return output;
	}
}

internal sealed record TurnResult(string Status, string? ErrorMessage);

internal sealed class LocalLogWriter : IDisposable
{
	private readonly object _sync = new();
	private readonly StreamWriter _writer;
	public string LogPath { get; }

	public LocalLogWriter(string path)
	{
		LogPath = Path.GetFullPath(path);
		var directory = Path.GetDirectoryName(LogPath);
		if (!string.IsNullOrWhiteSpace(directory))
		{
			Directory.CreateDirectory(directory);
		}

		_writer = new StreamWriter(new FileStream(LogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
		{
			AutoFlush = true
		};
		_writer.WriteLine($"{DateTimeOffset.Now:O} [session] log started");
	}

	// Appends timestamped diagnostic line.
	public void Write(string message)
	{
		lock (_sync)
		{
			_writer.WriteLine($"{DateTimeOffset.Now:O} {message}");
		}
	}

	public void Dispose()
	{
		lock (_sync)
		{
			_writer.Dispose();
		}
	}
}

internal static class QueryValueParser
{
	public static int GetPositiveInt(Microsoft.Extensions.Primitives.StringValues rawValues, int fallback, int max)
	{
		var raw = rawValues.ToString();
		if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) || parsed <= 0)
		{
			return fallback;
		}

		return Math.Min(parsed, max);
	}

	public static bool GetBool(Microsoft.Extensions.Primitives.StringValues rawValues)
	{
		var raw = rawValues.ToString();
		return raw.Equals("1", StringComparison.Ordinal) ||
			raw.Equals("true", StringComparison.OrdinalIgnoreCase) ||
			raw.Equals("yes", StringComparison.OrdinalIgnoreCase);
	}
}

internal sealed record JsonlWatchResult(
	long Cursor,
	long NextCursor,
	long FileLength,
	bool Reset,
	bool Truncated,
	IReadOnlyList<string> Lines);

internal static class JsonlFileTailReader
{
	public static JsonlWatchResult ReadInitial(string path, int maxLines)
	{
		using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
		var fileLength = fs.Length;
		using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096, leaveOpen: true);

		var ring = new Queue<string>(Math.Max(1, maxLines));
		var truncated = false;
		while (true)
		{
			var line = reader.ReadLine();
			if (line is null)
			{
				break;
			}

			ring.Enqueue(line);
			if (ring.Count > maxLines)
			{
				ring.Dequeue();
				truncated = true;
			}
		}

		var lines = ring.ToArray();
		return new JsonlWatchResult(
			Cursor: fileLength,
			NextCursor: fileLength,
			FileLength: fileLength,
			Reset: false,
			Truncated: truncated,
			Lines: lines);
	}

	public static JsonlWatchResult ReadFromCursor(string path, long cursor, int maxLines)
	{
		using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
		var fileLength = fs.Length;
		var startCursor = cursor;
		var reset = false;
		if (startCursor > fileLength)
		{
			startCursor = 0;
			reset = true;
		}

		fs.Seek(startCursor, SeekOrigin.Begin);
		using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096, leaveOpen: true);

		var lines = new List<string>();
		while (true)
		{
			var line = reader.ReadLine();
			if (line is null)
			{
				break;
			}

			lines.Add(line);
		}

		var truncated = false;
		if (lines.Count > maxLines)
		{
			lines = lines.Skip(lines.Count - maxLines).ToList();
			truncated = true;
		}

		var nextCursor = fs.Position;
		return new JsonlWatchResult(
			Cursor: startCursor,
			NextCursor: nextCursor,
			FileLength: fileLength,
			Reset: reset,
			Truncated: truncated,
			Lines: lines);
	}
}

internal static class RuntimeSessionLogFinder
{
	public static string? ResolveLogPath(string logRootPath, string? requestedLogFileName)
	{
		if (!Directory.Exists(logRootPath))
		{
			return null;
		}

		if (!string.IsNullOrWhiteSpace(requestedLogFileName))
		{
			var fileName = Path.GetFileName(requestedLogFileName);
			if (string.IsNullOrWhiteSpace(fileName))
			{
				return null;
			}

			var exact = Path.Combine(logRootPath, fileName);
			if (File.Exists(exact) && IsAllowedRuntimeLog(fileName))
			{
				return exact;
			}
		}

		var candidates = Directory.EnumerateFiles(logRootPath, "session-*.log", SearchOption.TopDirectoryOnly)
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
			.ToList();

		return candidates.Count == 0 ? null : candidates[0].FullName;
	}

	private static bool IsAllowedRuntimeLog(string fileName)
	{
		return fileName.StartsWith("session-", StringComparison.OrdinalIgnoreCase) &&
			fileName.EndsWith(".log", StringComparison.OrdinalIgnoreCase);
	}
}
