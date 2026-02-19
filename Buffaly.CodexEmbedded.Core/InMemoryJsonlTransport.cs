using System.Threading.Channels;

namespace Buffaly.CodexEmbedded.Core;

// Test-friendly in-memory transport.
public sealed class InMemoryJsonlTransport : IJsonlTransport
{
	private readonly Channel<string> _stdin = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = false, SingleWriter = false });
	private readonly Channel<string> _stdout = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = false, SingleWriter = false });
	private readonly Channel<string> _stderr = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = false, SingleWriter = false });

	public ChannelReader<string> StdinReader => _stdin.Reader;
	public ChannelWriter<string> StdoutWriter => _stdout.Writer;
	public ChannelWriter<string> StderrWriter => _stderr.Writer;

	public Task WriteStdinLineAsync(string line, CancellationToken cancellationToken)
	{
		return _stdin.Writer.WriteAsync(line, cancellationToken).AsTask();
	}

	public async Task<string?> ReadStdoutLineAsync(CancellationToken cancellationToken)
	{
		while (await _stdout.Reader.WaitToReadAsync(cancellationToken))
		{
			if (_stdout.Reader.TryRead(out var line))
			{
				return line;
			}
		}
		return null;
	}

	public async Task<string?> ReadStderrLineAsync(CancellationToken cancellationToken)
	{
		while (await _stderr.Reader.WaitToReadAsync(cancellationToken))
		{
			if (_stderr.Reader.TryRead(out var line))
			{
				return line;
			}
		}
		return null;
	}

	public ValueTask DisposeAsync()
	{
		_stdin.Writer.TryComplete();
		_stdout.Writer.TryComplete();
		_stderr.Writer.TryComplete();
		return ValueTask.CompletedTask;
	}
}


