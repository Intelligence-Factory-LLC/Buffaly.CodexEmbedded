using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

public sealed record CodexClientOptions
{
	public string CodexPath { get; init; } = "codex";
	public string WorkingDirectory { get; init; } = System.Environment.CurrentDirectory;
	public string? CodexHomePath { get; init; }

	// Extra environment variables for the child process.
	public Dictionary<string, string> EnvironmentVariables { get; init; } = new(StringComparer.OrdinalIgnoreCase);

	// Optional hook to handle server-initiated JSON-RPC requests (approvals, tool input, etc.).
	public Func<CodexServerRequest, CancellationToken, Task<object?>>? ServerRequestHandler { get; init; }
}

public sealed record CodexSessionCreateOptions
{
	public string? Cwd { get; init; }
	public string? Model { get; init; }
}

public sealed record CodexSessionAttachOptions
{
	public required string ThreadId { get; init; }
	public string? Cwd { get; init; }
	public string? Model { get; init; }
}

public sealed record CodexTurnOptions
{
	public string? Model { get; init; }
}

public sealed record CodexDelta(string ThreadId, string TurnId, string Text);

public sealed record CodexTurnResult(
	string ThreadId,
	string TurnId,
	string Status,
	string? ErrorMessage,
	string Text);

public sealed record CodexCoreEvent(
	DateTimeOffset Timestamp,
	string Level,
	string Type,
	string Message,
	JsonElement? Data = null);

public sealed record CodexModelInfo(string Model, string DisplayName, bool IsDefault, string? Description);

