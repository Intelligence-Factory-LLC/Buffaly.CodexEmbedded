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
		IReadOnlyList<CodexUserImageInput>? images = null,
		CodexTurnOptions? options = null,
		IProgress<CodexDelta>? progress = null,
		CancellationToken cancellationToken = default)
	{
		var hasText = !string.IsNullOrWhiteSpace(text);
		var hasImages = images is { Count: > 0 };
		if (!hasText && !hasImages)
		{
			throw new ArgumentException("Either message text or at least one image is required.", nameof(text));
		}

		await _turnLock.WaitAsync(cancellationToken);
		try
		{
			var effectiveOptions = options ?? new CodexTurnOptions();
			if (string.IsNullOrWhiteSpace(effectiveOptions.Model))
			{
				effectiveOptions = effectiveOptions with { Model = Model };
			}

			return await _client.SendMessageAsync(ThreadId, text, effectiveOptions, images, progress, cancellationToken);
		}
		finally
		{
			_turnLock.Release();
		}
	}
}


