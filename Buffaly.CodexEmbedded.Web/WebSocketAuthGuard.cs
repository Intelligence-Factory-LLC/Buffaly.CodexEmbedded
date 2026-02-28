using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;

internal static class WebSocketAuthGuard
{
	private const string CookieName = "buffaly_ws_auth";
	private const string HeaderName = "X-Buffaly-Ws-Token";
	private const string QueryParameterName = "wsToken";

	public static void SetAuthCookie(HttpResponse response, string token, bool requestIsHttps)
	{
		response.Cookies.Append(
			CookieName,
			token,
			new CookieOptions
			{
				HttpOnly = true,
				Secure = requestIsHttps,
				SameSite = SameSiteMode.Strict,
				Path = "/"
			});
	}

	public static bool IsAuthorized(HttpRequest request, string expectedToken)
	{
		if (TryReadPresentedToken(request, out var presentedToken))
		{
			return TokensMatch(expectedToken, presentedToken);
		}

		return false;
	}

	private static bool TryReadPresentedToken(HttpRequest request, out string token)
	{
		token = string.Empty;

		if (request.Cookies.TryGetValue(CookieName, out var cookieToken) &&
			!string.IsNullOrWhiteSpace(cookieToken))
		{
			token = cookieToken.Trim();
			return true;
		}

		if (request.Headers.TryGetValue(HeaderName, out var headerValue) &&
			!string.IsNullOrWhiteSpace(headerValue))
		{
			token = headerValue.ToString().Trim();
			return true;
		}

		if (request.Query.TryGetValue(QueryParameterName, out var queryValue) &&
			!string.IsNullOrWhiteSpace(queryValue))
		{
			token = queryValue.ToString().Trim();
			return true;
		}

		return false;
	}

	private static bool TokensMatch(string expected, string actual)
	{
		var expectedBytes = Encoding.UTF8.GetBytes(expected);
		var actualBytes = Encoding.UTF8.GetBytes(actual);
		if (expectedBytes.Length != actualBytes.Length)
		{
			return false;
		}

		return CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
	}
}
