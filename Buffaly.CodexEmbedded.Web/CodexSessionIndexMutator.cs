using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;

internal readonly record struct SessionIndexWriteResult(bool Success, string? ErrorMessage = null);

internal static class CodexSessionIndexMutator
{
	private static readonly SemaphoreSlim _writeGate = new(1, 1);

	public static async Task<SessionIndexWriteResult> TryAppendThreadRenameAsync(
		string? configuredCodexHomePath,
		string threadId,
		string threadName,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(threadId))
		{
			return new SessionIndexWriteResult(false, "threadId is required.");
		}

		if (string.IsNullOrWhiteSpace(threadName))
		{
			return new SessionIndexWriteResult(false, "threadName is required.");
		}

		var indexPath = CodexHomePaths.ResolveSessionIndexPath(configuredCodexHomePath);
		var parentDirectory = Path.GetDirectoryName(indexPath);
		if (!string.IsNullOrWhiteSpace(parentDirectory))
		{
			Directory.CreateDirectory(parentDirectory);
		}

		var payload = new Dictionary<string, object?>
		{
			["id"] = threadId,
			["thread_name"] = threadName,
			["updated_at"] = DateTimeOffset.UtcNow.ToString("O")
		};

		var line = JsonSerializer.Serialize(payload);

		await _writeGate.WaitAsync(cancellationToken);
		try
		{
			await using var stream = new FileStream(indexPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
			await using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
			await writer.WriteLineAsync(line);
			await writer.FlushAsync();
			return new SessionIndexWriteResult(true);
		}
		catch (Exception ex)
		{
			return new SessionIndexWriteResult(false, ex.Message);
		}
		finally
		{
			_writeGate.Release();
		}
	}
}
