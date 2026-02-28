using System.Globalization;
using Microsoft.Extensions.Primitives;

internal static class QueryValueParser
{
	public static int GetPositiveInt(StringValues rawValues, int fallback, int max)
	{
		var raw = rawValues.ToString();
		if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) || parsed <= 0)
		{
			return fallback;
		}

		return Math.Min(parsed, max);
	}

	public static bool GetBool(StringValues rawValues)
	{
		var raw = rawValues.ToString();
		return raw.Equals("1", StringComparison.Ordinal) ||
			raw.Equals("true", StringComparison.OrdinalIgnoreCase) ||
			raw.Equals("yes", StringComparison.OrdinalIgnoreCase);
	}
}
