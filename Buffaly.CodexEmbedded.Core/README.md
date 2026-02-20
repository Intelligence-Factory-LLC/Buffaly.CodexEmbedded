# Buffaly.CodexEmbedded.Core

Minimal .NET wrapper for driving `codex app-server` programmatically from another project.

Detailed API walkthrough: `../docs/external-core-api-guide.md`

## External Consumer Quick Start

1. Build this solution (Debug build copies output DLLs to `Deploy`).
2. Reference `Deploy\Buffaly.CodexEmbedded.Core.dll` from your external project.
3. Start a `CodexClient`, create or attach a session, then call `SendMessageAsync`.

Example `.csproj` reference from another solution:

```xml
<ItemGroup>
  <Reference Include="Buffaly.CodexEmbedded.Core">
    <HintPath>..\Buffaly.CodexEmbedded\Deploy\Buffaly.CodexEmbedded.Core.dll</HintPath>
  </Reference>
</ItemGroup>
```

## Start New Session + Send Prompt

```csharp
using Buffaly.CodexEmbedded.Core;

await using var client = await CodexClient.StartAsync(new CodexClientOptions
{
    CodexPath = "codex",
    WorkingDirectory = @"C:\dev\your-workdir",
    // Optional: isolate sessions/auth/skills for this integration
    // CodexHomePath = @"C:\dev\your-app\.codex"
});

var session = await client.CreateSessionAsync(new CodexSessionCreateOptions
{
    Cwd = @"C:\dev\your-workdir",
    Model = null // or explicit model id
});

var deltas = new Progress<CodexDelta>(d => Console.Write(d.Text));
var result = await session.SendMessageAsync(
    "Summarize the latest README changes.",
    progress: deltas);

Console.WriteLine();
Console.WriteLine($"Thread: {result.ThreadId}");
Console.WriteLine($"Turn: {result.TurnId}");
Console.WriteLine($"Status: {result.Status}");
Console.WriteLine($"Error: {result.ErrorMessage ?? "(none)"}");
Console.WriteLine(result.Text);
```

## Attach Existing Session

```csharp
using Buffaly.CodexEmbedded.Core;

// Optional helper: list previously saved threads in CODEX_HOME/sessions.
var known = CodexSessionCatalog.ListSessions(codexHomePath: null, limit: 50);
var threadId = known.First().ThreadId;

await using var client = await CodexClient.StartAsync(new CodexClientOptions
{
    CodexPath = "codex",
    WorkingDirectory = @"C:\dev\your-workdir"
});

var session = await client.AttachToSessionAsync(new CodexSessionAttachOptions
{
    ThreadId = threadId,
    Cwd = @"C:\dev\your-workdir",
    Model = null
});

var result = await session.SendMessageAsync("Continue from previous context.");
Console.WriteLine(result.Text);
```

## Optional Streaming/Event Subscriptions

You can subscribe at two levels:

- Per-turn text deltas: pass `IProgress<CodexDelta>` to `SendMessageAsync`.
- Core transport/runtime events: subscribe to `CodexClient.OnEvent`.

```csharp
client.OnEvent += ev =>
{
    // Example: inspect all low-level events, warnings, and failures.
    Console.WriteLine($"{ev.Timestamp:O} [{ev.Level}] {ev.Type}: {ev.Message}");
};
```

## Optional Server Request Handling (Approvals/Tool Input)

If Codex asks for approvals or tool input, provide `ServerRequestHandler`:

```csharp
var client = await CodexClient.StartAsync(new CodexClientOptions
{
    CodexPath = "codex",
    WorkingDirectory = @"C:\dev\your-workdir",
    ServerRequestHandler = async (req, ct) =>
    {
        return req.Method switch
        {
            "item/commandExecution/requestApproval" => new { decision = "accept" },
            "item/fileChange/requestApproval" => new { decision = "accept" },
            _ => new { }
        };
    }
});
```

## Self-Test

Runs an in-memory fake app-server flow (no network/auth needed):

```powershell
dotnet run --project Buffaly.CodexEmbedded.Core.Tests -c Release
```


