using System.Text.Json;

internal static class WebCodexUtils
{
	public static List<string> GetCommandActionSummaries(JsonElement paramsElement)
	{
		var output = new List<string>();
		if (paramsElement.ValueKind != JsonValueKind.Object)
		{
			return output;
		}

		if (!paramsElement.TryGetProperty("commandActions", out var actionsElement) || actionsElement.ValueKind != JsonValueKind.Array)
		{
			return output;
		}

		foreach (var action in actionsElement.EnumerateArray())
		{
			var type = TryGetPathString(action, "type") ?? "unknown";
			var path = TryGetPathString(action, "path");
			var name = TryGetPathString(action, "name");
			var query = TryGetPathString(action, "query");

			switch (type)
			{
				case "read":
					output.Add($"read {(name ?? path ?? "(path unknown)")}");
					break;
				case "listFiles":
					output.Add($"listFiles {(path ?? "(path unknown)")}");
					break;
				case "search":
					output.Add($"search {(query ?? "(query unknown)")} in {(path ?? "(path unknown)")}");
					break;
				default:
					output.Add(type);
					break;
			}
		}

		return output;
	}

	public static string? TryGetPathString(JsonElement root, params string[] path)
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

	public static string? NormalizeReasoningEffort(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant();
		return normalized switch
		{
			"none" => "none",
			"minimal" => "minimal",
			"low" => "low",
			"medium" => "medium",
			"high" => "high",
			"xhigh" => "xhigh",
			_ => null
		};
	}

	public static string? NormalizeApprovalPolicy(string? value, bool allowInherit = true)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant().Replace("_", "-");
		if (allowInherit && normalized == "inherit")
		{
			return null;
		}

		return normalized switch
		{
			"untrusted" => "untrusted",
			"on-failure" => "on-failure",
			"onfailure" => "on-failure",
			"on-request" => "on-request",
			"onrequest" => "on-request",
			"never" => "never",
			_ => null
		};
	}

	public static string? NormalizeSandboxMode(string? value, bool allowInherit = true)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant().Replace("_", "-");
		if (allowInherit && normalized == "inherit")
		{
			return null;
		}

		return normalized switch
		{
			"read-only" => "read-only",
			"readonly" => "read-only",
			"read only" => "read-only",
			"workspace-write" => "workspace-write",
			"workspacewrite" => "workspace-write",
			"workspace write" => "workspace-write",
			"danger-full-access" => "danger-full-access",
			"dangerfullaccess" => "danger-full-access",
			"danger full access" => "danger-full-access",
			"dangerfull" => "danger-full-access",
			"none" => "none",
			"no-sandbox" => "none",
			"nosandbox" => "none",
			"external-sandbox" => "external-sandbox",
			"externalsandbox" => "external-sandbox",
			_ => null
		};
	}

	public static string? NormalizeCollaborationMode(string? value, bool allowDefault = true)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		var normalized = value.Trim().ToLowerInvariant().Replace("_", "-");
		return normalized switch
		{
			"plan" => "plan",
			"default" when allowDefault => "default",
			_ => null
		};
	}
}
