using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Buffaly.CodexEmbedded.Core;

// Parses arguments, runs the harness, and maps failures to exit codes.
internal static class Program
{
	public static async Task<int> Main(string[] args)
	{
		Console.OutputEncoding = Encoding.UTF8;

		var runtimeDefaults = RuntimeDefaults.Load();
		if (!HarnessOptions.TryParse(args, runtimeDefaults, out var options, out var errorMessage))
		{
			Console.Error.WriteLine(errorMessage);
			PrintUsage();
			return 2;
		}

		using var cancelCts = new CancellationTokenSource();

		Console.CancelKeyPress += CancelKeyPressHandler;

		try
		{
			if (!string.IsNullOrWhiteSpace(options.Prompt))
			{
				return await RunSinglePromptAsync(options, options.Prompt, cancelCts.Token);
			}

			return await RunReplAsync(options, cancelCts.Token);
		}
		catch (OperationCanceledException)
		{
			Console.Error.WriteLine("Cancelled.");
			return 130;
		}
		catch (Exception ex)
		{
			Console.Error.WriteLine($"Harness failed: {ex.Message}");
			return 1;
		}
		finally
		{
			Console.CancelKeyPress -= CancelKeyPressHandler;
		}

		// Handles CTRL+C by requesting cooperative cancellation.
		void CancelKeyPressHandler(object? sender, ConsoleCancelEventArgs eventArgs)
		{
			eventArgs.Cancel = true;
			cancelCts.Cancel();
		}
	}

	// Prints supported command syntax and options.
	private static void PrintUsage()
	{
		Console.Error.WriteLine("Usage:");
		Console.Error.WriteLine("  Buffaly.CodexEmbedded.Cli [options]");
		Console.Error.WriteLine("  Buffaly.CodexEmbedded.Cli run [--prompt \"your prompt\"] [options]");
		Console.Error.WriteLine();
		Console.Error.WriteLine("Options:");
		Console.Error.WriteLine("  --prompt <text>           Optional prompt text. If omitted, starts REPL mode.");
		Console.Error.WriteLine("  --thread-id <id>          Optional thread id to resume (uses thread/resume).");
		Console.Error.WriteLine("  --model <name>            Optional model override (default from %USERPROFILE%\\.codex\\config.toml).");
		Console.Error.WriteLine("  --cwd <path>              Optional working directory (default from appsettings.json).");
		Console.Error.WriteLine("  --auto-approve <mode>     ask|accept|acceptForSession|decline|cancel (default: ask).");
		Console.Error.WriteLine("  --timeout-seconds <n>     Overall timeout in seconds (default: 300).");
		Console.Error.WriteLine("  --json-events             Mirror raw JSONL from stdout.");
		Console.Error.WriteLine("  --codex-path <path>       Codex executable path (default from appsettings.json, fallback: codex).");
		Console.Error.WriteLine("  --codex-home <path>       Optional writable Codex home directory (sets CODEX_HOME for child process).");
	}

	// Runs one prompt with per-turn timeout and harness process lifecycle.
	private static async Task<int> RunSinglePromptAsync(HarnessOptions options, string prompt, CancellationToken cancellationToken)
	{
		using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeoutCts.CancelAfter(TimeSpan.FromSeconds(options.TimeoutSeconds));
		await using var harness = new CodexCoreHarness(options.WithPrompt(prompt));

		try
		{
			return await harness.RunAsync(timeoutCts.Token);
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			Console.Error.WriteLine($"Timed out after {options.TimeoutSeconds} seconds.");
			return 124;
		}
	}

	// Starts an interactive REPL when no prompt is passed.
	private static async Task<int> RunReplAsync(HarnessOptions options, CancellationToken cancellationToken)
	{
		Console.WriteLine("REPL mode. Enter a prompt and press Enter. Type /exit to quit.");

		while (!cancellationToken.IsCancellationRequested)
		{
			Console.Write("> ");
			var line = Console.ReadLine();
			if (line is null)
			{
				break;
			}

			var prompt = line.Trim();
			if (string.IsNullOrWhiteSpace(prompt))
			{
				continue;
			}

			if (string.Equals(prompt, "/exit", StringComparison.OrdinalIgnoreCase) ||
				string.Equals(prompt, "exit", StringComparison.OrdinalIgnoreCase) ||
				string.Equals(prompt, "quit", StringComparison.OrdinalIgnoreCase))
			{
				break;
			}

			var exitCode = await RunSinglePromptAsync(options, prompt, cancellationToken);
			if (exitCode == 130)
			{
				return exitCode;
			}
		}

		return 0;
	}
}

internal enum AutoApproveMode
{
	Ask,
	Accept,
	AcceptForSession,
	Decline,
	Cancel
}

internal sealed class HarnessOptions
{
	public string? Prompt { get; init; }
	public string? ThreadId { get; init; }
	public required string Cwd { get; init; }
	public string? Model { get; init; }
	public AutoApproveMode AutoApprove { get; init; }
	public int TimeoutSeconds { get; init; }
	public bool JsonEvents { get; init; }
	public required string CodexPath { get; init; }
	public string? CodexHomePath { get; init; }
	public required string LogFilePath { get; init; }

	// Parses supported CLI args into a validated options object.
	public static bool TryParse(string[] args, RuntimeDefaults defaults, out HarnessOptions options, out string errorMessage)
	{
		options = null!;
		errorMessage = string.Empty;

		var startIndex = 0;
		if (args.Length > 0 && string.Equals(args[0], "run", StringComparison.OrdinalIgnoreCase))
		{
			startIndex = 1;
		}
		else if (args.Length > 0 && !args[0].StartsWith("--", StringComparison.Ordinal))
		{
			errorMessage = $"Unknown argument: {args[0]}";
			return false;
		}

		var prompt = (string?)null;
		var threadId = (string?)null;
		var model = defaults.DefaultModel;
		var cwd = defaults.DefaultCwd;
		var autoApprove = AutoApproveMode.Ask;
		var timeoutSeconds = defaults.TimeoutSeconds;
		var jsonEvents = false;
		var codexPath = defaults.CodexPath;
		var codexHomePath = defaults.CodexHomePath;

		for (var i = startIndex; i < args.Length; i++)
		{
			var arg = args[i];
			switch (arg)
			{
				case "--prompt":
					if (!TryReadValue(args, ref i, out prompt))
					{
						errorMessage = "Missing value for --prompt";
						return false;
					}
					break;
				case "--thread-id":
					if (!TryReadValue(args, ref i, out threadId))
					{
						errorMessage = "Missing value for --thread-id";
						return false;
					}
					break;
				case "--model":
					if (!TryReadValue(args, ref i, out model))
					{
						errorMessage = "Missing value for --model";
						return false;
					}
					break;
				case "--cwd":
					if (!TryReadValue(args, ref i, out cwd))
					{
						errorMessage = "Missing value for --cwd";
						return false;
					}
					break;
				case "--auto-approve":
					if (!TryReadValue(args, ref i, out var autoApproveRaw))
					{
						errorMessage = "Missing value for --auto-approve";
						return false;
					}

					if (!TryParseAutoApprove(autoApproveRaw!, out autoApprove))
					{
						errorMessage = "Invalid --auto-approve. Use ask|accept|acceptForSession|decline|cancel.";
						return false;
					}
					break;
				case "--timeout-seconds":
					if (!TryReadValue(args, ref i, out var timeoutRaw) || !int.TryParse(timeoutRaw, out timeoutSeconds) || timeoutSeconds <= 0)
					{
						errorMessage = "Invalid --timeout-seconds value.";
						return false;
					}
					break;
				case "--json-events":
					jsonEvents = true;
					break;
				case "--codex-path":
					if (!TryReadValue(args, ref i, out codexPath))
					{
						errorMessage = "Missing value for --codex-path";
						return false;
					}
					break;
				case "--codex-home":
					if (!TryReadValue(args, ref i, out codexHomePath))
					{
						errorMessage = "Missing value for --codex-home";
						return false;
					}
					break;
				default:
					errorMessage = $"Unknown argument: {arg}";
					return false;
			}
		}

		options = new HarnessOptions
		{
			Prompt = prompt,
			ThreadId = string.IsNullOrWhiteSpace(threadId) ? null : threadId,
			Model = string.IsNullOrWhiteSpace(model) ? null : model,
			Cwd = string.IsNullOrWhiteSpace(cwd) ? defaults.DefaultCwd : cwd,
			AutoApprove = autoApprove,
			TimeoutSeconds = timeoutSeconds,
			JsonEvents = jsonEvents,
			CodexPath = string.IsNullOrWhiteSpace(codexPath) ? "codex" : codexPath,
			CodexHomePath = string.IsNullOrWhiteSpace(codexHomePath) ? null : codexHomePath,
			LogFilePath = defaults.LogFilePath
		};
		return true;
	}

	// Creates a copy of options that targets a specific prompt.
	public HarnessOptions WithPrompt(string prompt)
	{
		return new HarnessOptions
		{
			Prompt = prompt,
			ThreadId = ThreadId,
			Cwd = Cwd,
			Model = Model,
			AutoApprove = AutoApprove,
			TimeoutSeconds = TimeoutSeconds,
			JsonEvents = JsonEvents,
			CodexPath = CodexPath,
			CodexHomePath = CodexHomePath,
			LogFilePath = LogFilePath
		};
	}

	// Reads a single option value and advances the argument index.
	private static bool TryReadValue(string[] args, ref int index, out string? value)
	{
		value = null;
		if (index + 1 >= args.Length)
		{
			return false;
		}

		index++;
		value = args[index];
		return true;
	}

	// Converts CLI text into a supported approval mode enum.
	private static bool TryParseAutoApprove(string value, out AutoApproveMode mode)
	{
		mode = AutoApproveMode.Ask;
		if (value.Equals("ask", StringComparison.OrdinalIgnoreCase))
		{
			mode = AutoApproveMode.Ask;
			return true;
		}

		if (value.Equals("accept", StringComparison.OrdinalIgnoreCase))
		{
			mode = AutoApproveMode.Accept;
			return true;
		}

		if (value.Equals("acceptForSession", StringComparison.OrdinalIgnoreCase))
		{
			mode = AutoApproveMode.AcceptForSession;
			return true;
		}

		if (value.Equals("decline", StringComparison.OrdinalIgnoreCase))
		{
			mode = AutoApproveMode.Decline;
			return true;
		}

		if (value.Equals("cancel", StringComparison.OrdinalIgnoreCase))
		{
			mode = AutoApproveMode.Cancel;
			return true;
		}

		return false;
	}
}

// Minimal CLI runner using the shared Buffaly.CodexEmbedded.Core library.
// This replaces the prior hand-rolled JSON-RPC transport in CodexHarness for normal execution.
internal sealed class CodexCoreHarness : IAsyncDisposable
{
	private readonly HarnessOptions _options;
	private readonly object _consoleLock = new();
	private CodexClient? _client;
	private CodexSession? _session;

	public CodexCoreHarness(HarnessOptions options)
	{
		_options = options;
	}

	public async Task<int> RunAsync(CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(_options.Prompt))
		{
			throw new InvalidOperationException("Prompt is required.");
		}

		_client = await CodexClient.StartAsync(new CodexClientOptions
		{
			CodexPath = _options.CodexPath,
			WorkingDirectory = _options.Cwd,
			CodexHomePath = _options.CodexHomePath,
			ServerRequestHandler = HandleServerRequestAsync
		}, cancellationToken);

		_client.OnEvent += ev =>
		{
			var verbosity = _options.JsonEvents ? CodexEventVerbosity.Trace : CodexEventVerbosity.Normal;
			if (ev.Type == "stdout_jsonl" && _options.JsonEvents)
			{
				lock (_consoleLock)
				{
					Console.Error.WriteLine(ev.Message);
				}
				return;
			}

			if (!CodexEventLogging.ShouldInclude(ev, verbosity))
			{
				return;
			}

			lock (_consoleLock)
			{
				Console.Error.WriteLine(CodexEventLogging.Format(ev));
			}
		};

		if (!string.IsNullOrWhiteSpace(_options.ThreadId))
		{
			_session = await _client.AttachToSessionAsync(new CodexSessionAttachOptions
			{
				ThreadId = _options.ThreadId!,
				Cwd = _options.Cwd,
				Model = _options.Model
			}, cancellationToken);
		}
		else
		{
			_session = await _client.CreateSessionAsync(new CodexSessionCreateOptions
			{
				Cwd = _options.Cwd,
				Model = _options.Model
			}, cancellationToken);
		}

		lock (_consoleLock)
		{
			Console.Error.WriteLine($"[session] threadId={_session.ThreadId}");
		}

		var progress = new Progress<CodexDelta>(d =>
		{
			lock (_consoleLock)
			{
				Console.Write(d.Text);
			}
		});

		var result = await _session.SendMessageAsync(
			_options.Prompt!,
			options: new CodexTurnOptions { Model = _options.Model },
			progress: progress,
			cancellationToken: cancellationToken);

		lock (_consoleLock)
		{
			Console.WriteLine();
			Console.Error.WriteLine($"[turn] status={result.Status}");
			if (!string.IsNullOrWhiteSpace(result.ErrorMessage))
			{
				Console.Error.WriteLine($"[turn] error={result.ErrorMessage}");
			}
			Console.Error.WriteLine($"[session] threadId={result.ThreadId}");
		}

		return string.Equals(result.Status, "completed", StringComparison.OrdinalIgnoreCase) ? 0 : 1;
	}

	private async Task<object?> HandleServerRequestAsync(CodexServerRequest request, CancellationToken cancellationToken)
	{
		switch (request.Method)
		{
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval":
			{
				var requestType = request.Method.StartsWith("item/commandExecution", StringComparison.Ordinal) ? "command" : "fileChange";
				var reason = TryGetPathString(request.Params, "reason");
				var cwd = TryGetPathString(request.Params, "cwd");

				string decision;
				if (_options.AutoApprove == AutoApproveMode.Ask)
				{
					decision = await AskForApprovalDecisionAsync(requestType, reason, cwd, cancellationToken);
				}
				else
				{
					decision = MapApprovalModeToDecision(_options.AutoApprove);
					lock (_consoleLock)
					{
						Console.Error.WriteLine($"[approval:{requestType}] auto={decision}");
					}
				}

				return new { decision };
			}
			case "item/tool/requestUserInput":
				return new { answers = new Dictionary<string, object>() };
			case "item/tool/call":
				return new
				{
					success = false,
					contentItems = new object[]
					{
						new { type = "inputText", text = "Dynamic tool calls are not supported by this CLI harness." }
					}
				};
			default:
				return null;
		}
	}

	private Task<string> AskForApprovalDecisionAsync(string requestType, string? reason, string? cwd, CancellationToken cancellationToken)
	{
		lock (_consoleLock)
		{
			Console.Error.WriteLine($"[approval:{requestType}] requested");
			if (!string.IsNullOrWhiteSpace(reason))
			{
				Console.Error.WriteLine($"[approval:{requestType}] reason={reason}");
			}
			if (!string.IsNullOrWhiteSpace(cwd))
			{
				Console.Error.WriteLine($"[approval:{requestType}] cwd={cwd}");
			}
			Console.Error.Write("[approval] decision (accept|acceptForSession|decline|cancel): ");
		}

		while (!cancellationToken.IsCancellationRequested)
		{
			var input = Console.ReadLine();
			if (input is null)
			{
				return Task.FromResult("cancel");
			}

			var value = input.Trim();
			if (value.Equals("accept", StringComparison.OrdinalIgnoreCase))
			{
				return Task.FromResult("accept");
			}
			if (value.Equals("acceptForSession", StringComparison.OrdinalIgnoreCase))
			{
				return Task.FromResult("acceptForSession");
			}
			if (value.Equals("decline", StringComparison.OrdinalIgnoreCase))
			{
				return Task.FromResult("decline");
			}
			if (value.Equals("cancel", StringComparison.OrdinalIgnoreCase))
			{
				return Task.FromResult("cancel");
			}

			lock (_consoleLock)
			{
				Console.Error.Write("[approval] invalid; choose accept|acceptForSession|decline|cancel: ");
			}
		}

		return Task.FromResult("cancel");
	}

	public async ValueTask DisposeAsync()
	{
		if (_client is not null)
		{
			await _client.DisposeAsync();
			_client = null;
			_session = null;
		}
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

	private static string MapApprovalModeToDecision(AutoApproveMode mode)
	{
		return mode switch
		{
			AutoApproveMode.Accept => "accept",
			AutoApproveMode.AcceptForSession => "acceptForSession",
			AutoApproveMode.Decline => "decline",
			AutoApproveMode.Cancel => "cancel",
			_ => "decline"
		};
	}
}

internal sealed class RuntimeDefaults
{
	public required string CodexPath { get; init; }
	public required string DefaultCwd { get; init; }
	public string? CodexHomePath { get; init; }
	public required int TimeoutSeconds { get; init; }
	public required string LogFilePath { get; init; }
	public string? DefaultModel { get; init; }

	// Loads defaults from appsettings.json and user-level .codex config.
	public static RuntimeDefaults Load()
	{
		var appSettings = LoadAppSettings();
		var modelFromCodexConfig = LoadModelFromCodexConfig();

		return new RuntimeDefaults
		{
			CodexPath = appSettings.CodexPath ?? "codex",
			DefaultCwd = ResolveCwdPath(appSettings.DefaultCwd),
			CodexHomePath = ResolveOptionalPath(appSettings.CodexHomePath),
			TimeoutSeconds = appSettings.TimeoutSeconds > 0 ? appSettings.TimeoutSeconds : 300,
			LogFilePath = ResolveLogFilePath(appSettings.LogFilePath),
			DefaultModel = modelFromCodexConfig
		};
	}

	// Reads appsettings.json from current directory or executable directory.
	private static AppSettingsData LoadAppSettings()
	{
		var candidates = new[]
		{
			Path.Combine(Environment.CurrentDirectory, "appsettings.json"),
			Path.Combine(AppContext.BaseDirectory, "appsettings.json")
		};

		foreach (var path in candidates)
		{
			if (!File.Exists(path))
			{
				continue;
			}

			try
			{
				using var document = JsonDocument.Parse(File.ReadAllText(path));
				var root = document.RootElement;
				return new AppSettingsData
				{
					CodexPath = ReadSettingString(root, "CodexPath", "Buffaly.CodexEmbedded", "CodexPath"),
					DefaultCwd = ReadSettingString(root, "DefaultCwd", "Buffaly.CodexEmbedded", "DefaultCwd"),
					CodexHomePath = ReadSettingString(root, "CodexHomePath", "Buffaly.CodexEmbedded", "CodexHomePath"),
					TimeoutSeconds = ReadSettingInt(root, "TimeoutSeconds", "Buffaly.CodexEmbedded", "TimeoutSeconds"),
					LogFilePath = ReadSettingString(root, "LogFilePath", "Buffaly.CodexEmbedded", "LogFilePath")
				};
			}
			catch
			{
				return new AppSettingsData();
			}
		}

		return new AppSettingsData();
	}

	// Resolves local log path with sensible defaults.
	private static string ResolveCwdPath(string? configuredPath)
	{
		if (string.IsNullOrWhiteSpace(configuredPath))
		{
			return Environment.CurrentDirectory;
		}

		if (Path.IsPathRooted(configuredPath))
		{
			return configuredPath;
		}

		return Path.Combine(Environment.CurrentDirectory, configuredPath);
	}

	private static string ResolveLogFilePath(string? configuredPath)
	{
		if (string.IsNullOrWhiteSpace(configuredPath))
		{
			return Path.Combine(Environment.CurrentDirectory, "logs", "harness-internal.log");
		}

		if (Path.IsPathRooted(configuredPath))
		{
			return configuredPath;
		}

		return Path.Combine(Environment.CurrentDirectory, configuredPath);
	}

	private static string? ResolveOptionalPath(string? configuredPath)
	{
		if (string.IsNullOrWhiteSpace(configuredPath))
		{
			return null;
		}

		if (Path.IsPathRooted(configuredPath))
		{
			return configuredPath;
		}

		return Path.Combine(Environment.CurrentDirectory, configuredPath);
	}

	// Reads default model from %USERPROFILE%\.codex\config.toml.
	private static string? LoadModelFromCodexConfig()
	{
		try
		{
			var codexConfigPath = Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
				".codex",
				"config.toml");

			if (!File.Exists(codexConfigPath))
			{
				return null;
			}

			var toml = File.ReadAllText(codexConfigPath);
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

	private static string? ReadSettingString(JsonElement root, string rootKey, string sectionName, string sectionKey)
	{
		if (root.TryGetProperty(rootKey, out var rootValue) && rootValue.ValueKind == JsonValueKind.String)
		{
			return rootValue.GetString();
		}

		if (root.TryGetProperty(sectionName, out var sectionValue) &&
			sectionValue.ValueKind == JsonValueKind.Object &&
			sectionValue.TryGetProperty(sectionKey, out var nestedValue) &&
			nestedValue.ValueKind == JsonValueKind.String)
		{
			return nestedValue.GetString();
		}

		return null;
	}

	private static int ReadSettingInt(JsonElement root, string rootKey, string sectionName, string sectionKey)
	{
		if (root.TryGetProperty(rootKey, out var rootValue) && rootValue.ValueKind == JsonValueKind.Number && rootValue.TryGetInt32(out var rootInt))
		{
			return rootInt;
		}

		if (root.TryGetProperty(sectionName, out var sectionValue) &&
			sectionValue.ValueKind == JsonValueKind.Object &&
			sectionValue.TryGetProperty(sectionKey, out var nestedValue) &&
			nestedValue.ValueKind == JsonValueKind.Number &&
			nestedValue.TryGetInt32(out var nestedInt))
		{
			return nestedInt;
		}

		return 0;
	}

	private sealed class AppSettingsData
	{
		public string? CodexPath { get; init; }
		public string? DefaultCwd { get; init; }
		public string? CodexHomePath { get; init; }
		public int TimeoutSeconds { get; init; }
		public string? LogFilePath { get; init; }
	}
}

internal sealed class CodexHarness : IAsyncDisposable
{
	private readonly HarnessOptions _options;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);
	private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new(StringComparer.Ordinal);
	private readonly SemaphoreSlim _stdinLock = new(1, 1);
	private readonly object _consoleLock = new();
	private readonly object _diagnosticsLock = new();
	private readonly TaskCompletionSource<bool> _turnCompleted = new(TaskCreationOptions.RunContinuationsAsynchronously);
	private readonly LocalLogWriter _internalLog;

	private Process? _process;
	private long _nextRequestId;
	private string? _threadId;
	private string? _turnId;
	private bool _assistantTextOnCurrentLine;
	private readonly DateTimeOffset _sessionStartedUtc = DateTimeOffset.UtcNow;
	private DateTimeOffset? _lastStdoutUtc;
	private DateTimeOffset? _lastStderrUtc;
	private DateTimeOffset? _lastJsonFrameUtc;
	private DateTimeOffset? _lastRpcSentUtc;
	private DateTimeOffset? _lastRpcResponseUtc;
	private string? _lastStdoutLine;
	private string? _lastStderrLine;
	private string? _lastNotificationMethod;
	private string? _lastErrorMessage;
	private int _rpcSentCount;
	private int _rpcResponseCount;
	private int _notificationCount;
	private int _serverRequestCount;
	private int? _lastProcessId;
	private int? _lastProcessExitCode;
	private DateTimeOffset? _lastProcessStartedUtc;
	private DateTimeOffset? _lastProcessExitedUtc;
	private string _currentPhase = "created";
	private string? _lastRpcMethod;

	public CodexHarness(HarnessOptions options)
	{
		_options = options;
		_internalLog = new LocalLogWriter(options.LogFilePath);
	}

	// Returns a compact diagnostics summary useful when a turn times out.
	public string GetDiagnosticsSummary()
	{
		int? pid = null;
		bool processRunning = false;
		int? exitCode = null;
		try
		{
			if (_process is not null)
			{
				pid = _process.Id;
				if (_process.HasExited)
				{
					exitCode = _process.ExitCode;
				}
				else
				{
					processRunning = true;
				}
			}
		}
		catch
		{
		}

		lock (_diagnosticsLock)
		{
			pid ??= _lastProcessId;
			exitCode ??= _lastProcessExitCode;
			var lines = new List<string>
			{
				"[diagnostics] session snapshot:",
				$"  logPath={_options.LogFilePath}",
				$"  codexPath={_options.CodexPath}",
				$"  codexHome={_options.CodexHomePath ?? "(inherited/default)"}",
				$"  processRunning={processRunning}",
				$"  pid={(pid is null ? "n/a" : pid.Value.ToString(CultureInfo.InvariantCulture))}",
				$"  exitCode={(exitCode is null ? "n/a" : exitCode.Value.ToString(CultureInfo.InvariantCulture))}",
				$"  processStartedUtc={FormatTimestamp(_lastProcessStartedUtc)}",
				$"  processExitedUtc={FormatTimestamp(_lastProcessExitedUtc)}",
				$"  phase={_currentPhase}",
				$"  lastRpcMethod={_lastRpcMethod ?? "(none)"}",
				$"  sessionStartedUtc={_sessionStartedUtc:O}",
				$"  lastJsonFrameUtc={FormatTimestamp(_lastJsonFrameUtc)}",
				$"  lastStdoutUtc={FormatTimestamp(_lastStdoutUtc)}",
				$"  lastStderrUtc={FormatTimestamp(_lastStderrUtc)}",
				$"  lastRpcSentUtc={FormatTimestamp(_lastRpcSentUtc)}",
				$"  lastRpcResponseUtc={FormatTimestamp(_lastRpcResponseUtc)}",
				$"  rpcSent={_rpcSentCount}",
				$"  rpcResponses={_rpcResponseCount}",
				$"  notifications={_notificationCount}",
				$"  serverRequests={_serverRequestCount}",
				$"  lastNotification={_lastNotificationMethod ?? "(none)"}",
				$"  lastError={_lastErrorMessage ?? "(none)"}",
				$"  lastStdoutLine={_lastStdoutLine ?? "(none)"}",
				$"  lastStderrLine={_lastStderrLine ?? "(none)"}"
			};
			return string.Join(Environment.NewLine, lines);
		}
	}

	// Returns a concise timeout hint for CLI output.
	public string? GetTimeoutHint()
	{
		lock (_diagnosticsLock)
		{
			if (!string.IsNullOrWhiteSpace(_lastStderrLine))
			{
				return $"Last codex stderr: {StripAnsiEscapeCodes(_lastStderrLine)}";
			}

			if (string.Equals(_lastRpcMethod, "initialize", StringComparison.OrdinalIgnoreCase) &&
				_rpcResponseCount == 0)
			{
				return "No response to initialize from codex app-server. Verify CodexPath and run `codex app-server` manually to check startup.";
			}

			return null;
		}
	}

	// Executes the end-to-end initialize/thread/turn flow and waits for completion.
	public async Task<int> RunAsync(CancellationToken cancellationToken)
	{
		Directory.CreateDirectory(_options.Cwd);
		WriteUserLine($"[harness] Internal log: {_options.LogFilePath}");
		WriteInternalLog($"[session] starting cwd={_options.Cwd} model={_options.Model ?? "(default)"} codexPath={_options.CodexPath} codexHome={_options.CodexHomePath ?? "(env/default)"}");
		lock (_diagnosticsLock)
		{
			_currentPhase = "starting_process";
		}
		StartProcess();

		var stdoutPump = PumpStdoutAsync(cancellationToken);
		var stderrPump = PumpStderrAsync(cancellationToken);

		try
		{
			lock (_diagnosticsLock)
			{
				_currentPhase = "initializing";
			}
			await InitializeAsync(cancellationToken);
			lock (_diagnosticsLock)
			{
				_currentPhase = "starting_thread";
			}
			var threadId = await StartThreadAsync(cancellationToken);
			lock (_diagnosticsLock)
			{
				_currentPhase = "starting_turn";
			}
			await StartTurnAsync(threadId, cancellationToken);
			lock (_diagnosticsLock)
			{
				_currentPhase = "waiting_turn_completed";
			}
			await _turnCompleted.Task.WaitAsync(cancellationToken);

			if (_assistantTextOnCurrentLine)
			{
				lock (_consoleLock)
				{
					Console.WriteLine();
					_assistantTextOnCurrentLine = false;
				}
			}

			return 0;
		}
		finally
		{
			lock (_diagnosticsLock)
			{
				_currentPhase = "shutting_down";
			}
			await ShutdownProcessAsync();
			await Task.WhenAll(stdoutPump, stderrPump);
			lock (_diagnosticsLock)
			{
				_currentPhase = "stopped";
			}
		}
	}

	// Starts `codex app-server` with JSONL pipes for bidirectional communication.
	private void StartProcess()
	{
		if (_process is not null)
		{
			throw new InvalidOperationException("Process has already been started.");
		}

		var startInfo = new ProcessStartInfo
		{
			FileName = _options.CodexPath,
			Arguments = "app-server",
			WorkingDirectory = _options.Cwd,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
			StandardOutputEncoding = Encoding.UTF8,
			StandardErrorEncoding = Encoding.UTF8,
			UseShellExecute = false,
			CreateNoWindow = true
		};
		if (!string.IsNullOrWhiteSpace(_options.CodexHomePath))
		{
			Directory.CreateDirectory(_options.CodexHomePath);
			startInfo.Environment["CODEX_HOME"] = _options.CodexHomePath;
		}

		var process = new Process
		{
			StartInfo = startInfo
		};

		if (!process.Start())
		{
			throw new InvalidOperationException("Failed to start codex app-server.");
		}

		_process = process;
		lock (_diagnosticsLock)
		{
			_lastProcessId = process.Id;
			_lastProcessStartedUtc = DateTimeOffset.UtcNow;
			_lastProcessExitCode = null;
			_lastProcessExitedUtc = null;
		}
		var codexHomeForLog = startInfo.Environment.TryGetValue("CODEX_HOME", out var codexHomeValue)
			? codexHomeValue ?? "(null)"
			: "(inherited)";
		WriteInternalLog($"[process] started pid={process.Id} file={startInfo.FileName} args={startInfo.Arguments} workingDir={startInfo.WorkingDirectory} codexHome={codexHomeForLog}");
	}

	// Sends the required initialize handshake.
	private async Task InitializeAsync(CancellationToken cancellationToken)
	{
		var initializeParams = new Dictionary<string, object?>
		{
			["clientInfo"] = new Dictionary<string, object?>
			{
				["name"] = "codex_app_server_harness",
				["title"] = "Codex App-Server Harness",
				["version"] = "0.1.0"
			}
		};

		await SendRpcAsync("initialize", initializeParams, cancellationToken);
	}

	// Starts a new thread and returns the server-assigned thread ID.
	private async Task<string> StartThreadAsync(CancellationToken cancellationToken)
	{
		var threadStartParams = new Dictionary<string, object?>
		{
			["cwd"] = _options.Cwd
		};

		if (!string.IsNullOrWhiteSpace(_options.Model))
		{
			threadStartParams["model"] = _options.Model;
		}

		var result = await SendRpcAsync("thread/start", threadStartParams, cancellationToken);
		var threadId = GetRequiredPathString(result, "thread", "id");
		_threadId = threadId;

		WriteInternalLog($"[thread] started {threadId}");
		return threadId;
	}

	// Starts a turn with the user prompt as a single text input item.
	private async Task StartTurnAsync(string threadId, CancellationToken cancellationToken)
	{
		var turnStartParams = new Dictionary<string, object?>
		{
			["threadId"] = threadId,
			["input"] = new object[]
			{
				new Dictionary<string, object?>
				{
					["type"] = "text",
					["text"] = _options.Prompt
				}
			}
		};

		if (!string.IsNullOrWhiteSpace(_options.Model))
		{
			turnStartParams["model"] = _options.Model;
		}

		var result = await SendRpcAsync("turn/start", turnStartParams, cancellationToken);
		var turnId = GetRequiredPathString(result, "turn", "id");
		_turnId = turnId;

		WriteInternalLog($"[turn] started {turnId}");
	}

	// Pumps app-server stdout JSONL and dispatches each frame by JSON-RPC shape.
	private async Task PumpStdoutAsync(CancellationToken cancellationToken)
	{
		WriteInternalLog("[stdout] pump started");
		try
		{
			while (true)
			{
				cancellationToken.ThrowIfCancellationRequested();

				var line = await ReadStdoutLineAsync();
				if (line is null)
				{
					WriteInternalLog("[stdout] EOF");
					break;
				}
				RecordStdout(line);

				if (_options.JsonEvents)
				{
					WriteUserLine(line);
				}

				WriteInternalLog($"[jsonl] {line}");

				JsonDocument document;
				try
				{
					document = JsonDocument.Parse(line);
				}
				catch (Exception ex)
				{
					WriteInternalLog($"[warn] Could not parse JSONL frame: {ex.Message}");
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
						HandleNotification(methodElement.GetString()!, root);
						continue;
					}

					WriteInternalLog($"[warn] Unrecognized frame: {line}");
				}
			}
		}
		catch (OperationCanceledException)
		{
		}
		catch (Exception ex)
		{
			_turnCompleted.TrySetException(new InvalidOperationException($"Stdout pump failed: {ex.Message}", ex));
		}
		finally
		{
			foreach (var kvp in _pending)
			{
				kvp.Value.TrySetException(new InvalidOperationException("Connection closed before response."));
			}

			if (!_turnCompleted.Task.IsCompleted)
			{
				_turnCompleted.TrySetException(new InvalidOperationException("codex app-server ended before turn/completed."));
			}
		}
	}

	// Pumps app-server stderr for protocol/debug visibility.
	private async Task PumpStderrAsync(CancellationToken cancellationToken)
	{
		WriteInternalLog("[stderr] pump started");
		try
		{
			while (true)
			{
				cancellationToken.ThrowIfCancellationRequested();
				var line = await ReadStderrLineAsync();
				if (line is null)
				{
					WriteInternalLog("[stderr] EOF");
					break;
				}
				RecordStderr(line);

				WriteInternalLog($"[codex stderr] {line}");
				WriteUserLine($"[codex stderr] {StripAnsiEscapeCodes(line)}");
			}
		}
		catch (OperationCanceledException)
		{
		}
	}

	// Routes JSON-RPC responses back to their pending request task.
	private void HandleRpcResponse(JsonElement root, string idKey)
	{
		if (!_pending.TryRemove(idKey, out var tcs))
		{
			return;
		}
		lock (_diagnosticsLock)
		{
			_rpcResponseCount++;
			_lastRpcResponseUtc = DateTimeOffset.UtcNow;
		}

		if (root.TryGetProperty("result", out var resultElement))
		{
			tcs.TrySetResult(resultElement.Clone());
			return;
		}

		if (root.TryGetProperty("error", out var errorElement))
		{
			tcs.TrySetException(new InvalidOperationException($"RPC error: {ExtractErrorMessage(errorElement)}"));
			return;
		}

		tcs.TrySetException(new InvalidOperationException("RPC response missing result/error."));
	}

	// Handles server-initiated requests, including approval and tool requests.
	private async Task HandleServerRequestAsync(string method, JsonElement idElement, JsonElement root, CancellationToken cancellationToken)
	{
		lock (_diagnosticsLock)
		{
			_serverRequestCount++;
			_lastNotificationMethod = method;
		}

		var paramsElement = root.TryGetProperty("params", out var paramsValue) ? paramsValue : default;

		switch (method)
		{
			case "item/commandExecution/requestApproval":
			{
				var decision = await ResolveApprovalDecisionAsync("command", paramsElement, cancellationToken);
				await SendRpcResultAsync(idElement, new Dictionary<string, object?> { ["decision"] = decision }, cancellationToken);
				return;
			}
			case "item/fileChange/requestApproval":
			{
				var decision = await ResolveApprovalDecisionAsync("fileChange", paramsElement, cancellationToken);
				await SendRpcResultAsync(idElement, new Dictionary<string, object?> { ["decision"] = decision }, cancellationToken);
				return;
			}
			case "item/tool/requestUserInput":
			{
				var answers = await CollectToolUserInputAnswersAsync(paramsElement, cancellationToken);
				await SendRpcResultAsync(idElement, new Dictionary<string, object?> { ["answers"] = answers }, cancellationToken);
				return;
			}
			case "item/tool/call":
			{
				var toolName = paramsElement.TryGetProperty("tool", out var toolElement) && toolElement.ValueKind == JsonValueKind.String
					? toolElement.GetString()!
					: "unknown";

				var toolResponse = new Dictionary<string, object?>
				{
					["success"] = false,
					["contentItems"] = new object[]
					{
						new Dictionary<string, object?>
						{
							["type"] = "inputText",
							["text"] = $"Dynamic tool call '{toolName}' is not implemented by this harness."
						}
					}
				};

				await SendRpcResultAsync(idElement, toolResponse, cancellationToken);
				return;
			}
			case "account/chatgptAuthTokens/refresh":
			{
				var accessToken = Environment.GetEnvironmentVariable("CODEX_CHATGPT_ACCESS_TOKEN");
				var accountId = Environment.GetEnvironmentVariable("CODEX_CHATGPT_ACCOUNT_ID");

				if (string.IsNullOrWhiteSpace(accessToken) || string.IsNullOrWhiteSpace(accountId))
				{
					await SendRpcErrorAsync(idElement, -32001, "Missing CODEX_CHATGPT_ACCESS_TOKEN/CODEX_CHATGPT_ACCOUNT_ID environment variables.", cancellationToken);
					return;
				}

				var refreshResponse = new Dictionary<string, object?>
				{
					["accessToken"] = accessToken,
					["chatgptAccountId"] = accountId,
					["chatgptPlanType"] = null
				};

				await SendRpcResultAsync(idElement, refreshResponse, cancellationToken);
				return;
			}
			default:
				await SendRpcErrorAsync(idElement, -32601, $"Unsupported server request method: {method}", cancellationToken);
				return;
		}
	}

	// Handles server notifications and resolves the turn completion condition.
	private void HandleNotification(string method, JsonElement root)
	{
		lock (_diagnosticsLock)
		{
			_notificationCount++;
			_lastNotificationMethod = method;
		}

		var paramsElement = root.TryGetProperty("params", out var paramsValue) ? paramsValue : default;

		switch (method)
		{
			case "thread/started":
			{
				var id = TryGetPathString(paramsElement, "thread", "id");
				if (!string.IsNullOrWhiteSpace(id))
				{
					_threadId = id;
				}
				WriteInternalLog($"[thread/started] {_threadId ?? "unknown"}");
				return;
			}
			case "turn/started":
			{
				var id = TryGetPathString(paramsElement, "turn", "id");
				if (!string.IsNullOrWhiteSpace(id))
				{
					_turnId = id;
				}
				WriteInternalLog($"[turn/started] {_turnId ?? "unknown"}");
				return;
			}
			case "item/agentMessage/delta":
			{
				if (paramsElement.TryGetProperty("delta", out var deltaElement) && deltaElement.ValueKind == JsonValueKind.String)
				{
					WriteThreadSafe(deltaElement.GetString()!);
				}
				return;
			}
			case "error":
			{
				var message = TryGetPathString(paramsElement, "error", "message")
					?? TryGetPathString(paramsElement, "message")
					?? "Unknown server error";
				var additionalDetails = TryGetPathString(paramsElement, "error", "additionalDetails")
					?? TryGetPathString(paramsElement, "additionalDetails");
				var detailsSuffix = string.IsNullOrWhiteSpace(additionalDetails) ? string.Empty : $" ({additionalDetails})";
				var compositeMessage = message + detailsSuffix;
				lock (_diagnosticsLock)
				{
					_lastErrorMessage = compositeMessage;
				}
				WriteUserLine($"[error] {compositeMessage}");
				WriteInternalLog($"[error] {compositeMessage}");
				return;
			}
			case "turn/completed":
			{
				var status = TryGetPathString(paramsElement, "turn", "status") ?? "unknown";
				var errorMessage = TryGetPathString(paramsElement, "turn", "error", "message");

				if (!string.IsNullOrWhiteSpace(errorMessage))
				{
					_turnCompleted.TrySetException(new InvalidOperationException($"Turn completed with error status '{status}': {errorMessage}"));
				}
				else
				{
					WriteInternalLog($"[turn] completed ({status})");
					_turnCompleted.TrySetResult(true);
				}
				return;
			}
			default:
			{
				if (method == "item/started" || method == "item/completed")
				{
					var itemId = TryGetPathString(paramsElement, "item", "id") ?? "unknown";
					var itemType = TryGetPathString(paramsElement, "item", "type") ?? "unknown";
					WriteInternalLog($"[{method}] {itemType} ({itemId})");
				}
				else
				{
					WriteInternalLog($"[notification] {method}");
				}
				return;
			}
		}
	}

	// Sends a JSON-RPC request and awaits its correlated response.
	private async Task<JsonElement> SendRpcAsync(string method, object? parameters, CancellationToken cancellationToken)
	{
		var id = Interlocked.Increment(ref _nextRequestId);
		var idKey = id.ToString(CultureInfo.InvariantCulture);
		var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);

		if (!_pending.TryAdd(idKey, tcs))
		{
			throw new InvalidOperationException($"Duplicate request ID: {idKey}");
		}

		var request = new Dictionary<string, object?>
		{
			["id"] = id,
			["method"] = method,
			["params"] = parameters
		};
		lock (_diagnosticsLock)
		{
			_rpcSentCount++;
			_lastRpcSentUtc = DateTimeOffset.UtcNow;
			_lastRpcMethod = method;
		}
		WriteInternalLog($"[rpc->codex] id={idKey} method={method}");

		await WriteJsonLineAsync(request, cancellationToken);
		return await tcs.Task.WaitAsync(cancellationToken);
	}

	// Writes a server-request response with a `result` payload.
	private async Task SendRpcResultAsync(JsonElement idElement, object response, CancellationToken cancellationToken)
	{
		var message = new Dictionary<string, object?>
		{
			["id"] = ConvertRequestIdForWrite(idElement),
			["result"] = response
		};

		await WriteJsonLineAsync(message, cancellationToken);
	}

	// Writes a server-request response with an `error` payload.
	private async Task SendRpcErrorAsync(JsonElement idElement, long code, string message, CancellationToken cancellationToken)
	{
		var payload = new Dictionary<string, object?>
		{
			["id"] = ConvertRequestIdForWrite(idElement),
			["error"] = new Dictionary<string, object?>
			{
				["code"] = code,
				["message"] = message
			}
		};

		await WriteJsonLineAsync(payload, cancellationToken);
	}

	// Writes a single JSON object line to app-server stdin.
	private async Task WriteJsonLineAsync(object payload, CancellationToken cancellationToken)
	{
		var process = _process ?? throw new InvalidOperationException("Process is not running.");
		if (process.HasExited)
		{
			throw new InvalidOperationException("codex app-server exited unexpectedly.");
		}

		var json = JsonSerializer.Serialize(payload, _jsonOptions);

		await _stdinLock.WaitAsync(cancellationToken);
		try
		{
			await process.StandardInput.WriteLineAsync(json);
			await process.StandardInput.FlushAsync();
		}
		finally
		{
			_stdinLock.Release();
		}
	}

	// Resolves approval decisions either from flags or interactive prompts.
	private Task<string> ResolveApprovalDecisionAsync(string requestType, JsonElement paramsElement, CancellationToken cancellationToken)
	{
		if (_options.AutoApprove != AutoApproveMode.Ask)
		{
			return Task.FromResult(MapApprovalModeToDecision(_options.AutoApprove));
		}

		if (requestType == "command")
		{
			WriteCommandApprovalPrompt(paramsElement);
		}
		else
		{
			var detail = TryGetPathString(paramsElement, "reason") ?? "(reason not provided)";
			WriteUserLine($"[approval:{requestType}] {detail}");
			WriteInternalLog($"[approval:{requestType}] {detail}");
		}
		WriteUserLine("Select decision: [a]ccept, accept[s]ession, [d]ecline, [c]ancel");

		while (true)
		{
			cancellationToken.ThrowIfCancellationRequested();

			string? input;
			lock (_consoleLock)
			{
				Console.Write("> ");
				input = Console.ReadLine();
			}

			switch ((input ?? string.Empty).Trim().ToLowerInvariant())
			{
				case "a":
				case "accept":
					return Task.FromResult("accept");
				case "s":
				case "acceptforsession":
					return Task.FromResult("acceptForSession");
				case "d":
				case "decline":
					return Task.FromResult("decline");
				case "c":
				case "cancel":
					return Task.FromResult("cancel");
				default:
					WriteUserLine("Enter a, s, d, or c.");
					break;
			}
		}
	}

	// Writes a sanitized command approval prompt to console and full details to logs.
	private void WriteCommandApprovalPrompt(JsonElement paramsElement)
	{
		var rawCommand = TryGetPathString(paramsElement, "command") ?? "(command not provided)";
		var reason = TryGetPathString(paramsElement, "reason");
		var cwd = TryGetPathString(paramsElement, "cwd");
		var actions = GetCommandActionSummaries(paramsElement);

		WriteUserLine("[approval:command] Command execution requested.");
		if (!string.IsNullOrWhiteSpace(reason))
		{
			WriteUserLine($"Reason: {reason}");
		}

		if (!string.IsNullOrWhiteSpace(cwd))
		{
			WriteUserLine($"Working directory: {cwd}");
		}

		if (actions.Count > 0)
		{
			WriteUserLine($"Parsed actions: {string.Join("; ", actions)}");
		}

		WriteUserLine($"Full command hidden from console. See log file: {_options.LogFilePath}");
		WriteInternalLog($"[approval:command] {rawCommand}");
	}

	// Parses command action metadata from approval params into short user-facing summaries.
	private static List<string> GetCommandActionSummaries(JsonElement paramsElement)
	{
		var results = new List<string>();
		if (!paramsElement.TryGetProperty("commandActions", out var actionsElement) || actionsElement.ValueKind != JsonValueKind.Array)
		{
			return results;
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
					results.Add($"read {(name ?? path ?? "(path unknown)")}");
					break;
				case "listFiles":
					results.Add($"listFiles {(path ?? "(path unknown)")}");
					break;
				case "search":
					results.Add($"search {(query ?? "(query unknown)")} in {(path ?? "(path unknown)")}");
					break;
				default:
					results.Add(type);
					break;
			}
		}

		return results;
	}

	// Collects answers for `item/tool/requestUserInput` requests.
	private Task<Dictionary<string, object?>> CollectToolUserInputAnswersAsync(JsonElement paramsElement, CancellationToken cancellationToken)
	{
		var answers = new Dictionary<string, object?>(StringComparer.Ordinal);
		if (!paramsElement.TryGetProperty("questions", out var questionsElement) || questionsElement.ValueKind != JsonValueKind.Array)
		{
			return Task.FromResult(answers);
		}

		foreach (var question in questionsElement.EnumerateArray())
		{
			cancellationToken.ThrowIfCancellationRequested();

			var questionId = TryGetPathString(question, "id");
			if (string.IsNullOrWhiteSpace(questionId))
			{
				continue;
			}

			var questionText = TryGetPathString(question, "question") ?? questionId;
			var answerText = ResolveToolQuestionAnswer(question, questionText);

			answers[questionId] = new Dictionary<string, object?>
			{
				["answers"] = new[] { answerText }
			};
		}

		return Task.FromResult(answers);
	}

	// Resolves one tool question answer from mode defaults or interactive input.
	private string ResolveToolQuestionAnswer(JsonElement questionElement, string questionText)
	{
		if (_options.AutoApprove != AutoApproveMode.Ask)
		{
			if (questionElement.TryGetProperty("options", out var optionsElement) && optionsElement.ValueKind == JsonValueKind.Array)
			{
				foreach (var option in optionsElement.EnumerateArray())
				{
					var label = TryGetPathString(option, "label");
					if (!string.IsNullOrWhiteSpace(label))
					{
						return label;
					}
				}
			}

			return string.Empty;
		}

		WriteUserLine($"[tool-input] {questionText}");
		WriteInternalLog($"[tool-input] {questionText}");
		if (questionElement.TryGetProperty("options", out var optElement) && optElement.ValueKind == JsonValueKind.Array)
		{
			var index = 1;
			foreach (var option in optElement.EnumerateArray())
			{
				var label = TryGetPathString(option, "label") ?? "(no label)";
				WriteUserLine($"  {index}. {label}");
				index++;
			}
		}

		lock (_consoleLock)
		{
			Console.Write("> ");
			return Console.ReadLine() ?? string.Empty;
		}
	}

	// Converts RequestId JSON into a .NET primitive for outgoing JSON serialization.
	private static object ConvertRequestIdForWrite(JsonElement idElement)
	{
		return idElement.ValueKind switch
		{
			JsonValueKind.String => idElement.GetString() ?? string.Empty,
			JsonValueKind.Number when idElement.TryGetInt64(out var intValue) => intValue,
			JsonValueKind.Number when idElement.TryGetDecimal(out var decimalValue) => decimalValue,
			_ => idElement.ToString()
		};
	}

	// Detects and normalizes RequestId values for response correlation.
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

	// Extracts a human-readable message from a JSON-RPC error object.
	private static string ExtractErrorMessage(JsonElement errorElement)
	{
		if (errorElement.TryGetProperty("message", out var messageElement) && messageElement.ValueKind == JsonValueKind.String)
		{
			return messageElement.GetString() ?? "Unknown error";
		}

		return errorElement.ToString();
	}

	// Reads a required nested string path and throws when missing.
	private static string GetRequiredPathString(JsonElement root, params string[] path)
	{
		var value = TryGetPathString(root, path);
		if (string.IsNullOrWhiteSpace(value))
		{
			throw new InvalidOperationException($"Missing required JSON path: {string.Join(".", path)}");
		}

		return value;
	}

	// Reads an optional nested string path and returns null when missing.
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

	// Maps the selected auto-approve mode to protocol decision values.
	private static string MapApprovalModeToDecision(AutoApproveMode mode)
	{
		return mode switch
		{
			AutoApproveMode.Accept => "accept",
			AutoApproveMode.AcceptForSession => "acceptForSession",
			AutoApproveMode.Decline => "decline",
			AutoApproveMode.Cancel => "cancel",
			_ => "decline"
		};
	}

	// Reads one line from stdout while validating process state.
	private async Task<string?> ReadStdoutLineAsync()
	{
		var process = _process ?? throw new InvalidOperationException("Process is not running.");
		return await process.StandardOutput.ReadLineAsync();
	}

	// Reads one line from stderr while validating process state.
	private async Task<string?> ReadStderrLineAsync()
	{
		var process = _process ?? throw new InvalidOperationException("Process is not running.");
		return await process.StandardError.ReadLineAsync();
	}

	// Writes one console line without interleaving with prompts.
	private void WriteUserLine(string message)
	{
		lock (_consoleLock)
		{
			if (_assistantTextOnCurrentLine)
			{
				Console.WriteLine();
				_assistantTextOnCurrentLine = false;
			}

			Console.WriteLine(message);
		}
	}

	// Writes console text without interleaving with prompts.
	private void WriteThreadSafe(string text)
	{
		lock (_consoleLock)
		{
			Console.Write(text);
			if (!string.IsNullOrEmpty(text))
			{
				_assistantTextOnCurrentLine = true;
			}
		}
	}

	// Writes internal/non-user output to local log file.
	private void WriteInternalLog(string message)
	{
		_internalLog.Write(message);
	}

	// Stops the child process and releases local transport resources.
	private async Task ShutdownProcessAsync()
	{
		var process = _process;
		if (process is null)
		{
			return;
		}

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

				var exitedTask = process.WaitForExitAsync();
				var completed = await Task.WhenAny(exitedTask, Task.Delay(1500));
				if (completed != exitedTask && !process.HasExited)
				{
					process.Kill(entireProcessTree: true);
					await process.WaitForExitAsync();
				}
			}
		}
		finally
		{
			try
			{
				if (process.HasExited)
				{
					lock (_diagnosticsLock)
					{
						_lastProcessExitCode = process.ExitCode;
						_lastProcessExitedUtc = DateTimeOffset.UtcNow;
					}
				}
			}
			catch
			{
			}
			process.Dispose();
			_process = null;
		}
	}

	// Disposes process and synchronization primitives.
	public async ValueTask DisposeAsync()
	{
		await ShutdownProcessAsync();
		_stdinLock.Dispose();
		_internalLog.Dispose();
	}

	private void RecordStdout(string line)
	{
		lock (_diagnosticsLock)
		{
			var now = DateTimeOffset.UtcNow;
			_lastStdoutUtc = now;
			_lastJsonFrameUtc = now;
			_lastStdoutLine = TruncateForDiagnostics(line);
		}
	}

	private void RecordStderr(string line)
	{
		lock (_diagnosticsLock)
		{
			_lastStderrUtc = DateTimeOffset.UtcNow;
			_lastStderrLine = TruncateForDiagnostics(line);
		}
	}

	private static string TruncateForDiagnostics(string value)
	{
		const int maxLength = 220;
		if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
		{
			return value;
		}

		return value[..maxLength] + "...";
	}

	private static string FormatTimestamp(DateTimeOffset? value)
	{
		return value is null ? "n/a" : value.Value.ToString("O");
	}

	private static string StripAnsiEscapeCodes(string value)
	{
		if (string.IsNullOrEmpty(value))
		{
			return value;
		}

		return Regex.Replace(value, @"\x1B\[[0-9;]*[A-Za-z]", string.Empty);
	}
}

internal sealed class LocalLogWriter : IDisposable
{
	private readonly object _logLock = new();
	private readonly StreamWriter _writer;

	public LocalLogWriter(string path)
	{
		var fullPath = Path.GetFullPath(path);
		var directory = Path.GetDirectoryName(fullPath);
		if (!string.IsNullOrWhiteSpace(directory))
		{
			Directory.CreateDirectory(directory);
		}

		_writer = new StreamWriter(new FileStream(fullPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
		{
			AutoFlush = true
		};
		_writer.WriteLine($"{DateTimeOffset.Now:O} [session] logging started");
	}

	// Appends a timestamped line to the local log file.
	public void Write(string message)
	{
		lock (_logLock)
		{
			_writer.WriteLine($"{DateTimeOffset.Now:O} {message}");
		}
	}

	public void Dispose()
	{
		lock (_logLock)
		{
			_writer.Dispose();
		}
	}
}

