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

	private sealed class FakeAppServer
	{
		private readonly InMemoryJsonlTransport _transport;
		private int _turnCount;
		private const string ThreadId = "thread-1";

		public FakeAppServer(InMemoryJsonlTransport transport)
		{
			_transport = transport;
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
}

