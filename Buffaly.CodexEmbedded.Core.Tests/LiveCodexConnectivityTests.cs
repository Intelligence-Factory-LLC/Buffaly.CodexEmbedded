using System.Collections.Concurrent;
using System.Text;
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
}

