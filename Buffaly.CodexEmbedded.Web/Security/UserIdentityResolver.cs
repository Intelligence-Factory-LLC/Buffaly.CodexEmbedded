using System.Security.Cryptography;
using System.Text;

internal sealed class UserIdentityResolver
{
	private readonly UserSecretsOptions _options;

	public UserIdentityResolver(UserSecretsOptions options)
	{
		_options = options;
	}

	public string ResolveUserId(HttpContext context)
	{
		var fromHeader = ResolveFromTrustedHeader(context.Request);
		if (!string.IsNullOrWhiteSpace(fromHeader))
		{
			return fromHeader;
		}

		if (context.Request.Cookies.TryGetValue(_options.UserCookieName, out var existingCookie) &&
			!string.IsNullOrWhiteSpace(existingCookie))
		{
			return existingCookie.Trim();
		}

		var generated = GenerateUserId();
		context.Response.Cookies.Append(
			_options.UserCookieName,
			generated,
			new CookieOptions
			{
				HttpOnly = true,
				Secure = context.Request.IsHttps,
				SameSite = SameSiteMode.Strict,
				Path = "/",
				IsEssential = true,
				MaxAge = TimeSpan.FromDays(365)
			});
		return generated;
	}

	private string? ResolveFromTrustedHeader(HttpRequest request)
	{
		if (!_options.EnableUserHeaderIdentity)
		{
			return null;
		}

		var headerName = _options.TrustedUserHeaderName;
		if (string.IsNullOrWhiteSpace(headerName) || !request.Headers.TryGetValue(headerName, out var value))
		{
			return null;
		}

		var raw = value.ToString().Trim();
		if (string.IsNullOrWhiteSpace(raw) || raw.Length > 200)
		{
			return null;
		}

		var isSafe = raw.All(ch =>
			(ch >= 'a' && ch <= 'z') ||
			(ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') ||
			ch == '_' ||
			ch == '-' ||
			ch == '.' ||
			ch == ':' ||
			ch == '@');
		return isSafe ? raw : null;
	}

	private static string GenerateUserId()
	{
		var bytes = RandomNumberGenerator.GetBytes(18);
		var base64 = Convert.ToBase64String(bytes);
		var token = base64.Replace('+', '-').Replace('/', '_').Replace("=", string.Empty);
		return $"u_{token}";
	}
}
