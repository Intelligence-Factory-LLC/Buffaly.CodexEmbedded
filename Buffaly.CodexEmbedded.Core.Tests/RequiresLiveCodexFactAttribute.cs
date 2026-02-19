using Xunit;

namespace Buffaly.CodexEmbedded.Core.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
internal sealed class RequiresLiveCodexFactAttribute : FactAttribute
{
	public RequiresLiveCodexFactAttribute()
	{
		if (!TestRuntime.IsLiveCodexTestsEnabled())
		{
			Skip = "Set Buffaly.CodexEmbedded.Core.Tests/appsettings.json: RunLiveCodexTests = 1 to run live Codex connectivity tests.";
		}
	}
}

