namespace Buffaly.CodexEmbedded.Core;

public sealed class CodexSession
{
	private readonly CodexClient _client;
	private readonly SemaphoreSlim _turnLock = new(1, 1);

	public string ThreadId { get; }
	public string? Cwd { get; }
	public string? Model { get; }

	internal CodexSession(CodexClient client, string threadId, string? cwd, string? model)
	{
		_client = client;
		ThreadId = threadId;
		Cwd = cwd;
		Model = model;
	}

	public async Task<CodexTurnResult> SendMessageAsync(
		string text,
		CodexTurnOptions? options = null,
		IProgress<CodexDelta>? progress = null,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(text))
		{
			throw new ArgumentException("Message text is required.", nameof(text));
		}

		await _turnLock.WaitAsync(cancellationToken);
		try
		{
			var effectiveOptions = options ?? new CodexTurnOptions();
			if (string.IsNullOrWhiteSpace(effectiveOptions.Model))
			{
				effectiveOptions = effectiveOptions with { Model = Model };
			}

			return await _client.SendMessageAsync(ThreadId, text, effectiveOptions, progress, cancellationToken);
		}
		finally
		{
			_turnLock.Release();
		}
	}
}


