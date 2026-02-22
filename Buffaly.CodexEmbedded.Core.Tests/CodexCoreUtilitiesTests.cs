using Buffaly.CodexEmbedded.Core;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Buffaly.CodexEmbedded.Core.Tests;

[TestClass]
public sealed class CodexCoreUtilitiesTests
{
	[TestMethod]
	public void EventLogging_ShouldInclude_ExpectedEventsByVerbosity()
	{
		var stdoutEvent = new CodexCoreEvent(DateTimeOffset.UtcNow, "debug", "stdout_jsonl", "{\"jsonrpc\":\"2.0\"}");
		var warnEvent = new CodexCoreEvent(DateTimeOffset.UtcNow, "warn", "stdout_parse_failed", "bad json");

		Assert.IsFalse(CodexEventLogging.ShouldInclude(stdoutEvent, CodexEventVerbosity.Verbose));
		Assert.IsTrue(CodexEventLogging.ShouldInclude(stdoutEvent, CodexEventVerbosity.Trace));
		Assert.IsTrue(CodexEventLogging.ShouldInclude(warnEvent, CodexEventVerbosity.Errors));
	}

	[DataTestMethod]
	[DataRow("errors", CodexEventVerbosity.Errors)]
	[DataRow("normal", CodexEventVerbosity.Normal)]
	[DataRow("verbose", CodexEventVerbosity.Verbose)]
	[DataRow("trace", CodexEventVerbosity.Trace)]
	[DataRow("all", CodexEventVerbosity.Trace)]
	public void EventLogging_TryParseVerbosity_SupportsKnownValues(string raw, CodexEventVerbosity expected)
	{
		Assert.IsTrue(CodexEventLogging.TryParseVerbosity(raw, out var parsed));
		Assert.AreEqual(expected, parsed);
	}

	[TestMethod]
	public void SessionCatalog_ListSessions_MergesIndexAndSessionFiles()
	{
		var root = Path.Combine(Path.GetTempPath(), "codex-session-catalog-tests", Guid.NewGuid().ToString("N"));
		Directory.CreateDirectory(root);

		try
		{
			var indexPath = Path.Combine(root, "session_index.jsonl");
			File.WriteAllText(
				indexPath,
				"{\"id\":\"thread-1\",\"thread_name\":\"Named Thread\",\"updated_at\":\"2026-02-19T15:00:00Z\"}\n");

			var sessionsPath = Path.Combine(root, "sessions", "2026", "02", "19");
			Directory.CreateDirectory(sessionsPath);

			var thread1File = Path.Combine(sessionsPath, "rollout-2026-02-19T14-55-00-thread-1.jsonl");
			File.WriteAllText(
				thread1File,
				"{\"timestamp\":\"2026-02-19T14:55:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"timestamp\":\"2026-02-19T14:55:00Z\",\"cwd\":\"C:\\\\work1\",\"model\":\"gpt-5\"}}\n");

			var thread2File = Path.Combine(sessionsPath, "rollout-2026-02-19T14-58-00-thread-2.jsonl");
			File.WriteAllText(
				thread2File,
				"{\"timestamp\":\"2026-02-19T14:58:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-2\",\"timestamp\":\"2026-02-19T14:58:00Z\",\"cwd\":\"C:\\\\work2\",\"model\":\"gpt-5-mini\"}}\n");

			var sessions = CodexSessionCatalog.ListSessions(root, limit: 100);

			var thread1 = sessions.SingleOrDefault(x => x.ThreadId == "thread-1");
			var thread2 = sessions.SingleOrDefault(x => x.ThreadId == "thread-2");

			Assert.IsNotNull(thread1);
			Assert.IsNotNull(thread2);
			Assert.AreEqual("Named Thread", thread1!.ThreadName);
			Assert.AreEqual("C:\\work1", thread1.Cwd);
			Assert.AreEqual("gpt-5", thread1.Model);
			Assert.AreEqual("C:\\work2", thread2!.Cwd);
			Assert.AreEqual("gpt-5-mini", thread2.Model);
		}
		finally
		{
			try
			{
				Directory.Delete(root, recursive: true);
			}
			catch
			{
			}
		}
	}

	[TestMethod]
	public async Task ProcessJsonlTransport_StartAsync_ResolvesWindowsCodexCmdShim()
	{
		if (!OperatingSystem.IsWindows())
		{
			return;
		}

		var root = Path.Combine(Path.GetTempPath(), "codex-process-transport-tests", Guid.NewGuid().ToString("N"));
		Directory.CreateDirectory(root);
		try
		{
			var shimPath = Path.Combine(root, "codex.cmd");
			File.WriteAllText(
				shimPath,
				"@echo off\r\necho arg=%1\r\n",
				System.Text.Encoding.ASCII);

			var existingPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
			var options = new CodexClientOptions
			{
				CodexPath = "codex",
				WorkingDirectory = root,
				EnvironmentVariables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
				{
					["PATH"] = $"{root};{existingPath}"
				}
			};

			await using var transport = await ProcessJsonlTransport.StartAsync(options, CancellationToken.None);
			var stdoutLine = await transport.ReadStdoutLineAsync(CancellationToken.None);

			Assert.IsTrue((stdoutLine ?? string.Empty).Contains("arg=app-server", StringComparison.OrdinalIgnoreCase));
		}
		finally
		{
			try
			{
				Directory.Delete(root, recursive: true);
			}
			catch
			{
			}
		}
	}
}
