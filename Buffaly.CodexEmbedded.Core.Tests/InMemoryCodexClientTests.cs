using System.Text.Json;
using Buffaly.CodexEmbedded.Core;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Buffaly.CodexEmbedded.Core.Tests;

[TestClass]
public sealed class InMemoryCodexClientTests
{
	[TestMethod]
	public async Task CreateAttachAndSend_WorksAgainstInMemoryTransport()
	{
		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

		await using var transport = new InMemoryJsonlTransport();
		var server = new FakeAppServer(transport);
		var serverTask = server.RunAsync(cts.Token);

		await using var client = await CodexClient.ConnectAsync(transport, cts.Token);

		var deltas = new List<string>();
		var progress = new Progress<CodexDelta>(d => deltas.Add(d.Text));

		var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
		{
			Cwd = "C:\\tmp",
			Model = "fake-model"
		}, cts.Token);

		var result = await session.SendMessageAsync("hello", progress: progress, cancellationToken: cts.Token);

		Assert.AreEqual("completed", result.Status);
		Assert.AreEqual("Hello from fake server.", result.Text);
		Assert.AreEqual(result.Text, string.Join("", deltas));

		var resumed = await client.AttachToSessionAsync(new CodexSessionAttachOptions { ThreadId = session.ThreadId }, cts.Token);
		var resumedResult = await resumed.SendMessageAsync("second", cancellationToken: cts.Token);

		Assert.AreEqual("completed", resumedResult.Status);
		Assert.AreEqual("Second turn ok.", resumedResult.Text);

		cts.Cancel();
		try
		{
			await serverTask;
		}
		catch
		{
		}
	}

	[TestMethod]
	public async Task CreateSession_SendManyQuickTurns_DoesNotDropDeltaText()
	{
		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

		await using var transport = new InMemoryJsonlTransport();
		var server = new FakeAppServer(transport);
		var serverTask = server.RunAsync(cts.Token);

		await using var client = await CodexClient.ConnectAsync(transport, cts.Token);
		var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
		{
			Cwd = "C:\\tmp",
			Model = "fake-model"
		}, cts.Token);

		for (var i = 0; i < 25; i++)
		{
			var result = await session.SendMessageAsync($"msg-{i}", cancellationToken: cts.Token);
			Assert.AreEqual("completed", result.Status);
			Assert.AreEqual(i == 0 ? "Hello from fake server." : "Second turn ok.", result.Text);
		}

		cts.Cancel();
		try
		{
			await serverTask;
		}
		catch
		{
		}
	}

	[TestMethod]
	public async Task SendMessage_CompletesFromCodexTaskCompleteEvent_WhenTurnCompletedNotificationIsMissing()
	{
		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

		await using var transport = new InMemoryJsonlTransport();
		var server = new FakeAppServer(transport, CompletionSignalMode.CodexTaskCompleteOnly);
		var serverTask = server.RunAsync(cts.Token);

		await using var client = await CodexClient.ConnectAsync(transport, cts.Token);
		var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
		{
			Cwd = "C:\\tmp",
			Model = "fake-model"
		}, cts.Token);

		var result = await session.SendMessageAsync("hello", cancellationToken: cts.Token);

		Assert.AreEqual("completed", result.Status);
		Assert.AreEqual("Hello from fake server.", result.Text);

		cts.Cancel();
		try
		{
			await serverTask;
		}
		catch
		{
		}
	}

	[TestMethod]
	public async Task SendMessage_WithPlanCollaborationMode_SerializesTurnStartCollaborationPayload()
	{
		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

		string? observedMode = null;
		bool observedSettingsObject = false;
		string? observedReasoningEffort = null;

		await using var transport = new InMemoryJsonlTransport();
		var server = new FakeAppServer(
			transport,
			onTurnStart: turnStartParams =>
			{
				if (turnStartParams.ValueKind != JsonValueKind.Object)
				{
					return;
				}

				if (!turnStartParams.TryGetProperty("collaborationMode", out var collaborationMode) ||
					collaborationMode.ValueKind != JsonValueKind.Object)
				{
					return;
				}

				if (collaborationMode.TryGetProperty("mode", out var modeElement) &&
					modeElement.ValueKind == JsonValueKind.String)
				{
					observedMode = modeElement.GetString();
				}

				if (collaborationMode.TryGetProperty("settings", out var settingsElement) &&
					settingsElement.ValueKind == JsonValueKind.Object)
				{
					observedSettingsObject = true;
					if (settingsElement.TryGetProperty("reasoning_effort", out var effortElement) &&
						effortElement.ValueKind == JsonValueKind.String)
					{
						observedReasoningEffort = effortElement.GetString();
					}
				}
			});
		var serverTask = server.RunAsync(cts.Token);

		await using var client = await CodexClient.ConnectAsync(transport, cts.Token);
		var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
		{
			Cwd = "C:\\tmp",
			Model = "fake-model"
		}, cts.Token);

		var result = await session.SendMessageAsync(
			"Plan this change only.",
			options: new CodexTurnOptions
			{
				ReasoningEffort = "medium",
				CollaborationMode = new CodexCollaborationMode
				{
					Mode = "plan"
				}
			},
			cancellationToken: cts.Token);

		Assert.AreEqual("completed", result.Status);
		Assert.AreEqual("plan", observedMode);
		Assert.IsTrue(observedSettingsObject, "collaborationMode.settings was not emitted.");
		Assert.AreEqual("medium", observedReasoningEffort);

		cts.Cancel();
		try
		{
			await serverTask;
		}
		catch
		{
		}
	}

	[TestMethod]
	public async Task Initialize_SendsExperimentalApiCapability()
	{
		using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
		bool observedExperimentalApi = false;

		await using var transport = new InMemoryJsonlTransport();
		var server = new FakeAppServer(
			transport,
			onInitialize: initializeParams =>
			{
				if (initializeParams.ValueKind != JsonValueKind.Object)
				{
					return;
				}

				if (!initializeParams.TryGetProperty("capabilities", out var capabilities) ||
					capabilities.ValueKind != JsonValueKind.Object)
				{
					return;
				}

				observedExperimentalApi =
					capabilities.TryGetProperty("experimentalApi", out var experimentalApiElement) &&
					experimentalApiElement.ValueKind == JsonValueKind.True;
			});
		var serverTask = server.RunAsync(cts.Token);

		await using var client = await CodexClient.ConnectAsync(transport, cts.Token);
		await client.InitializeAsync(cts.Token);

		Assert.IsTrue(observedExperimentalApi, "initialize.capabilities.experimentalApi=true was not sent.");

		cts.Cancel();
		try
		{
			await serverTask;
		}
		catch
		{
		}
	}

	private sealed class FakeAppServer
	{
		private readonly InMemoryJsonlTransport _transport;
		private readonly CompletionSignalMode _completionSignalMode;
		private readonly Action<JsonElement>? _onTurnStart;
		private readonly Action<JsonElement>? _onInitialize;
		private int _turnCount;
		private const string ThreadId = "thread-1";

		public FakeAppServer(
			InMemoryJsonlTransport transport,
			CompletionSignalMode completionSignalMode = CompletionSignalMode.TurnCompleted,
			Action<JsonElement>? onTurnStart = null,
			Action<JsonElement>? onInitialize = null)
		{
			_transport = transport;
			_completionSignalMode = completionSignalMode;
			_onTurnStart = onTurnStart;
			_onInitialize = onInitialize;
		}

		public async Task RunAsync(CancellationToken cancellationToken)
		{
			await foreach (var line in _transport.StdinReader.ReadAllAsync(cancellationToken))
			{
				using var doc = JsonDocument.Parse(line);
				var root = doc.RootElement;
				var method = root.GetProperty("method").GetString();
				var id = root.GetProperty("id");

				switch (method)
				{
					case "initialize":
						if (root.TryGetProperty("params", out var initializeParams))
						{
							_onInitialize?.Invoke(initializeParams);
						}
						await WriteStdoutAsync(new { id = CloneId(id), result = new { userAgent = "fake/0.1.0" } }, cancellationToken);
						break;
					case "thread/start":
						await WriteStdoutAsync(new { id = CloneId(id), result = new { thread = new { id = ThreadId } } }, cancellationToken);
						break;
					case "thread/resume":
						await WriteStdoutAsync(new { id = CloneId(id), result = new { thread = new { id = ThreadId } } }, cancellationToken);
						break;
					case "turn/start":
						_turnCount++;
						var turnId = $"turn-{_turnCount}";
						if (root.TryGetProperty("params", out var turnStartParams))
						{
							_onTurnStart?.Invoke(turnStartParams);
						}
						await WriteStdoutAsync(new
						{
							id = CloneId(id),
							result = new
							{
								turn = new
								{
									id = turnId,
									status = "inProgress",
									items = Array.Empty<object>(),
									error = (object?)null
								}
							}
						}, cancellationToken);

						var text = _turnCount == 1 ? "Hello from fake server." : "Second turn ok.";
						await WriteStdoutAsync(new { method = "item/agentMessage/delta", @params = new { delta = text, threadId = ThreadId, turnId } }, cancellationToken);
						if (_completionSignalMode == CompletionSignalMode.TurnCompleted)
						{
							await WriteStdoutAsync(new
							{
								method = "turn/completed",
								@params = new
								{
									threadId = ThreadId,
									turn = new
									{
										id = turnId,
										status = "completed",
										error = (object?)null
									}
								}
							}, cancellationToken);
						}
						else
						{
							await WriteStdoutAsync(new
							{
								method = "codex/event/task_complete",
								@params = new
								{
									id = turnId,
									msg = new
									{
										type = "task_complete",
										turn_id = turnId,
										last_agent_message = text
									},
									conversationId = ThreadId
								}
							}, cancellationToken);
						}
						break;
					default:
						await WriteStdoutAsync(new { id = CloneId(id), result = new { } }, cancellationToken);
						break;
				}
			}
		}

		private static object CloneId(JsonElement id)
		{
			return id.ValueKind switch
			{
				JsonValueKind.String => id.GetString() ?? string.Empty,
				JsonValueKind.Number when id.TryGetInt64(out var v) => v,
				_ => id.ToString()
			};
		}

		private Task WriteStdoutAsync(object payload, CancellationToken cancellationToken)
		{
			var json = JsonSerializer.Serialize(payload);
			return _transport.StdoutWriter.WriteAsync(json, cancellationToken).AsTask();
		}
	}

	private enum CompletionSignalMode
	{
		TurnCompleted,
		CodexTaskCompleteOnly
	}
}

