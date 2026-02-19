namespace Buffaly.CodexEmbedded.Core;

public enum CodexEventVerbosity
{
	Errors = 0,
	Normal = 1,
	Verbose = 2,
	Trace = 3
}

public static class CodexEventLogging
{
	public static bool TryParseVerbosity(string? value, out CodexEventVerbosity verbosity)
	{
		verbosity = CodexEventVerbosity.Normal;
		if (string.IsNullOrWhiteSpace(value))
		{
			return false;
		}

		switch (value.Trim().ToLowerInvariant())
		{
			case "errors":
			case "error":
				verbosity = CodexEventVerbosity.Errors;
				return true;
			case "normal":
				verbosity = CodexEventVerbosity.Normal;
				return true;
			case "verbose":
				verbosity = CodexEventVerbosity.Verbose;
				return true;
			case "trace":
			case "all":
				verbosity = CodexEventVerbosity.Trace;
				return true;
			default:
				return false;
		}
	}

	public static bool ShouldInclude(CodexCoreEvent ev, CodexEventVerbosity verbosity)
	{
		if (verbosity >= CodexEventVerbosity.Trace)
		{
			return true;
		}

		if (verbosity >= CodexEventVerbosity.Verbose)
		{
			// Raw JSONL can be very noisy; include it only at trace.
			return !string.Equals(ev.Type, "stdout_jsonl", StringComparison.Ordinal);
		}

		var isError = string.Equals(ev.Level, "error", StringComparison.OrdinalIgnoreCase);
		var isWarn = string.Equals(ev.Level, "warn", StringComparison.OrdinalIgnoreCase);
		if (verbosity == CodexEventVerbosity.Errors)
		{
			return isError || isWarn;
		}

		if (isError || isWarn)
		{
			return true;
		}

		return ev.Type switch
		{
			"stderr_line" => true,
			"stdout_pump_failed" => true,
			"stderr_pump_failed" => true,
			"stdout_parse_failed" => true,
			"notification_handler_failed" => true,
			"server_request_handler_failed" => true,
			_ => false
		};
	}

	public static string Format(CodexCoreEvent ev, bool includeTimestamp = true)
	{
		if (includeTimestamp)
		{
			return $"{ev.Timestamp:O} [{ev.Level}] {ev.Type}: {ev.Message}";
		}

		return $"[{ev.Level}] {ev.Type}: {ev.Message}";
	}
}
