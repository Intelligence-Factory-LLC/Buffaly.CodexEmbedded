internal sealed class ServerRuntimeStateTracker
{
	private long _activeWebSocketConnections;
	private long _totalWebSocketConnectionsAccepted;
	private long _startedAtUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
	private long _lastWebSocketAcceptedUnixSeconds;

	public void OnWebSocketAccepted()
	{
		Interlocked.Increment(ref _activeWebSocketConnections);
		Interlocked.Increment(ref _totalWebSocketConnectionsAccepted);
		Interlocked.Exchange(ref _lastWebSocketAcceptedUnixSeconds, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
	}

	public void OnWebSocketClosed()
	{
		var active = Interlocked.Decrement(ref _activeWebSocketConnections);
		if (active < 0)
		{
			Interlocked.Exchange(ref _activeWebSocketConnections, 0);
		}
	}

	public ServerRuntimeSnapshot GetSnapshot(DateTimeOffset capturedAtUtc)
	{
		var startedAtUnix = Interlocked.Read(ref _startedAtUnixSeconds);
		var startedAtUtc = DateTimeOffset.FromUnixTimeSeconds(startedAtUnix);
		var lastAcceptedUnix = Interlocked.Read(ref _lastWebSocketAcceptedUnixSeconds);
		var lastAcceptedUtc = lastAcceptedUnix > 0 ? DateTimeOffset.FromUnixTimeSeconds(lastAcceptedUnix) : (DateTimeOffset?)null;
		var uptimeSeconds = Math.Max(0, (long)(capturedAtUtc - startedAtUtc).TotalSeconds);

		return new ServerRuntimeSnapshot(
			StartedAtUtc: startedAtUtc,
			UptimeSeconds: uptimeSeconds,
			ActiveWebSocketConnections: Math.Max(0, (int)Interlocked.Read(ref _activeWebSocketConnections)),
			TotalWebSocketConnectionsAccepted: Math.Max(0, (int)Interlocked.Read(ref _totalWebSocketConnectionsAccepted)),
			LastWebSocketAcceptedUtc: lastAcceptedUtc);
	}

	internal sealed record ServerRuntimeSnapshot(
		DateTimeOffset StartedAtUtc,
		long UptimeSeconds,
		int ActiveWebSocketConnections,
		int TotalWebSocketConnectionsAccepted,
		DateTimeOffset? LastWebSocketAcceptedUtc);
}

internal sealed record OpenAiKeyUpdateRequest(string? ApiKey);

internal sealed record RecapSettingsUpdateRequest(
	string? ReportsRootPath = null,
	bool UseDefault = false);

internal sealed record RecapExportRequest(
	string? StartUtc,
	string? EndUtc,
	string[]? Projects,
	string? DetailLevel);

internal sealed record RecapExportEntry(
	DateTimeOffset TimestampUtc,
	string Role,
	string Label,
	string Text);

internal sealed record RecapReportBuildResult(
	string Markdown,
	int ProjectCount,
	int SessionCount,
	int EntryCount);
