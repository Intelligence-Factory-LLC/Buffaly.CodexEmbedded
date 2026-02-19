using System.Text.Json;

namespace Buffaly.CodexEmbedded.Core;

internal static class JsonPath
{
	public static string GetRequiredString(JsonElement root, params string[] path)
	{
		var value = TryGetString(root, path);
		if (string.IsNullOrWhiteSpace(value))
		{
			throw new InvalidOperationException($"Missing required JSON path: {string.Join(".", path)}");
		}
		return value;
	}

	public static string? TryGetString(JsonElement root, params string[] path)
	{
		var current = root;
		foreach (var segment in path)
		{
			if (current.ValueKind != JsonValueKind.Object)
			{
				return null;
			}

			if (!current.TryGetProperty(segment, out current))
			{
				return null;
			}
		}

		return current.ValueKind switch
		{
			JsonValueKind.String => current.GetString(),
			JsonValueKind.Null => null,
			_ => current.ToString()
		};
	}

	public static string? TryGetString(JsonElement root, string segment)
	{
		if (root.ValueKind != JsonValueKind.Object)
		{
			return null;
		}
		if (!root.TryGetProperty(segment, out var value))
		{
			return null;
		}
		return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
	}
}


