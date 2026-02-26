using System.Text;
using System.Text.Json;
using Buffaly.CodexEmbedded.Core;

internal sealed class RecapSettingsStore
{
	private readonly string _settingsFilePath;
	private readonly string _defaultReportsRootPath;
	private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
	{
		WriteIndented = false
	};
	private readonly object _sync = new();

	public RecapSettingsStore(IConfiguration configuration, WebRuntimeDefaults defaults)
	{
		_settingsFilePath = ResolveSettingsFilePath(configuration["RecapSettingsStoragePath"]);
		_defaultReportsRootPath = ResolveDefaultReportsRootPath(defaults);
	}

	public RecapSettingsSnapshot GetSnapshot()
	{
		lock (_sync)
		{
			var record = ReadRecordNoLock();
			return BuildSnapshotNoLock(record);
		}
	}

	public RecapSettingsSnapshot SaveReportsRootPath(string? reportsRootPath, bool useDefault)
	{
		lock (_sync)
		{
			var record = ReadRecordNoLock();
			if (useDefault)
			{
				record.ReportsRootPath = null;
			}
			else
			{
				record.ReportsRootPath = NormalizeAndValidateReportsRootPath(reportsRootPath);
			}

			WriteRecordNoLock(record);
			return BuildSnapshotNoLock(record);
		}
	}

	public string GetReportsRootPath()
	{
		return GetSnapshot().ReportsRootPath;
	}

	private RecapSettingsSnapshot BuildSnapshotNoLock(RecapSettingsRecord record)
	{
		var configured = record.ReportsRootPath;
		var effective = _defaultReportsRootPath;
		var isDefault = true;
		if (!string.IsNullOrWhiteSpace(configured))
		{
			try
			{
				effective = NormalizeAndValidateReportsRootPath(configured);
				isDefault = false;
			}
			catch
			{
				effective = _defaultReportsRootPath;
				isDefault = true;
			}
		}

		return new RecapSettingsSnapshot(
			ReportsRootPath: effective,
			DefaultReportsRootPath: _defaultReportsRootPath,
			IsDefault: isDefault,
			SettingsFilePath: _settingsFilePath);
	}

	private RecapSettingsRecord ReadRecordNoLock()
	{
		if (!File.Exists(_settingsFilePath))
		{
			return new RecapSettingsRecord();
		}

		try
		{
			var json = File.ReadAllText(_settingsFilePath);
			if (string.IsNullOrWhiteSpace(json))
			{
				return new RecapSettingsRecord();
			}

			return JsonSerializer.Deserialize<RecapSettingsRecord>(json, _jsonOptions) ?? new RecapSettingsRecord();
		}
		catch
		{
			return new RecapSettingsRecord();
		}
	}

	private void WriteRecordNoLock(RecapSettingsRecord record)
	{
		var directory = Path.GetDirectoryName(_settingsFilePath);
		if (!string.IsNullOrWhiteSpace(directory))
		{
			Directory.CreateDirectory(directory);
		}

		var json = JsonSerializer.Serialize(record, _jsonOptions);
		var tempPath = _settingsFilePath + ".tmp";
		File.WriteAllText(tempPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
		File.Move(tempPath, _settingsFilePath, overwrite: true);
	}

	private static string ResolveSettingsFilePath(string? configuredStoragePath)
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
		return Path.Combine(Path.GetFullPath(rootedStoragePath), "recap.settings.json");
	}

	private static string ResolveDefaultReportsRootPath(WebRuntimeDefaults defaults)
	{
		var codexHome = CodexHomePaths.ResolveCodexHomePath(defaults.CodexHomePath);
		var codexCandidate = string.IsNullOrWhiteSpace(codexHome)
			? string.Empty
			: Path.Combine(codexHome, "reports", "recap");
		if (!string.IsNullOrWhiteSpace(codexCandidate) &&
			!IsWithinPath(codexCandidate, Environment.CurrentDirectory))
		{
			return Path.GetFullPath(codexCandidate);
		}

		var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
		var fallback = Path.Combine(localAppData, "Buffaly.CodexEmbedded", "reports", "recap");
		return Path.GetFullPath(fallback);
	}

	private static string NormalizeAndValidateReportsRootPath(string? value)
	{
		var trimmed = value?.Trim() ?? string.Empty;
		if (string.IsNullOrWhiteSpace(trimmed))
		{
			throw new ArgumentException("reportsRootPath is required.");
		}

		var rootedPath = Path.GetFullPath(trimmed);
		if (IsWithinPath(rootedPath, Environment.CurrentDirectory))
		{
			throw new ArgumentException("reportsRootPath must be outside this repository directory.");
		}

		return rootedPath;
	}

	private static bool IsWithinPath(string candidatePath, string parentPath)
	{
		var normalizedCandidate = NormalizePath(candidatePath);
		var normalizedParent = NormalizePath(parentPath);
		if (string.Equals(normalizedCandidate, normalizedParent, StringComparison.OrdinalIgnoreCase))
		{
			return true;
		}

		if (!normalizedParent.EndsWith(Path.DirectorySeparatorChar))
		{
			normalizedParent += Path.DirectorySeparatorChar;
		}

		return normalizedCandidate.StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase);
	}

	private static string NormalizePath(string value)
	{
		var fullPath = Path.GetFullPath(value);
		return fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
	}
}

internal sealed class RecapSettingsRecord
{
	public string? ReportsRootPath { get; set; }
}

internal sealed record RecapSettingsSnapshot(
	string ReportsRootPath,
	string DefaultReportsRootPath,
	bool IsDefault,
	string SettingsFilePath);
