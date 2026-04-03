using System.Text;
using System.Text.Json;

internal sealed class RateLimitSnapshotStore
{
	private readonly string _filePath;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
	{
		WriteIndented = false
	};
	private readonly object _sync = new();

	public RateLimitSnapshotStore(IConfiguration configuration)
	{
		_filePath = ResolveFilePath(configuration["RateLimitSnapshotStoragePath"]);
	}

	public IReadOnlyList<PersistedRateLimitSnapshot> ReadSnapshots()
	{
		lock (_sync)
		{
			if (!File.Exists(_filePath))
			{
				return Array.Empty<PersistedRateLimitSnapshot>();
			}

			try
			{
				var json = File.ReadAllText(_filePath);
				if (string.IsNullOrWhiteSpace(json))
				{
					return Array.Empty<PersistedRateLimitSnapshot>();
				}

				var payload = JsonSerializer.Deserialize<RateLimitSnapshotStorePayload>(json, _jsonOptions);
				return payload?.Snapshots?
					.Where(x => x is not null && !string.IsNullOrWhiteSpace(x.SessionId))
					.Select(x => x!)
					.ToArray()
					?? Array.Empty<PersistedRateLimitSnapshot>();
			}
			catch
			{
				return Array.Empty<PersistedRateLimitSnapshot>();
			}
		}
	}

	public void WriteSnapshots(IReadOnlyList<PersistedRateLimitSnapshot> snapshots)
	{
		lock (_sync)
		{
			var directory = Path.GetDirectoryName(_filePath);
			if (!string.IsNullOrWhiteSpace(directory))
			{
				Directory.CreateDirectory(directory);
			}

			var payload = new RateLimitSnapshotStorePayload
			{
				UpdatedAtUtc = DateTimeOffset.UtcNow,
				Snapshots = snapshots
					.Where(x => x is not null && !string.IsNullOrWhiteSpace(x.SessionId))
					.OrderByDescending(x => x.UpdatedAtUtc)
					.ThenBy(x => x.SessionId, StringComparer.Ordinal)
					.Take(256)
					.ToArray()
			};

			var json = JsonSerializer.Serialize(payload, _jsonOptions);
			var tempPath = _filePath + ".tmp";
			File.WriteAllText(tempPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
			File.Move(tempPath, _filePath, overwrite: true);
		}
	}

	private static string ResolveFilePath(string? configuredStoragePath)
	{
		var storagePath = configuredStoragePath;
		if (string.IsNullOrWhiteSpace(storagePath))
		{
			var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
			storagePath = Path.Combine(localAppData, "Buffaly.CodexEmbedded", "settings");
		}

		var rootedStoragePath = Path.IsPathRooted(storagePath)
			? storagePath
			: Path.Combine(Environment.CurrentDirectory, storagePath);
		return Path.Combine(Path.GetFullPath(rootedStoragePath), "rate-limit-snapshots.json");
	}
}

internal sealed class RateLimitSnapshotStorePayload
{
	public DateTimeOffset UpdatedAtUtc { get; set; }
	public PersistedRateLimitSnapshot[] Snapshots { get; set; } = Array.Empty<PersistedRateLimitSnapshot>();
}

internal sealed record PersistedRateLimitSnapshot(
	string SessionId,
	string ThreadId,
	string? Scope,
	double? Remaining,
	double? Limit,
	double? Used,
	double? RetryAfterSeconds,
	DateTimeOffset? ResetAtUtc,
	PersistedRateLimitWindowSnapshot? Primary,
	PersistedRateLimitWindowSnapshot? Secondary,
	string? PlanType,
	bool? HasCredits,
	bool? UnlimitedCredits,
	double? CreditBalance,
	string Summary,
	string Source,
	DateTimeOffset UpdatedAtUtc);

internal sealed record PersistedRateLimitWindowSnapshot(
	double? UsedPercent,
	double? RemainingPercent,
	double? WindowMinutes,
	DateTimeOffset? ResetsAtUtc);
