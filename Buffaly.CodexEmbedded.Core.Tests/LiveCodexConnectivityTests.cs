using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Buffaly.CodexEmbedded.Core.Tests;

[TestClass]
public sealed class LiveCodexConnectivityTests
{
	[TestMethod]
	public async Task CreateSession_SendPrompt_StreamsAndCompletes_WithNoCoreErrors()
	{
		if (!TestRuntime.IsLiveCodexTestsEnabled())
		{
			Assert.Inconclusive("Set Buffaly.CodexEmbedded.Core.Tests/appsettings.json: RunLiveCodexTests = 1 to run live Codex connectivity tests.");
		}

		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(240));
		var codexPath = TestRuntime.ResolveCodexPath();
		var cwd = TestRuntime.ResolveDefaultCwd();
		var codexHome = TestRuntime.ResolveCodexHome();
		var logPath = TestRuntime.CreateLogPath(nameof(CreateSession_SendPrompt_StreamsAndCompletes_WithNoCoreErrors));
		var events = new ConcurrentQueue<CodexCoreEvent>();
		var eventLock = new object();
		CodexTurnResult? result = null;
		List<string>? deltas = null;
		CodexCoreEvent[]? snapshot = null;

		using (var writer = new StreamWriter(logPath, append: false, Encoding.UTF8))
		{
			await using (var client = await CodexClient.StartAsync(new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = codexHome
			}, cts.Token))
			{
				client.OnEvent += ev =>
				{
					events.Enqueue(ev);
					lock (eventLock)
					{
						writer.WriteLine($"{ev.Timestamp:O}|{ev.Level}|{ev.Type}|{ev.Message}");
						writer.Flush();
					}
				};

				var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
				{
					Cwd = cwd
				}, cts.Token);

				deltas = new List<string>();
				var progress = new Progress<CodexDelta>(d => deltas.Add(d.Text));
				result = await session.SendMessageAsync(
					"Reply with exactly PING_OK and no other words.",
					progress: progress,
					cancellationToken: cts.Token);

				snapshot = events.ToArray();
			}
		}

		Assert.IsNotNull(result);
		Assert.IsNotNull(deltas);
		Assert.IsNotNull(snapshot);
		Assert.AreEqual("completed", result!.Status);
		Assert.IsTrue(string.IsNullOrWhiteSpace(result.ErrorMessage), $"Unexpected turn error: {result.ErrorMessage}");
		Assert.IsTrue(result.Text.Contains("PING_OK", StringComparison.OrdinalIgnoreCase));
		Assert.AreNotEqual(0, deltas!.Count);
		Assert.IsFalse(string.IsNullOrWhiteSpace(string.Concat(deltas!)));
		Assert.IsFalse(snapshot!.Any(e => string.Equals(e.Level, "error", StringComparison.OrdinalIgnoreCase)));

		// Read logs only after Codex client has fully exited and writer is disposed.
		var logText = await File.ReadAllTextAsync(logPath, cts.Token);
		Assert.IsFalse(logText.Contains("|error|", StringComparison.OrdinalIgnoreCase));
	}

	[TestMethod]
	public async Task ResumeThread_WithNewClient_CanContinueConversation_AndStream()
	{
		if (!TestRuntime.IsLiveCodexTestsEnabled())
		{
			Assert.Inconclusive("Set Buffaly.CodexEmbedded.Core.Tests/appsettings.json: RunLiveCodexTests = 1 to run live Codex connectivity tests.");
		}

		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(300));
		var codexPath = TestRuntime.ResolveCodexPath();
		var cwd = TestRuntime.ResolveDefaultCwd();
		var codexHome = TestRuntime.ResolveCodexHome();
		var logPath = TestRuntime.CreateLogPath(nameof(ResumeThread_WithNewClient_CanContinueConversation_AndStream));
		var lockObj = new object();
		CodexCoreEvent[]? resumedSnapshot = null;

		string threadId;
		using (var writer = new StreamWriter(logPath, append: false, Encoding.UTF8))
		{
			await using (var client1 = await CodexClient.StartAsync(new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = codexHome
			}, cts.Token))
			{
				client1.OnEvent += ev =>
				{
					lock (lockObj)
					{
						writer.WriteLine($"{ev.Timestamp:O}|client1|{ev.Level}|{ev.Type}|{ev.Message}");
						writer.Flush();
					}
				};

				var session1 = await client1.CreateSessionAsync(new CodexSessionCreateOptions { Cwd = cwd }, cts.Token);
				var first = await session1.SendMessageAsync(
					"Reply with exactly FIRST_OK and no other words.",
					cancellationToken: cts.Token);

				Assert.AreEqual("completed", first.Status);
				Assert.IsTrue(first.Text.Contains("FIRST_OK", StringComparison.OrdinalIgnoreCase));
				threadId = session1.ThreadId;
			}

			var resumedEvents = new ConcurrentQueue<CodexCoreEvent>();
			await using (var client2 = await CodexClient.StartAsync(new CodexClientOptions
			{
				CodexPath = codexPath,
				WorkingDirectory = cwd,
				CodexHomePath = codexHome
			}, cts.Token))
			{
				client2.OnEvent += ev =>
				{
					resumedEvents.Enqueue(ev);
					lock (lockObj)
					{
						writer.WriteLine($"{ev.Timestamp:O}|client2|{ev.Level}|{ev.Type}|{ev.Message}");
						writer.Flush();
					}
				};

				var resumed = await client2.AttachToSessionAsync(new CodexSessionAttachOptions { ThreadId = threadId, Cwd = cwd }, cts.Token);
				var deltas = new List<string>();
				var progress = new Progress<CodexDelta>(d => deltas.Add(d.Text));
				var second = await resumed.SendMessageAsync(
					"Reply with exactly RESUME_OK and no other words.",
					progress: progress,
					cancellationToken: cts.Token);

				Assert.AreEqual("completed", second.Status);
				Assert.IsTrue(string.IsNullOrWhiteSpace(second.ErrorMessage), $"Unexpected turn error: {second.ErrorMessage}");
				Assert.IsTrue(second.Text.Contains("RESUME_OK", StringComparison.OrdinalIgnoreCase));
				Assert.AreNotEqual(0, deltas.Count);
			}

			resumedSnapshot = resumedEvents.ToArray();
		}

		Assert.IsNotNull(resumedSnapshot);
		Assert.IsTrue(resumedSnapshot!.Any(e => e.Type == "rpc_sent" && e.Message.Contains("thread/resume", StringComparison.OrdinalIgnoreCase)));
		Assert.IsFalse(resumedSnapshot!.Any(e => string.Equals(e.Level, "error", StringComparison.OrdinalIgnoreCase)));

		// Read logs only after both Codex clients have fully exited and writer is disposed.
		var logText = await File.ReadAllTextAsync(logPath, cts.Token);
		Assert.IsTrue(logText.Contains("|client2|debug|rpc_sent|thread/resume", StringComparison.OrdinalIgnoreCase));
		Assert.IsFalse(logText.Contains("|error|", StringComparison.OrdinalIgnoreCase));
	}

	[TestMethod]
	public async Task OneOff_TurnStartWithPlanCollaborationMode_IsAccepted_AndEmitsPlanSignals()
	{
		if (!TestRuntime.IsLiveCodexTestsEnabled())
		{
			Assert.Inconclusive("Set Buffaly.CodexEmbedded.Core.Tests/appsettings.json: RunLiveCodexTests = 1 to run live Codex connectivity tests.");
		}

		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(300));
		var codexPath = TestRuntime.ResolveCodexPath();
		var cwd = TestRuntime.ResolveDefaultCwd();
		var codexHome = TestRuntime.ResolveCodexHome();
		var logPath = TestRuntime.CreateLogPath(nameof(OneOff_TurnStartWithPlanCollaborationMode_IsAccepted_AndEmitsPlanSignals));
		var logLock = new object();

		await using var transport = await ProcessJsonlTransport.StartAsync(new CodexClientOptions
		{
			CodexPath = codexPath,
			WorkingDirectory = cwd,
			CodexHomePath = codexHome
		}, cts.Token);

		using (var writer = new StreamWriter(logPath, append: false, Encoding.UTF8))
		{
			using var stderrCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
			var stderrPump = PumpStderrAsync(transport, writer, logLock, stderrCts.Token);
			var rpc = new RawRpcSession(transport, writer, logLock);

			try
			{
				await rpc.SendRequestAsync("initialize", new
				{
					clientInfo = new
					{
						name = "buffaly_core_tests",
						title = "Buffaly Core Tests",
						version = "0.1.0"
					},
					capabilities = new
					{
						experimentalApi = true
					}
				}, cts.Token);

				var threadStartResult = await rpc.SendRequestAsync("thread/start", new
				{
					cwd
				}, cts.Token);

				var threadId = GetRequiredString(threadStartResult, "thread", "id");
				var selectedModel =
					TryGetString(threadStartResult, "thread", "model")
					?? await ResolveModelForPlanSettingsAsync(rpc, cts.Token);
				if (string.IsNullOrWhiteSpace(selectedModel))
				{
					Assert.Inconclusive("Could not resolve a model name required for collaborationMode.settings.model.");
				}

				var turnStartResult = await rpc.SendRequestAsync("turn/start", new
				{
					threadId,
					input = new object[]
					{
						new
						{
							type = "text",
							text = "Create a concise three-step plan for adding a unit test. Do not execute commands or call tools."
						}
					},
					collaborationMode = new
					{
						mode = "plan",
						settings = new
						{
							model = selectedModel,
							reasoning_effort = "medium",
							developer_instructions = (string?)null
						}
					}
				}, cts.Token);

				var turnId = GetRequiredString(turnStartResult, "turn", "id");
				var observation = await rpc.WaitForTurnCompletionAsync(turnId, cts.Token);

				Assert.IsTrue(observation.Completed, "Turn did not reach completion while waiting for plan mode execution.");
				Assert.IsTrue(
					observation.SawPlanSignal,
					$"Plan mode invocation was accepted but no plan signals were observed. Methods seen: {string.Join(", ", observation.MethodsSeen)}");
			}
			finally
			{
				stderrCts.Cancel();
				try
				{
					await stderrPump;
				}
				catch (OperationCanceledException)
				{
				}
			}
		}

		var logText = await File.ReadAllTextAsync(logPath, cts.Token);
		Assert.IsFalse(logText.Contains("\"code\":-32602", StringComparison.OrdinalIgnoreCase), "Server returned invalid params while invoking plan collaboration mode.");
	}

	private static async Task<string?> ResolveModelForPlanSettingsAsync(RawRpcSession rpc, CancellationToken cancellationToken)
	{
		var modelListResult = await rpc.SendRequestAsync("model/list", new { cursor = (string?)null, limit = 200 }, cancellationToken);
		if (!modelListResult.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
		{
			return null;
		}

		string? firstModel = null;
		foreach (var model in data.EnumerateArray())
		{
			var name = TryGetString(model, "model");
			if (string.IsNullOrWhiteSpace(name))
			{
				continue;
			}

			firstModel ??= name;
			if (model.TryGetProperty("isDefault", out var isDefault) && isDefault.ValueKind == JsonValueKind.True)
			{
				return name;
			}
		}

		return firstModel;
	}

	private static async Task PumpStderrAsync(IJsonlTransport transport, StreamWriter writer, object logLock, CancellationToken cancellationToken)
	{
		while (!cancellationToken.IsCancellationRequested)
		{
			string? line;
			try
			{
				line = await transport.ReadStderrLineAsync(cancellationToken);
			}
			catch (OperationCanceledException)
			{
				break;
			}

			if (line is null)
			{
				break;
			}

			lock (logLock)
			{
				writer.WriteLine($"{DateTimeOffset.UtcNow:O}|stderr|{line}");
				writer.Flush();
			}
		}
	}

	private static string GetRequiredString(JsonElement root, params string[] path)
	{
		var value = TryGetString(root, path);
		if (string.IsNullOrWhiteSpace(value))
		{
			throw new AssertFailedException($"Missing required string path: {string.Join(".", path)}");
		}

		return value;
	}

	private static string? TryGetString(JsonElement root, params string[] path)
	{
		if (path.Length == 0)
		{
			return null;
		}

		var current = root;
		foreach (var segment in path)
		{
			if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
			{
				return null;
			}
		}

		return current.ValueKind switch
		{
			JsonValueKind.String => current.GetString(),
			JsonValueKind.Number => current.ToString(),
			JsonValueKind.True => "true",
			JsonValueKind.False => "false",
			_ => null
		};
	}

	private sealed class RawRpcSession
	{
		private readonly IJsonlTransport _transport;
		private readonly StreamWriter _writer;
		private readonly object _logLock;
		private long _nextId;

		public RawRpcSession(IJsonlTransport transport, StreamWriter writer, object logLock)
		{
			_transport = transport;
			_writer = writer;
			_logLock = logLock;
		}

		public async Task<JsonElement> SendRequestAsync(string method, object? @params, CancellationToken cancellationToken)
		{
			var id = Interlocked.Increment(ref _nextId);
			await WriteJsonAsync(new Dictionary<string, object?>
			{
				["id"] = id,
				["method"] = method,
				["params"] = @params
			}, "tx", cancellationToken);

			while (!cancellationToken.IsCancellationRequested)
			{
				var message = await ReadNextMessageAsync(cancellationToken);
				if (TryGetServerRequest(message, out var requestId))
				{
					// This one-off test is plan-only. Replying with an empty result avoids deadlock if a request appears.
					await WriteJsonAsync(new Dictionary<string, object?>
					{
						["id"] = requestId,
						["result"] = new { }
					}, "tx_response", cancellationToken);
					continue;
				}

				if (!TryGetResponseId(message, out var responseId) || responseId != id)
				{
					continue;
				}

				if (message.TryGetProperty("error", out var errorElement))
				{
					throw new AssertFailedException($"RPC {method} failed: {errorElement}");
				}

				if (message.TryGetProperty("result", out var resultElement))
				{
					return resultElement.Clone();
				}

				throw new AssertFailedException($"RPC {method} returned neither result nor error.");
			}

			throw new AssertFailedException($"RPC {method} was cancelled.");
		}

		public async Task<PlanObservation> WaitForTurnCompletionAsync(string turnId, CancellationToken cancellationToken)
		{
			var methodsSeen = new HashSet<string>(StringComparer.Ordinal);
			var sawTurnPlanUpdated = false;
			var sawPlanDelta = false;
			var sawPlanItem = false;
			var sawPlanUpdateEvent = false;
			var sawPlanCollaborationMode = false;

			while (!cancellationToken.IsCancellationRequested)
			{
				var message = await ReadNextMessageAsync(cancellationToken);
				if (TryGetServerRequest(message, out var requestId))
				{
					await WriteJsonAsync(new Dictionary<string, object?>
					{
						["id"] = requestId,
						["result"] = new { }
					}, "tx_response", cancellationToken);
					continue;
				}

				if (!TryGetMethod(message, out var method) || !message.TryGetProperty("params", out var @params))
				{
					continue;
				}

				methodsSeen.Add(method);
				if (string.Equals(method, "turn/plan/updated", StringComparison.Ordinal))
				{
					sawTurnPlanUpdated = true;
				}
				else if (string.Equals(method, "item/plan/delta", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/plan_delta", StringComparison.Ordinal))
				{
					sawPlanDelta = true;
				}
				else if (string.Equals(method, "item/started", StringComparison.Ordinal) || string.Equals(method, "item/completed", StringComparison.Ordinal))
				{
					var itemType = TryGetString(@params, "item", "type");
					if (string.Equals(itemType, "plan", StringComparison.Ordinal))
					{
						sawPlanItem = true;
					}
				}
				else if (string.Equals(method, "codex/event/task_started", StringComparison.Ordinal) ||
					string.Equals(method, "codex/event/turn_started", StringComparison.Ordinal) ||
					string.Equals(method, "turn/started", StringComparison.Ordinal))
				{
					var mode =
						TryGetString(@params, "msg", "collaboration_mode_kind")
						?? TryGetString(@params, "collaboration_mode_kind")
						?? TryGetString(@params, "turn", "collaboration_mode_kind");
					if (string.Equals(mode, "plan", StringComparison.Ordinal))
					{
						sawPlanCollaborationMode = true;
					}
				}
				else if (string.Equals(method, "codex/event/event_msg", StringComparison.Ordinal))
				{
					var eventType = TryGetString(@params, "msg", "type");
					if (string.Equals(eventType, "plan_update", StringComparison.Ordinal))
					{
						sawPlanUpdateEvent = true;
					}
				}

				if (IsMatchingTurnCompleted(method, @params, turnId))
				{
					return new PlanObservation(
						Completed: true,
						SawTurnPlanUpdated: sawTurnPlanUpdated,
						SawPlanDelta: sawPlanDelta,
						SawPlanItem: sawPlanItem,
						SawPlanUpdateEvent: sawPlanUpdateEvent,
						SawPlanCollaborationMode: sawPlanCollaborationMode,
						MethodsSeen: methodsSeen.ToArray());
				}
			}

			return new PlanObservation(
				Completed: false,
				SawTurnPlanUpdated: sawTurnPlanUpdated,
				SawPlanDelta: sawPlanDelta,
				SawPlanItem: sawPlanItem,
				SawPlanUpdateEvent: sawPlanUpdateEvent,
				SawPlanCollaborationMode: sawPlanCollaborationMode,
				MethodsSeen: methodsSeen.ToArray());
		}

		private static bool TryGetMethod(JsonElement message, out string method)
		{
			method = string.Empty;
			if (!message.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String)
			{
				return false;
			}

			var value = methodElement.GetString();
			if (string.IsNullOrWhiteSpace(value))
			{
				return false;
			}

			method = value;
			return true;
		}

		private static bool TryGetResponseId(JsonElement message, out long id)
		{
			id = default;
			if (!message.TryGetProperty("id", out var idElement))
			{
				return false;
			}

			if (idElement.ValueKind == JsonValueKind.Number && idElement.TryGetInt64(out var longValue))
			{
				id = longValue;
				return true;
			}

			if (idElement.ValueKind == JsonValueKind.String && long.TryParse(idElement.GetString(), out var parsed))
			{
				id = parsed;
				return true;
			}

			return false;
		}

		private static bool TryGetServerRequest(JsonElement message, out object requestId)
		{
			requestId = 0L;
			if (!message.TryGetProperty("id", out var idElement) || !message.TryGetProperty("method", out _))
			{
				return false;
			}

			requestId = idElement.ValueKind switch
			{
				JsonValueKind.String => idElement.GetString() ?? string.Empty,
				JsonValueKind.Number when idElement.TryGetInt64(out var n) => n,
				_ => idElement.ToString()
			};
			return true;
		}

		private static bool IsMatchingTurnCompleted(string method, JsonElement @params, string expectedTurnId)
		{
			if (string.Equals(method, "turn/completed", StringComparison.Ordinal))
			{
				var completedTurnId = TryGetString(@params, "turn", "id") ?? TryGetString(@params, "turnId");
				return string.Equals(completedTurnId, expectedTurnId, StringComparison.Ordinal);
			}

			if (string.Equals(method, "codex/event/task_complete", StringComparison.Ordinal) ||
				string.Equals(method, "codex/event/turn_complete", StringComparison.Ordinal))
			{
				var completedTurnId =
					TryGetString(@params, "msg", "turn_id")
					?? TryGetString(@params, "msg", "turnId")
					?? TryGetString(@params, "id")
					?? TryGetString(@params, "turnId");
				return string.Equals(completedTurnId, expectedTurnId, StringComparison.Ordinal);
			}

			return false;
		}

		private async Task<JsonElement> ReadNextMessageAsync(CancellationToken cancellationToken)
		{
			var line = await _transport.ReadStdoutLineAsync(cancellationToken);
			if (line is null)
			{
				throw new AssertFailedException("codex app-server stdout closed unexpectedly.");
			}

			lock (_logLock)
			{
				_writer.WriteLine($"{DateTimeOffset.UtcNow:O}|rx|{line}");
				_writer.Flush();
			}

			using var doc = JsonDocument.Parse(line);
			return doc.RootElement.Clone();
		}

		private async Task WriteJsonAsync(object payload, string directionTag, CancellationToken cancellationToken)
		{
			var json = JsonSerializer.Serialize(payload);
			lock (_logLock)
			{
				_writer.WriteLine($"{DateTimeOffset.UtcNow:O}|{directionTag}|{json}");
				_writer.Flush();
			}
			await _transport.WriteStdinLineAsync(json, cancellationToken);
		}
	}

	private sealed record PlanObservation(
		bool Completed,
		bool SawTurnPlanUpdated,
		bool SawPlanDelta,
		bool SawPlanItem,
		bool SawPlanUpdateEvent,
		bool SawPlanCollaborationMode,
		string[] MethodsSeen)
	{
		public bool SawPlanSignal => SawTurnPlanUpdated || SawPlanDelta || SawPlanItem || SawPlanUpdateEvent || SawPlanCollaborationMode;
	}
}

