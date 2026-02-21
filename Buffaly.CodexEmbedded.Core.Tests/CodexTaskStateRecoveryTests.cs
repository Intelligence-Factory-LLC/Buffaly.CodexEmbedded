using Buffaly.CodexEmbedded.Core;
using Xunit;

namespace Buffaly.CodexEmbedded.Core.Tests;

public sealed class CodexTaskStateRecoveryTests
{
	[Fact]
	public void AnalyzeJsonLines_ComputesOutstandingTaskCount()
	{
		var lines = new[]
		{
			TaskEvent("2026-02-21T22:00:00Z", "task_started"),
			TaskEvent("2026-02-21T22:00:10Z", "task_started"),
			TaskEvent("2026-02-21T22:00:20Z", "task_complete")
		};

		var analysis = CodexTaskStateRecovery.AnalyzeJsonLines(lines);

		Assert.Equal(1, analysis.OutstandingTaskCount);
		Assert.Equal(DateTimeOffset.Parse("2026-02-21T22:00:10Z"), analysis.LastTaskStartedAtUtc);
		Assert.Equal(DateTimeOffset.Parse("2026-02-21T22:00:20Z"), analysis.LastTaskCompletedAtUtc);
		Assert.Equal(DateTimeOffset.Parse("2026-02-21T22:00:20Z"), analysis.LastTaskEventAtUtc);
	}

	[Fact]
	public void AnalyzeJsonLines_DoesNotAllowNegativeOutstandingTaskCount()
	{
		var lines = new[]
		{
			TaskEvent("2026-02-21T22:00:00Z", "task_complete"),
			TaskEvent("2026-02-21T22:00:10Z", "task_complete")
		};

		var analysis = CodexTaskStateRecovery.AnalyzeJsonLines(lines);

		Assert.Equal(0, analysis.OutstandingTaskCount);
		Assert.True(analysis.LastTaskCompletedAtUtc.HasValue);
	}

	[Fact]
	public void AnalyzeJsonLines_IgnoresNonTaskEvents()
	{
		var lines = new[]
		{
			"{\"timestamp\":\"2026-02-21T22:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}",
			"{\"timestamp\":\"2026-02-21T22:00:05Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"x\"}}",
			"not json at all"
		};

		var analysis = CodexTaskStateRecovery.AnalyzeJsonLines(lines);

		Assert.Equal(0, analysis.OutstandingTaskCount);
		Assert.Null(analysis.LastTaskEventAtUtc);
	}

	[Fact]
	public void IsLikelyProcessing_ReturnsTrueWhenOutstandingAndRecent()
	{
		var analysis = new CodexTaskRecoveryAnalysis(
			OutstandingTaskCount: 1,
			LastTaskStartedAtUtc: DateTimeOffset.Parse("2026-02-21T22:00:00Z"),
			LastTaskCompletedAtUtc: null,
			LastTaskEventAtUtc: DateTimeOffset.Parse("2026-02-21T22:01:00Z"));

		var isProcessing = CodexTaskStateRecovery.IsLikelyProcessing(
			analysis,
			nowUtc: DateTimeOffset.Parse("2026-02-21T22:01:30Z"),
			staleAfter: TimeSpan.FromMinutes(5));

		Assert.True(isProcessing);
	}

	[Fact]
	public void IsLikelyProcessing_ReturnsFalseWhenOutstandingButStale()
	{
		var analysis = new CodexTaskRecoveryAnalysis(
			OutstandingTaskCount: 1,
			LastTaskStartedAtUtc: DateTimeOffset.Parse("2026-02-21T22:00:00Z"),
			LastTaskCompletedAtUtc: null,
			LastTaskEventAtUtc: DateTimeOffset.Parse("2026-02-21T22:01:00Z"));

		var isProcessing = CodexTaskStateRecovery.IsLikelyProcessing(
			analysis,
			nowUtc: DateTimeOffset.Parse("2026-02-21T22:20:00Z"),
			staleAfter: TimeSpan.FromMinutes(5));

		Assert.False(isProcessing);
	}

	private static string TaskEvent(string timestamp, string eventType)
	{
		return $"{{\"timestamp\":\"{timestamp}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"{eventType}\"}}}}";
	}
}
