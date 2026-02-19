using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

public sealed record CodexServerRequest(
	string Method,
	JsonElement Params,
	JsonElement RawMessage);


