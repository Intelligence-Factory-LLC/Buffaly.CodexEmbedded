using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using BasicUtilities;

internal sealed class MultiSessionWebCliSocketSession : IAsyncDisposable
{
	private readonly WebSocket _socket;
	private readonly WebRuntimeDefaults _defaults;
	private readonly string _connectionId;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);
	private readonly SemaphoreSlim _socketSendLock = new(1, 1);
	private readonly object _sessionsLock = new();
	private readonly Dictionary<string, ManagedSession> _sessions = new(StringComparer.Ordinal);
	private string? _activeSessionId;
	private volatile CodexEventVerbosity _uiLogVerbosity = CodexEventVerbosity.Normal;

	private readonly LocalLogWriter _connectionLog;

	public MultiSessionWebCliSocketSession(WebSocket socket, WebRuntimeDefaults defaults, string connectionId)
	{
		_socket = socket;
		_defaults = defaults;
		_connectionId = connectionId;

		var logPath = Path.Combine(_defaults.LogRootPath, $"ws-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Sanitize(connectionId)}.log");
		_connectionLog = new LocalLogWriter(logPath);
	}

	public async Task RunAsync(CancellationToken cancellationToken)
	{
		await SendEventAsync("status", new { message = "Connected." }, cancellationToken);
		await SendEventAsync("log_verbosity", new { verbosity = _uiLogVerbosity.ToString().ToLowerInvariant() }, cancellationToken);
		await WriteConnectionLogAsync("[ws] connected", cancellationToken);

		while (!cancellationToken.IsCancellationRequested && _socket.State == WebSocketState.Open)
		{
			var message = await ReceiveTextMessageAsync(cancellationToken);
			if (message is null)
			{
				break;
			}

			await HandleClientMessageAsync(message, cancellationToken);
		}
	}

	private async Task HandleClientMessageAsync(string message, CancellationToken cancellationToken)
	{
		await WriteConnectionLogAsync($"[client] raw {Truncate(message, 800)}", cancellationToken);

		JsonDocument document;
		try
		{
			document = JsonDocument.Parse(message);
		}
		catch (Exception ex)
		{
			await SendEventAsync("error", new { message = $"Invalid JSON: {ex.Message}" }, cancellationToken);
			return;
		}

		using (document)
		{
			var root = document.RootElement;
			var type = TryGetString(root, "type");
			if (string.IsNullOrWhiteSpace(type))
			{
				await SendEventAsync("error", new { message = "Message must include 'type'." }, cancellationToken);
				return;
			}

			switch (type)
			{
				// Back-compat aliases.
				case "start_session":
					await CreateSessionAsync(root, setActive: true, cancellationToken);
					return;
				case "stop_session":
					await StopSessionAsync(GetSessionIdOrActive(root), cancellationToken);
					return;
				case "prompt":
					await StartTurnAsync(GetSessionIdOrActive(root), TryGetString(root, "text"), cancellationToken);
					return;

				// Multi-session protocol.
				case "session_create":
					await CreateSessionAsync(root, setActive: true, cancellationToken);
					return;
				case "session_list":
					await SendSessionListAsync(cancellationToken);
					return;
				case "session_catalog_list":
					await SendSessionCatalogAsync(cancellationToken);
					return;
				case "session_attach":
					await AttachSessionAsync(root, setActive: true, cancellationToken);
					return;
				case "session_select":
					SetActiveSession(TryGetString(root, "sessionId"));
					await SendEventAsync("status", new { message = $"Active session set to {_activeSessionId ?? "(none)"}" }, cancellationToken);
					return;
				case "session_stop":
					await StopSessionAsync(TryGetString(root, "sessionId"), cancellationToken);
					return;
				case "turn_start":
					await StartTurnAsync(TryGetString(root, "sessionId"), TryGetString(root, "text"), cancellationToken);
					return;
				case "approval_response":
					HandleApprovalResponse(root);
					return;
				case "models_list":
					await SendModelsListAsync(TryGetString(root, "sessionId"), cancellationToken);
					return;
				case "log_verbosity_set":
					await SetLogVerbosityAsync(root, cancellationToken);
					return;
				case "ping":
					await SendEventAsync("pong", new { utc = DateTimeOffset.UtcNow.ToString("O") }, cancellationToken);
					return;
				default:
					await SendEventAsync("error", new { message = $"Unknown message type: {type}" }, cancellationToken);
					return;
			}
		}
	}

	private string? GetSessionIdOrActive(JsonElement root)
	{
		var sessionId = TryGetString(root, "sessionId");
		if (!string.IsNullOrWhiteSpace(sessionId))
		{
			return sessionId;
		}
		return _activeSessionId;
	}

	private void SetActiveSession(string? sessionId)
	{
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			return;
		}

		lock (_sessionsLock)
		{
			if (_sessions.ContainsKey(sessionId))
			{
				_activeSessionId = sessionId;
			}
		}
	}

	private async Task CreateSessionAsync(JsonElement request, bool setActive, CancellationToken cancellationToken)
	{
		var model = TryGetString(request, "model") ?? _defaults.DefaultModel;
		var cwd = TryGetString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetString(request, "codexPath") ?? _defaults.CodexPath;

		var sessionId = Guid.NewGuid().ToString("N");
		var sessionLogPath = Path.Combine(_defaults.LogRootPath, $"session-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{sessionId}.log");
		var sessionLog = new LocalLogWriter(sessionLogPath);

		await WriteConnectionLogAsync($"[session] creating id={sessionId} cwd={cwd} model={model ?? "(default)"}", cancellationToken);

		var pendingApproval = new ConcurrentDictionary<string, TaskCompletionSource<string>>(StringComparer.Ordinal);

		CodexClient client;
		CodexSession session;
		try
		{
			var clientOptions = new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = _defaults.CodexHomePath,
				ServerRequestHandler = async (req, ct) =>
				{
					return await HandleServerRequestAsync(sessionId, sessionLog, pendingApproval, req, ct);
				}
			};

			client = await CodexClient.StartAsync(clientOptions, cancellationToken);
			client.OnEvent += ev =>
			{
				HandleCoreEvent(sessionId, sessionLog, ev);
			};

			session = await client.CreateSessionAsync(new CodexSessionCreateOptions
			{
				Cwd = cwd,
				Model = model
			}, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			sessionLog.Dispose();
			await WriteConnectionLogAsync($"[session] failed to start id={sessionId} error={ex.Message}", cancellationToken);
			await SendEventAsync("error", new { message = $"Failed to start session: {ex.Message}" }, cancellationToken);
			return;
		}

		var managed = new ManagedSession(sessionId, client, session, cwd, model, sessionLog, pendingApproval);
		lock (_sessionsLock)
		{
			_sessions[sessionId] = managed;
			if (setActive)
			{
				_activeSessionId = sessionId;
			}
		}

		await SendEventAsync("session_created", new
		{
			sessionId,
			threadId = session.ThreadId,
			model,
			cwd,
			logPath = sessionLogPath
		}, cancellationToken);

		// Back-compat event.
		await SendEventAsync("session_started", new
		{
			threadId = session.ThreadId,
			model,
			cwd,
			logPath = sessionLogPath
		}, cancellationToken);

		await SendSessionListAsync(cancellationToken);
	}

	private async Task AttachSessionAsync(JsonElement request, bool setActive, CancellationToken cancellationToken)
	{
		var threadId = TryGetString(request, "threadId") ?? TryGetString(request, "id");
		if (string.IsNullOrWhiteSpace(threadId))
		{
			await SendEventAsync("error", new { message = "threadId is required to attach." }, cancellationToken);
			return;
		}

		var model = TryGetString(request, "model") ?? _defaults.DefaultModel;
		var cwd = TryGetString(request, "cwd") ?? _defaults.DefaultCwd;
		var codexPath = TryGetString(request, "codexPath") ?? _defaults.CodexPath;

		string? existingSessionId = null;
		lock (_sessionsLock)
		{
			var existing = _sessions.Values.FirstOrDefault(x => string.Equals(x.Session.ThreadId, threadId, StringComparison.Ordinal));
			if (existing is not null)
			{
				existingSessionId = existing.SessionId;
				if (setActive)
				{
					_activeSessionId = existing.SessionId;
				}
			}
		}

		if (!string.IsNullOrWhiteSpace(existingSessionId))
		{
			await SendEventAsync("status", new { message = $"Session already loaded for thread {threadId}." }, cancellationToken);
			await SendSessionListAsync(cancellationToken);
			return;
		}

		var sessionId = Guid.NewGuid().ToString("N");
		var sessionLogPath = Path.Combine(_defaults.LogRootPath, $"session-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{sessionId}.log");
		var sessionLog = new LocalLogWriter(sessionLogPath);
		var pendingApproval = new ConcurrentDictionary<string, TaskCompletionSource<string>>(StringComparer.Ordinal);

		await WriteConnectionLogAsync($"[session] attaching id={sessionId} threadId={threadId} cwd={cwd} model={model ?? "(default)"}", cancellationToken);

		CodexClient client;
		CodexSession session;
		try
		{
			var clientOptions = new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = _defaults.CodexHomePath,
				ServerRequestHandler = async (req, ct) =>
				{
					return await HandleServerRequestAsync(sessionId, sessionLog, pendingApproval, req, ct);
				}
			};

			client = await CodexClient.StartAsync(clientOptions, cancellationToken);
			client.OnEvent += ev =>
			{
				HandleCoreEvent(sessionId, sessionLog, ev);
			};

			session = await client.AttachToSessionAsync(new CodexSessionAttachOptions
			{
				ThreadId = threadId,
				Cwd = cwd,
				Model = model
			}, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			sessionLog.Dispose();
			await WriteConnectionLogAsync($"[session] failed to attach id={sessionId} threadId={threadId} error={ex.Message}", cancellationToken);
			await SendEventAsync("error", new { message = $"Failed to attach session: {ex.Message}" }, cancellationToken);
			return;
		}

		var managed = new ManagedSession(sessionId, client, session, cwd, model, sessionLog, pendingApproval);
		lock (_sessionsLock)
		{
			_sessions[sessionId] = managed;
			if (setActive)
			{
				_activeSessionId = sessionId;
			}
		}

		await SendEventAsync("session_created", new
		{
			sessionId,
			threadId = session.ThreadId,
			model,
			cwd,
			attached = true,
			logPath = sessionLogPath
		}, cancellationToken);

		await SendEventAsync("session_attached", new
		{
			sessionId,
			threadId = session.ThreadId,
			model,
			cwd,
			logPath = sessionLogPath
		}, cancellationToken);

		await SendSessionListAsync(cancellationToken);
	}

	private async Task SendSessionCatalogAsync(CancellationToken cancellationToken)
	{
		var sessions = CodexSessionCatalog.ListSessions(_defaults.CodexHomePath, limit: 0);
		var payload = sessions.Select(s => new
		{
			threadId = s.ThreadId,
			threadName = s.ThreadName,
			updatedAtUtc = s.UpdatedAtUtc?.ToString("O"),
			cwd = s.Cwd,
			model = s.Model,
			sessionFilePath = s.SessionFilePath
		}).ToArray();

		await SendEventAsync("session_catalog", new
		{
			codexHomePath = CodexHomePaths.ResolveCodexHomePath(_defaults.CodexHomePath),
			sessions = payload
		}, cancellationToken);
	}

	private async Task SetLogVerbosityAsync(JsonElement request, CancellationToken cancellationToken)
	{
		var verbosityRaw = TryGetString(request, "verbosity");
		if (!CodexEventLogging.TryParseVerbosity(verbosityRaw, out var parsed))
		{
			await SendEventAsync("error", new
			{
				message = $"Unknown verbosity '{verbosityRaw}'. Use errors|normal|verbose|trace."
			}, cancellationToken);
			return;
		}

		_uiLogVerbosity = parsed;
		await SendEventAsync("log_verbosity", new { verbosity = parsed.ToString().ToLowerInvariant() }, cancellationToken);
		await WriteConnectionLogAsync($"[log] verbosity set to {parsed}", cancellationToken);
	}

	private async Task SendSessionListAsync(CancellationToken cancellationToken)
	{
		List<object> sessions;
		lock (_sessionsLock)
		{
			sessions = _sessions.Values
				.Select(s => (object)new { sessionId = s.SessionId, threadId = s.Session.ThreadId, cwd = s.Cwd, model = s.Model })
				.ToList();
		}

		await SendEventAsync("session_list", new { activeSessionId = _activeSessionId, sessions }, cancellationToken);
	}

	private async Task SendModelsListAsync(string? sessionId, CancellationToken cancellationToken)
	{
		// Support listing models even before any session is created by starting a short-lived client.
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;

		try
		{
			IReadOnlyList<CodexModelInfo> models;
			if (string.IsNullOrWhiteSpace(sessionId))
			{
				await using var client = await CodexClient.StartAsync(new CodexClientOptions
				{
					CodexPath = _defaults.CodexPath,
					WorkingDirectory = _defaults.DefaultCwd,
					CodexHomePath = _defaults.CodexHomePath
				}, cancellationToken);

				models = await client.ListModelsAsync(cancellationToken: cancellationToken);
			}
			else
			{
				var session = TryGetSession(sessionId);
				if (session is null)
				{
					await SendEventAsync("models_list", new { sessionId, models = Array.Empty<object>(), error = "Unknown session." }, cancellationToken);
					return;
				}

				models = await session.Client.ListModelsAsync(cancellationToken: cancellationToken);
			}

			var payload = models.Select(m => new
			{
				model = m.Model,
				displayName = m.DisplayName,
				isDefault = m.IsDefault,
				description = m.Description
			}).ToArray();

			await SendEventAsync("models_list", new { sessionId, models = payload, error = (string?)null }, cancellationToken);
		}
		catch (Exception ex)
		{
			Logs.LogError(ex);
			await SendEventAsync("models_list", new { sessionId, models = Array.Empty<object>(), error = ex.Message }, cancellationToken);
		}
	}

	private async Task StartTurnAsync(string? sessionId, string? text, CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session. Create/select a session first." }, cancellationToken);
			return;
		}

		if (string.IsNullOrWhiteSpace(text))
		{
			await SendEventAsync("error", new { message = "Prompt text is required." }, cancellationToken);
			return;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			await SendEventAsync("error", new { message = $"Unknown session: {sessionId}" }, cancellationToken);
			return;
		}

		_ = Task.Run(async () =>
		{
			using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			timeoutCts.CancelAfter(TimeSpan.FromSeconds(_defaults.TurnTimeoutSeconds));
			var turnToken = timeoutCts.Token;

			try
			{
				await SendEventAsync("status", new { sessionId, message = "Turn started." }, CancellationToken.None);
				session.Log.Write($"[prompt] {text}");

				var progress = new Progress<CodexDelta>(d =>
				{
					_ = SendEventAsync("assistant_delta", new { sessionId, text = d.Text }, CancellationToken.None);
				});

				var result = await session.Session.SendMessageAsync(text, progress: progress, cancellationToken: turnToken);

				_ = SendEventAsync("assistant_done", new { sessionId }, CancellationToken.None);
				_ = SendEventAsync("turn_complete", new { sessionId, status = result.Status, errorMessage = result.ErrorMessage }, CancellationToken.None);
			}
			catch (OperationCanceledException)
			{
				_ = SendEventAsync("turn_complete", new { sessionId, status = "timedOut", errorMessage = "Timed out." }, CancellationToken.None);
			}
			catch (Exception ex)
			{
				Logs.LogError(ex);
				session.Log.Write($"[turn_error] {ex.Message}");
				_ = SendEventAsync("turn_complete", new { sessionId, status = "failed", errorMessage = ex.Message }, CancellationToken.None);
			}
		}, CancellationToken.None);
	}

	private void HandleApprovalResponse(JsonElement request)
	{
		var sessionId = TryGetString(request, "sessionId") ?? _activeSessionId;
		var approvalId = TryGetString(request, "approvalId");
		var decision = TryGetString(request, "decision");
		if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(decision))
		{
			return;
		}

		var session = TryGetSession(sessionId);
		if (session is null)
		{
			return;
		}

		var pendingId = string.IsNullOrWhiteSpace(approvalId) ? session.PendingApprovalId : approvalId;
		if (string.IsNullOrWhiteSpace(pendingId))
		{
			return;
		}

		if (session.PendingApprovals.TryRemove(pendingId, out var tcs))
		{
			tcs.TrySetResult(decision);
		}
	}

	private async Task StopSessionAsync(string? sessionId, CancellationToken cancellationToken)
	{
		sessionId = string.IsNullOrWhiteSpace(sessionId) ? _activeSessionId : sessionId;
		if (string.IsNullOrWhiteSpace(sessionId))
		{
			await SendEventAsync("error", new { message = "No active session to stop." }, cancellationToken);
			return;
		}

		ManagedSession? session;
		lock (_sessionsLock)
		{
			_sessions.TryGetValue(sessionId, out session);
			if (session is not null)
			{
				_sessions.Remove(sessionId);
			}
			if (string.Equals(_activeSessionId, sessionId, StringComparison.Ordinal))
			{
				_activeSessionId = _sessions.Keys.FirstOrDefault();
			}
		}

		if (session is null)
		{
			await SendEventAsync("error", new { message = $"Unknown session: {sessionId}" }, cancellationToken);
			return;
		}

		try
		{
			// Cancel any pending approvals.
			foreach (var kvp in session.PendingApprovals.ToArray())
			{
				if (session.PendingApprovals.TryRemove(kvp.Key, out var tcs))
				{
					tcs.TrySetResult("cancel");
				}
			}

			await session.Client.DisposeAsync();
		}
		finally
		{
			session.Log.Dispose();
		}

		await SendEventAsync("session_stopped", new { sessionId, message = "Session stopped." }, cancellationToken);
		await SendSessionListAsync(cancellationToken);
	}

	private ManagedSession? TryGetSession(string sessionId)
	{
		lock (_sessionsLock)
		{
			return _sessions.TryGetValue(sessionId, out var s) ? s : null;
		}
	}

	private async Task<object?> HandleServerRequestAsync(
		string sessionId,
		LocalLogWriter log,
		ConcurrentDictionary<string, TaskCompletionSource<string>> approvals,
		CodexServerRequest req,
		CancellationToken cancellationToken)
	{
		switch (req.Method)
		{
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval":
			{
				var requestType = req.Method.StartsWith("item/commandExecution", StringComparison.Ordinal)
					? "command"
					: "fileChange";

				var key = Guid.NewGuid().ToString("N");
				var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
				approvals[key] = tcs;

				// Best-effort summary for logs.
				var cwd = TryGetPathString(req.Params, "cwd");
				var reason = TryGetPathString(req.Params, "reason");
				var actions = GetCommandActionSummaries(req.Params);
				var summary = requestType == "command"
					? "Command execution requested."
					: "File change requested.";

				log.Write($"[approval_request] session={sessionId} approvalId={key} method={req.Method} cwd={cwd ?? "(n/a)"} reason={reason ?? "(n/a)"}");

				// Surface the approval to the browser and block this server-request until the user decides.
				await SendEventAsync("approval_request", new
				{
					sessionId,
					approvalId = key,
					requestType,
					summary,
					reason,
					cwd,
					actions,
					options = new[] { "accept", "acceptForSession", "decline", "cancel" }
				}, CancellationToken.None);

				try
				{
					var decision = await tcs.Task.WaitAsync(cancellationToken);
					log.Write($"[approval_response] session={sessionId} approvalId={key} decision={decision}");
					return new { decision };
				}
				catch (OperationCanceledException)
				{
					return new { decision = "cancel" };
				}
			}
			case "item/tool/requestUserInput":
				return new { answers = new Dictionary<string, object>() };
			case "item/tool/call":
				return new
				{
					success = false,
					contentItems = new object[] { new { type = "inputText", text = "Dynamic tool calls not supported by web wrapper." } }
				};
			default:
				return new { };
		}
	}

	private void HandleCoreEvent(string sessionId, LocalLogWriter sessionLog, CodexCoreEvent ev)
	{
		sessionLog.Write(CodexEventLogging.Format(ev, includeTimestamp: false));

		if (!CodexEventLogging.ShouldInclude(ev, _uiLogVerbosity))
		{
			return;
		}

		_ = SendEventSafeAsync(
			"log",
			new
			{
				source = "core",
				sessionId,
				level = ev.Level,
				eventType = ev.Type,
				message = CodexEventLogging.Format(ev, includeTimestamp: false)
			});
	}

	private async Task SendEventSafeAsync(string type, object payload)
	{
		try
		{
			await SendEventAsync(type, payload, CancellationToken.None);
		}
		catch
		{
		}
	}

	private static List<string> GetCommandActionSummaries(JsonElement paramsElement)
	{
		var output = new List<string>();
		if (paramsElement.ValueKind != JsonValueKind.Object)
		{
			return output;
		}

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

	private async Task SendEventAsync(string type, object payload, CancellationToken cancellationToken)
	{
		var frame = new { type, payload };
		var json = JsonSerializer.Serialize(frame, _jsonOptions);
		var bytes = Encoding.UTF8.GetBytes(json);

		await _socketSendLock.WaitAsync(cancellationToken);
		try
		{
			await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
		}
		finally
		{
			_socketSendLock.Release();
		}
	}

	private async Task WriteConnectionLogAsync(string message, CancellationToken cancellationToken)
	{
		_connectionLog.Write(message);
		Logs.DebugLog.WriteEvent("MultiSessionWebCliSocketSession", message);
		await SendEventAsync("log", new { source = "connection", message }, cancellationToken);
	}

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
					return null;
				}

				if (result.MessageType != WebSocketMessageType.Text)
				{
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
		List<ManagedSession> toDispose;
		lock (_sessionsLock)
		{
			toDispose = _sessions.Values.ToList();
			_sessions.Clear();
			_activeSessionId = null;
		}

		foreach (var session in toDispose)
		{
			try
			{
				await session.Client.DisposeAsync();
			}
			catch
			{
			}
			finally
			{
				session.Log.Dispose();
			}
		}

		_socketSendLock.Dispose();
		_connectionLog.Dispose();

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

	private static string? TryGetString(JsonElement root, string name)
	{
		if (root.ValueKind != JsonValueKind.Object)
		{
			return null;
		}
		if (!root.TryGetProperty(name, out var value))
		{
			return null;
		}
		if (value.ValueKind == JsonValueKind.String)
		{
			return value.GetString();
		}
		if (value.ValueKind == JsonValueKind.Null)
		{
			return null;
		}
		return value.ToString();
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

	private sealed record ManagedSession(
		string SessionId,
		CodexClient Client,
		CodexSession Session,
		string? Cwd,
		string? Model,
		LocalLogWriter Log,
		ConcurrentDictionary<string, TaskCompletionSource<string>> PendingApprovals)
	{
		public string? PendingApprovalId => PendingApprovals.Keys.FirstOrDefault();
	}
}

