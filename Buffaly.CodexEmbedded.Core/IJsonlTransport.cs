namespace Buffaly.CodexEmbedded.Core;

public interface IJsonlTransport : IAsyncDisposable
{
	Task WriteStdinLineAsync(string line, CancellationToken cancellationToken);
	Task<string?> ReadStdoutLineAsync(CancellationToken cancellationToken);
	Task<string?> ReadStderrLineAsync(CancellationToken cancellationToken);
}


