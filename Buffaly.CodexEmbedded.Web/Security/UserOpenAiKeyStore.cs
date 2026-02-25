using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

internal sealed class UserOpenAiKeyStore
{
	private readonly UserSecretsOptions _options;
	private readonly IDataProtector _protector;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
	{
		WriteIndented = false
	};

	public UserOpenAiKeyStore(UserSecretsOptions options, IDataProtectionProvider dataProtectionProvider)
	{
		_options = options;
		_protector = dataProtectionProvider.CreateProtector("Buffaly.CodexEmbedded.Web.UserSecrets.OpenAI");
	}

	public async Task<UserOpenAiKeyStatus> GetStatusAsync(string userId, CancellationToken cancellationToken)
	{
		var record = await ReadRecordAsync(userId, cancellationToken);
		if (record is null)
		{
			return UserOpenAiKeyStatus.Empty;
		}

		var hint = BuildMaskedHint(record.Last4);
		return new UserOpenAiKeyStatus(true, hint, record.UpdatedAtUtc);
	}

	public async Task SaveAsync(string userId, string apiKey, CancellationToken cancellationToken)
	{
		var normalizedUserId = userId?.Trim() ?? string.Empty;
		var normalizedApiKey = apiKey?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(normalizedUserId))
		{
			throw new InvalidOperationException("User identity is required.");
		}
		if (string.IsNullOrWhiteSpace(normalizedApiKey))
		{
			throw new InvalidOperationException("OpenAI API key is required.");
		}

		var directory = _options.UserSecretStoragePath;
		Directory.CreateDirectory(directory);

		var path = GetPathForUser(normalizedUserId);
		var tempPath = path + ".tmp";
		var record = new UserOpenAiKeyRecord(
			ProtectedApiKey: _protector.Protect(normalizedApiKey),
			Last4: normalizedApiKey.Length >= 4 ? normalizedApiKey[^4..] : normalizedApiKey,
			UpdatedAtUtc: DateTimeOffset.UtcNow.ToString("O"));
		var json = JsonSerializer.Serialize(record, _jsonOptions);
		await File.WriteAllTextAsync(tempPath, json, cancellationToken);
		File.Move(tempPath, path, overwrite: true);
	}

	public Task DeleteAsync(string userId, CancellationToken cancellationToken)
	{
		var path = GetPathForUser(userId);
		if (File.Exists(path))
		{
			File.Delete(path);
		}

		return Task.CompletedTask;
	}

	public async Task<string?> TryGetApiKeyAsync(string userId, CancellationToken cancellationToken)
	{
		var record = await ReadRecordAsync(userId, cancellationToken);
		if (record is null || string.IsNullOrWhiteSpace(record.ProtectedApiKey))
		{
			return null;
		}

		try
		{
			return _protector.Unprotect(record.ProtectedApiKey);
		}
		catch
		{
			return null;
		}
	}

	private async Task<UserOpenAiKeyRecord?> ReadRecordAsync(string userId, CancellationToken cancellationToken)
	{
		var path = GetPathForUser(userId);
		if (!File.Exists(path))
		{
			return null;
		}

		try
		{
			var json = await File.ReadAllTextAsync(path, cancellationToken);
			if (string.IsNullOrWhiteSpace(json))
			{
				return null;
			}

			return JsonSerializer.Deserialize<UserOpenAiKeyRecord>(json, _jsonOptions);
		}
		catch
		{
			return null;
		}
	}

	private string GetPathForUser(string userId)
	{
		var normalized = userId?.Trim() ?? string.Empty;
		var fileKey = UserSecretsOptions.ComputeStableUserKey(normalized);
		return Path.Combine(_options.UserSecretStoragePath, $"{fileKey}.json");
	}

	private static string BuildMaskedHint(string? last4)
	{
		if (string.IsNullOrWhiteSpace(last4))
		{
			return "****";
		}

		return $"****{last4}";
	}
}

internal sealed record UserOpenAiKeyRecord(
	string ProtectedApiKey,
	string Last4,
	string UpdatedAtUtc);

internal sealed record UserOpenAiKeyStatus(
	bool HasKey,
	string? MaskedKeyHint,
	string? UpdatedAtUtc)
{
	public static readonly UserOpenAiKeyStatus Empty = new(false, null, null);
}
