using System.Globalization;
using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;

internal sealed record CodexAuthStateSnapshot(
	string CodexHomePath,
	string? SourceFilePath,
	string? AuthMode,
	string? AccountId,
	string? Email,
	string? Subject,
	string? ChatGptPlanType,
	string? AccessToken,
	DateTimeOffset? LastRefreshUtc,
	DateTimeOffset? FileUpdatedAtUtc)
{
	public bool HasIdentity =>
		!string.IsNullOrWhiteSpace(AccountId) ||
		!string.IsNullOrWhiteSpace(Email) ||
		!string.IsNullOrWhiteSpace(Subject);

	public bool HasRefreshTokenPayload =>
		!string.IsNullOrWhiteSpace(AccessToken) &&
		!string.IsNullOrWhiteSpace(AccountId);

	public string DisplayLabel
	{
		get
		{
			if (!string.IsNullOrWhiteSpace(Email))
			{
				return Email!;
			}

			if (!string.IsNullOrWhiteSpace(AccountId))
			{
				return $"account:{Shorten(AccountId!, 12)}";
			}

			if (!string.IsNullOrWhiteSpace(Subject))
			{
				return $"sub:{Shorten(Subject!, 16)}";
			}

			if (!string.IsNullOrWhiteSpace(AuthMode))
			{
				return AuthMode!;
			}

			return "unavailable";
		}
	}

	public string IdentityKey
	{
		get
		{
			return string.Join("|",
				AuthMode ?? string.Empty,
				AccountId ?? string.Empty,
				Email ?? string.Empty,
				Subject ?? string.Empty);
		}
	}

	private static string Shorten(string value, int maxLength)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return string.Empty;
		}

		var trimmed = value.Trim();
		if (trimmed.Length <= maxLength)
		{
			return trimmed;
		}

		if (maxLength <= 3)
		{
			return trimmed[..maxLength];
		}

		return trimmed[..(maxLength - 3)] + "...";
	}
}

internal static class CodexAuthStateReader
{
	public static CodexAuthStateSnapshot Read(string? configuredCodexHomePath)
	{
		var codexHomePath = CodexHomePaths.ResolveCodexHomePath(configuredCodexHomePath);
		var authFilePath = Path.Combine(codexHomePath, "auth.json");
		if (!File.Exists(authFilePath))
		{
			return new CodexAuthStateSnapshot(
				CodexHomePath: codexHomePath,
				SourceFilePath: null,
				AuthMode: null,
				AccountId: null,
				Email: null,
				Subject: null,
				ChatGptPlanType: null,
				AccessToken: null,
				LastRefreshUtc: null,
				FileUpdatedAtUtc: null);
		}

		var fileUpdatedAtUtc = TryGetFileUpdatedAtUtc(authFilePath);

		try
		{
			using var doc = JsonDocument.Parse(File.ReadAllText(authFilePath));
			var root = doc.RootElement;
			var authMode = TryGetString(root, "auth_mode");
			var lastRefreshUtc = TryParseUtc(TryGetString(root, "last_refresh"));

			var tokens = TryGetObject(root, "tokens");
			var accessToken = TryGetString(tokens, "access_token");
			var accountId =
				TryGetString(tokens, "account_id") ??
				TryGetString(tokens, "accountId");

			var idToken = TryGetString(tokens, "id_token");
			string? email = null;
			string? subject = null;
			string? chatGptPlanType = null;
			if (TryDecodeJwtPayload(idToken, out var decodedJwtPayload))
			{
				using var payloadDoc = JsonDocument.Parse(decodedJwtPayload);
				var payload = payloadDoc.RootElement;
				email = TryGetString(payload, "email");
				subject = TryGetString(payload, "sub");
				accountId ??=
					TryGetString(payload, "chatgpt_account_id") ??
					TryGetString(payload, "chatgptAccountId") ??
					TryGetString(payload, "https://api.openai.com/auth", "chatgpt_account_id");
				chatGptPlanType =
					TryGetString(payload, "chatgpt_plan_type") ??
					TryGetString(payload, "https://api.openai.com/auth", "chatgpt_plan_type");
			}

			return new CodexAuthStateSnapshot(
				CodexHomePath: codexHomePath,
				SourceFilePath: authFilePath,
				AuthMode: authMode,
				AccountId: accountId,
				Email: email,
				Subject: subject,
				ChatGptPlanType: chatGptPlanType,
				AccessToken: accessToken,
				LastRefreshUtc: lastRefreshUtc,
				FileUpdatedAtUtc: fileUpdatedAtUtc);
		}
		catch
		{
			return new CodexAuthStateSnapshot(
				CodexHomePath: codexHomePath,
				SourceFilePath: authFilePath,
				AuthMode: null,
				AccountId: null,
				Email: null,
				Subject: null,
				ChatGptPlanType: null,
				AccessToken: null,
				LastRefreshUtc: null,
				FileUpdatedAtUtc: fileUpdatedAtUtc);
		}
	}

	private static DateTimeOffset? TryGetFileUpdatedAtUtc(string path)
	{
		try
		{
			var utc = File.GetLastWriteTimeUtc(path);
			return utc == DateTime.MinValue ? null : new DateTimeOffset(utc, TimeSpan.Zero);
		}
		catch
		{
			return null;
		}
	}

	private static JsonElement? TryGetObject(JsonElement element, string propertyName)
	{
		if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
		{
			return null;
		}

		return value.ValueKind == JsonValueKind.Object ? value : null;
	}

	private static string? TryGetString(JsonElement? element, params string[] path)
	{
		if (element is not JsonElement current || path is null || path.Length == 0)
		{
			return null;
		}

		foreach (var segment in path)
		{
			if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
			{
				return null;
			}
		}

		return current.ValueKind == JsonValueKind.String
			? current.GetString()
			: null;
	}

	private static DateTimeOffset? TryParseUtc(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
		{
			return null;
		}

		return parsed.ToUniversalTime();
	}

	private static bool TryDecodeJwtPayload(string? jwt, out string payloadJson)
	{
		payloadJson = string.Empty;
		if (string.IsNullOrWhiteSpace(jwt))
		{
			return false;
		}

		var parts = jwt.Split('.');
		if (parts.Length < 2)
		{
			return false;
		}

		if (!TryDecodeBase64Url(parts[1], out var payloadBytes))
		{
			return false;
		}

		payloadJson = Encoding.UTF8.GetString(payloadBytes);
		return !string.IsNullOrWhiteSpace(payloadJson);
	}

	private static bool TryDecodeBase64Url(string value, out byte[] bytes)
	{
		bytes = Array.Empty<byte>();
		if (string.IsNullOrWhiteSpace(value))
		{
			return false;
		}

		var base64 = value
			.Replace('-', '+')
			.Replace('_', '/');

		switch (base64.Length % 4)
		{
			case 0:
				break;
			case 2:
				base64 += "==";
				break;
			case 3:
				base64 += "=";
				break;
			default:
				return false;
		}

		try
		{
			bytes = Convert.FromBase64String(base64);
			return true;
		}
		catch
		{
			return false;
		}
	}
}
