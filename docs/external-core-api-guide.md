# External Core API Guide

Date: 2026-02-19

This guide documents the public classes used to integrate with Codex from an external .NET project.

## Main Types

- `CodexClient`
  - Starts/manages the app-server process and JSON-RPC transport.
  - Use `StartAsync(...)` for normal usage.
  - Exposes `OnEvent` for optional low-level runtime events.
- `CodexSession`
  - Represents a single Codex thread.
  - Use `SendMessageAsync(...)` to run a turn.
- `CodexSessionCatalog`
  - Lists saved threads from `CODEX_HOME`.
  - Useful for attach/resume flows.
- `CodexClientOptions`
  - Startup options (`CodexPath`, `WorkingDirectory`, optional `CodexHomePath`, optional `ServerRequestHandler`).
- `CodexSessionCreateOptions`
  - `Cwd`, `Model` for a new thread.
- `CodexSessionAttachOptions`
  - `ThreadId` required, optional `Cwd`, `Model`.
- `CodexTurnResult`
  - Final output for a turn (`Status`, `ErrorMessage`, `Text`, ids).
- `CodexDelta`
  - Streaming text chunk payload while a turn runs.

## 1. Start a New Session

```csharp
await using var client = await CodexClient.StartAsync(new CodexClientOptions
{
    CodexPath = @"C:\Users\Administrator\AppData\Roaming\npm\codex.cmd",
    WorkingDirectory = @"C:\dev\your-workdir",
    // Optional isolation:
    // CodexHomePath = @"C:\dev\your-app\.codex"
});

var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
{
    Cwd = @"C:\dev\your-workdir",
    Model = null
});
```

## 2. Attach to Existing Session

```csharp
var sessions = CodexSessionCatalog.ListSessions(limit: 50);
var threadId = sessions.First().ThreadId;

await using var client = await CodexClient.StartAsync(new CodexClientOptions
{
    CodexPath = @"C:\Users\Administrator\AppData\Roaming\npm\codex.cmd",
    WorkingDirectory = @"C:\dev\your-workdir"
});

var session = await client.AttachToSessionAsync(new CodexSessionAttachOptions
{
    ThreadId = threadId
});
```

## 3. Send Prompt and Receive Result

```csharp
var result = await session.SendMessageAsync("Explain what changed in this file.");

if (!string.Equals(result.Status, "completed", StringComparison.OrdinalIgnoreCase))
{
    Console.WriteLine($"Turn status: {result.Status}");
    Console.WriteLine($"Error: {result.ErrorMessage}");
}

Console.WriteLine(result.Text);
```

## 4. Subscribe to Streaming Updates (Optional)

```csharp
var progress = new Progress<CodexDelta>(d => Console.Write(d.Text));
var result = await session.SendMessageAsync("Stream this answer.", progress: progress);
```

## 5. Subscribe to Runtime/Core Events (Optional)

```csharp
client.OnEvent += ev =>
{
    Console.WriteLine($"{ev.Timestamp:O} [{ev.Level}] {ev.Type}: {ev.Message}");
};
```

## 6. Handle Approvals and Other Server Requests (Optional)

```csharp
await using var client = await CodexClient.StartAsync(new CodexClientOptions
{
    CodexPath = @"C:\Users\Administrator\AppData\Roaming\npm\codex.cmd",
    WorkingDirectory = @"C:\dev\your-workdir",
    ServerRequestHandler = async (req, ct) =>
    {
        return req.Method switch
        {
            "item/commandExecution/requestApproval" => new { decision = "accept" },
            "item/fileChange/requestApproval" => new { decision = "accept" },
            "item/tool/requestUserInput" => new { answers = new Dictionary<string, object>() },
            _ => new { }
        };
    }
});
```

## Notes

- `CodexSession.SendMessageAsync` serializes turns per session.
- Use one `CodexSession` per thread, and one `CodexClient` per process connection.
- `CodexHomePath` controls where sessions/auth/skills are read/written. If omitted, fallback is:
  1. `CODEX_HOME` env var
  2. `%USERPROFILE%\.codex`
