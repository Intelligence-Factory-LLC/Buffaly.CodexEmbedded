using System.Diagnostics;
using System.Text;

namespace Buffaly.CodexEmbedded.Core;

public sealed class ProcessJsonlTransport : IJsonlTransport
{
	private readonly Process _process;

	private ProcessJsonlTransport(Process process)
	{
		_process = process;
	}

	public static Task<ProcessJsonlTransport> StartAsync(CodexClientOptions options, CancellationToken cancellationToken)
	{
		Directory.CreateDirectory(options.WorkingDirectory);

		var psi = new ProcessStartInfo
		{
			FileName = options.CodexPath,
			Arguments = "app-server",
			WorkingDirectory = options.WorkingDirectory,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
			StandardOutputEncoding = Encoding.UTF8,
			StandardErrorEncoding = Encoding.UTF8,
			UseShellExecute = false,
			CreateNoWindow = true
		};

		if (!string.IsNullOrWhiteSpace(options.CodexHomePath))
		{
			Directory.CreateDirectory(options.CodexHomePath);
			psi.Environment["CODEX_HOME"] = options.CodexHomePath;
		}

		foreach (var kvp in options.EnvironmentVariables)
		{
			psi.Environment[kvp.Key] = kvp.Value;
		}

		var process = new Process
		{
			StartInfo = psi
		};

		if (!process.Start())
		{
			throw new InvalidOperationException("Failed to start codex app-server.");
		}

		cancellationToken.ThrowIfCancellationRequested();
		return Task.FromResult(new ProcessJsonlTransport(process));
	}

	public async Task WriteStdinLineAsync(string line, CancellationToken cancellationToken)
	{
		if (_process.HasExited)
		{
			throw new InvalidOperationException("codex app-server exited unexpectedly.");
		}

		await _process.StandardInput.WriteLineAsync(line.AsMemory(), cancellationToken);
		await _process.StandardInput.FlushAsync(cancellationToken);
	}

	public async Task<string?> ReadStdoutLineAsync(CancellationToken cancellationToken)
	{
		if (_process.HasExited && _process.StandardOutput.EndOfStream)
		{
			return null;
		}

		return await _process.StandardOutput.ReadLineAsync(cancellationToken);
	}

	public async Task<string?> ReadStderrLineAsync(CancellationToken cancellationToken)
	{
		if (_process.HasExited && _process.StandardError.EndOfStream)
		{
			return null;
		}

		return await _process.StandardError.ReadLineAsync(cancellationToken);
	}

	public async ValueTask DisposeAsync()
	{
		try
		{
			if (!_process.HasExited)
			{
				try
				{
					_process.StandardInput.Close();
				}
				catch
				{
				}

				var waitTask = _process.WaitForExitAsync();
				var completed = await Task.WhenAny(waitTask, Task.Delay(1500));
				if (completed != waitTask && !_process.HasExited)
				{
					_process.Kill(entireProcessTree: true);
					await _process.WaitForExitAsync();
				}
			}
		}
		finally
		{
			_process.Dispose();
		}
	}
}

