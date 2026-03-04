using System.Security.Cryptography;
using System.Text;

internal sealed class UserSecretsOptions
{
	public required bool EnableUserHeaderIdentity { get; init; }
	public required string TrustedUserHeaderName { get; init; }
	public required string UserCookieName { get; init; }
	public required string UserSecretStoragePath { get; init; }
	public required bool UseSharedLocalUserIdentity { get; init; }
	public required string SharedLocalUserId { get; init; }

	public static UserSecretsOptions Load(IConfiguration configuration)
	{
		var enableUserHeaderIdentity = configuration.GetValue<bool?>("EnableUserHeaderIdentity") ?? false;
		var trustedUserHeaderName = configuration["TrustedUserHeaderName"];
		var userCookieName = configuration["UserIdentityCookieName"];
		var userSecretStoragePath = configuration["UserSecretStoragePath"];
		var useSharedLocalUserIdentity = configuration.GetValue<bool?>("UseSharedLocalUserIdentity") ?? true;
		var sharedLocalUserId = configuration["SharedLocalUserId"];
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
			UserSecretStoragePath = Path.GetFullPath(userSecretStoragePath),
			UseSharedLocalUserIdentity = useSharedLocalUserIdentity,
			SharedLocalUserId = NormalizeSharedLocalUserId(sharedLocalUserId)
		};
	}

	private static string NormalizeSharedLocalUserId(string? configuredValue)
	{
		var value = configuredValue?.Trim();
		if (string.IsNullOrWhiteSpace(value))
		{
			return "local_shared_user";
		}

		var isSafe = value.All(ch =>
			(ch >= 'a' && ch <= 'z') ||
			(ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') ||
			ch == '_' ||
			ch == '-' ||
			ch == '.' ||
			ch == ':' ||
			ch == '@');
		return isSafe ? value : "local_shared_user";
	}

	public static string ComputeStableUserKey(string userId)
	{
		var normalized = userId?.Trim() ?? string.Empty;
		var input = Encoding.UTF8.GetBytes(normalized);
		var hash = SHA256.HashData(input);
		return Convert.ToHexString(hash).ToLowerInvariant();
	}
}
