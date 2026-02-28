internal sealed class LocalLogWriter : IDisposable
{
	private readonly object _sync = new();
	private readonly StreamWriter _writer;
	public string LogPath { get; }

	public LocalLogWriter(string path)
	{
		LogPath = Path.GetFullPath(path);
		var directory = Path.GetDirectoryName(LogPath);
		if (!string.IsNullOrWhiteSpace(directory))
		{
			Directory.CreateDirectory(directory);
		}

		_writer = new StreamWriter(new FileStream(LogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
		{
			AutoFlush = true
		};
		_writer.WriteLine($"{DateTimeOffset.Now:O} [session] log started");
	}

	// Appends timestamped diagnostic line.
	public void Write(string message)
	{
		lock (_sync)
		{
			_writer.WriteLine($"{DateTimeOffset.Now:O} {message}");
		}
	}

	public void Dispose()
	{
		lock (_sync)
		{
			_writer.Dispose();
		}
	}
}
