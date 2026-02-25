using System.Security.Cryptography;
using System.Text;

internal sealed class UserSecretsOptions
{
	public required bool EnableUserHeaderIdentity { get; init; }
	public required string TrustedUserHeaderName { get; init; }
	public required string UserCookieName { get; init; }
	public required string UserSecretStoragePath { get; init; }

	public static UserSecretsOptions Load(IConfiguration configuration)
	{
		var enableUserHeaderIdentity = configuration.GetValue<bool?>("EnableUserHeaderIdentity") ?? false;
		var trustedUserHeaderName = configuration["TrustedUserHeaderName"];
		var userCookieName = configuration["UserIdentityCookieName"];
		var userSecretStoragePath = configuration["UserSecretStoragePath"];
		if (string.IsNullOrWhiteSpace(userSecretStoragePath))
		{
			var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
			userSecretStoragePath = Path.Combine(localAppData, "Buffaly.CodexEmbedded", "secrets", "web-users");
		}

		return new UserSecretsOptions
		{
			EnableUserHeaderIdentity = enableUserHeaderIdentity,
			TrustedUserHeaderName = string.IsNullOrWhiteSpace(trustedUserHeaderName) ? "X-Buffaly-UserId" : trustedUserHeaderName.Trim(),
			UserCookieName = string.IsNullOrWhiteSpace(userCookieName) ? "buffaly_user_id" : userCookieName.Trim(),
			UserSecretStoragePath = Path.GetFullPath(userSecretStoragePath)
		};
	}

	public static string ComputeStableUserKey(string userId)
	{
		var normalized = userId?.Trim() ?? string.Empty;
		var input = Encoding.UTF8.GetBytes(normalized);
		var hash = SHA256.HashData(input);
		return Convert.ToHexString(hash).ToLowerInvariant();
	}
}
