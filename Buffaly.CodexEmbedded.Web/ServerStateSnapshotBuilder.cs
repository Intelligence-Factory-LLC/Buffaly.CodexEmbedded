internal static class ServerStateSnapshotBuilder
{
	public static string NormalizeProjectCwd(string? cwd)
	{
		if (string.IsNullOrWhiteSpace(cwd))
		{
			return "(unknown)";
		}

		var normalized = cwd.Trim().Replace('\\', '/');
		normalized = normalized.TrimEnd('/');
		return string.IsNullOrWhiteSpace(normalized) ? "(unknown)" : normalized;
	}

	internal sealed record ServerSessionRow(
		string SessionId,
		string ThreadId,
		string? ThreadName,
		string? Cwd,
		string NormalizedCwd,
		string? Model,
		string? ReasoningEffort,
		bool IsTurnInFlight,
		bool IsTurnInFlightInferredFromLogs,
		bool IsTurnInFlightLogOnly,
		string State,
		int QueuedTurnCount,
		int TurnCountInMemory,
		ServerPendingApprovalRow? PendingApproval);

	internal sealed record ServerPendingApprovalRow(
		string ApprovalId,
		string RequestType,
		string Summary,
		string? Reason,
		string? Cwd,
		IReadOnlyList<string> Actions,
		string CreatedAtUtc);
}
