namespace Buffaly.CodexEmbedded.Core;

public sealed class CodexSession
{
	private readonly CodexClient _client;
	private readonly SemaphoreSlim _turnLock = new(1, 1);

	public string ThreadId { get; }
	public string? Cwd { get; }
	public string? Model { get; }
	public string? ApprovalPolicy { get; }
	public string? SandboxMode { get; }

	internal CodexSession(
		CodexClient client,
		string threadId,
		string? cwd,
		string? model,
		string? approvalPolicy,
		string? sandboxMode)
	{
		_client = client;
		ThreadId = threadId;
		Cwd = cwd;
		Model = model;
		ApprovalPolicy = approvalPolicy;
		SandboxMode = sandboxMode;
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
			if (string.IsNullOrWhiteSpace(effectiveOptions.Cwd))
			{
				effectiveOptions = effectiveOptions with { Cwd = Cwd };
			}
			if (string.IsNullOrWhiteSpace(effectiveOptions.ApprovalPolicy))
			{
				effectiveOptions = effectiveOptions with { ApprovalPolicy = ApprovalPolicy };
			}
			if (string.IsNullOrWhiteSpace(effectiveOptions.SandboxMode))
			{
				effectiveOptions = effectiveOptions with { SandboxMode = SandboxMode };
			}

			return await _client.SendMessageAsync(ThreadId, text, effectiveOptions, images, progress, cancellationToken);
		}
		finally
		{
			_turnLock.Release();
		}
	}

	public Task<bool> InterruptTurnAsync(TimeSpan? waitForTurnStart = null, CancellationToken cancellationToken = default)
	{
		return _client.InterruptTurnAsync(ThreadId, waitForTurnStart, cancellationToken);
	}

	public bool TryGetActiveTurnId(out string? turnId)
	{
		return _client.TryGetActiveTurnId(ThreadId, out turnId);
	}

	public Task SteerTurnAsync(
		string expectedTurnId,
		string text,
		IReadOnlyList<CodexUserImageInput>? images = null,
		CancellationToken cancellationToken = default)
	{
		return _client.SendSteerAsync(ThreadId, expectedTurnId, text, images, cancellationToken);
	}
}


