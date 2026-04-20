# Turn-Based Session History Design

## Background and Problem Statement
Buffaly timeline history is currently message-first. The UI depends on message retrieval APIs such as `GetSessionRefresh`, `GetAgentMessagesSince`, and `GetAgentMessagesBefore`, then applies compaction and prepend logic client-side. This causes:
- Heavy payloads for large sessions because old history is transferred as detailed message rows.
- Complex UI state transitions for append, prepend, and compaction.
- Weak separation between what is needed for collapsed history view and what is needed for expanded detail view.

The target is to migrate history UI behavior to turn-based retrieval with summary-first rendering and on-demand detail expansion while keeping typed contracts and fail-fast binding.

## Goals
- Replace message-based history rendering with turn-based summary/detail rendering.
- Return turn summaries for list/history views by default.
- Define summary as first user message and last assistant message if present.
- Load full turn detail only when a turn is expanded.
- Keep old historical turns collapsed by default.
- Use one authoritative typed C# contract path per flow with PascalCase properties.
- Keep polling/watch idempotent and cursor-based.
- Persist only summary data in a very small local cache; keep detail in memory only.
- Preserve existing message APIs during migration, but switch history UI to turn-based contracts.

## Non-Goals
- Rewriting model execution or tool runtime behavior.
- Introducing compatibility normalizers, alternate casing, or multi-shape parsing.
- Maintaining dual typed contracts for the same turn flow.
- Large storage redesign beyond what is needed for turn projection and retrieval.

## Authoritative Reference Model from Buffaly.CodexEmbedded

Primary reference implementation:
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\SessionOrchestrator.cs`
  - `WatchTurns(...)`: cursor-driven watch flow with `Noop`, `Incremental`, `Full` behavior.
  - `GetTurnDetail(...)`: on-demand detail retrieval for a specific `TurnId`.
  - `ToSummaryTurn(...)`: summary projection builder.
  - `ToWatchActiveTurnDetail(...)`: active turn metadata in watch responses.
  - `ThreadTurnCacheState`: per-thread in-memory turn projection cache.
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\WebEndpointMappings.cs`
  - `/api/turns/bootstrap`
  - `/api/turns/watch`
  - `/api/turns/detail`
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\TimelineProjection.cs`
  - projection from timeline protocol events to turn-level state.
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\wwwroot\app.js`
  - `mergeIncomingTurnsWithExisting`
  - `mergeTurnWithDetail`
  - `fetchTurnDetailForThread`
  - `rememberTimelineCache`
  - `restoreTimelineFromCache`
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\wwwroot\sessionTimeline.js`
  - collapsed-by-default turn rendering
  - expand action dispatching detail request only when needed

Reference pattern to adopt:
- Bootstrap and watch operate on summary contracts.
- Detail is loaded separately and merged by `TurnId`.
- Cursor-based watch is authoritative for idempotent updates.
- Cache stores summary-level payloads, not full detail payloads.

## Current Buffaly Architecture Findings

### Core and Session Projection
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\SessionObject.cs`
  - `TimelineMessages` and row-centric snapshot/load/prepend operations.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\TimelineRowSnapshot.cs`
  - row snapshot shape used across layers.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\TooledAgent.cs`
  - runtime append of timeline events and messages.

### Host and Service APIs
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\Services\BuffalyAgentService.cs`
  - `GetSessionRefresh`
  - `GetAgentMessagesSince`
  - `GetAgentMessagesBefore`
  - `GetAgentMessagePage`
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\Services\BuffalyAgentService.Private.cs`
  - `BuildSessionRefreshContract(...)`
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Contracts\AgentServiceContracts.cs`
  - session refresh contract structure currently includes message timeline data.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Contracts\MessagesSinceResponse.cs`
  - message delta/full paging semantics.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Services\SessionTimelineRowContractMapper.cs`
  - row mapping path for timeline contracts.

### Session Store and History Retrieval
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\SessionStoreProviders.cs`
  - `ISessionStore` message retrieval signatures.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\Sessions.cs`
  - pass-through for message retrieval and row lookup.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\SqlSessionStore.cs`
  - SQL and cache retrieval of message pages before/since/latest.

### Web UI, Timeline, History Loading, and Transport
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-session-refresh.js`
  - poll/refresh cycle bound to `GetSessionRefresh` timeline payloads.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-timeline.js`
  - render and append logic expects message rows.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-timeline-compaction.js`
  - history prepend via `GetAgentMessagesBefore`.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-ops-service-router.js`
  - route table for ops methods and service calls.

## Proposed Typed Contracts and API Surface

### Recommended API Method Names
- `GetSessionTurnBootstrap`
- `WatchSessionTurns`
- `GetSessionTurnDetail`

### Recommended C# Request and Response DTOs (PascalCase)

```csharp
public sealed class GetSessionTurnBootstrapRequest
{
	public string SessionId { get; init; } = string.Empty;
	public int MaxTurns { get; init; }
}

public sealed class GetSessionTurnBootstrapResponse
{
	public string SessionId { get; init; } = string.Empty;
	public string NextCursor { get; init; } = string.Empty;
	public IReadOnlyList<TurnSummaryContract> Turns { get; init; } = Array.Empty<TurnSummaryContract>();
	public ActiveTurnContract? ActiveTurn { get; init; }
}

public sealed class WatchSessionTurnsRequest
{
	public string SessionId { get; init; } = string.Empty;
	public string Cursor { get; init; } = string.Empty;
	public int MaxTurns { get; init; }
}

public sealed class WatchSessionTurnsResponse
{
	public string SessionId { get; init; } = string.Empty;
	public string Mode { get; init; } = string.Empty; // Noop | Incremental | Full
	public string NextCursor { get; init; } = string.Empty;
	public IReadOnlyList<TurnSummaryContract> Turns { get; init; } = Array.Empty<TurnSummaryContract>();
	public ActiveTurnContract? ActiveTurn { get; init; }
}

public sealed class GetSessionTurnDetailRequest
{
	public string SessionId { get; init; } = string.Empty;
	public string TurnId { get; init; } = string.Empty;
}

public sealed class GetSessionTurnDetailResponse
{
	public string SessionId { get; init; } = string.Empty;
	public TurnDetailContract Turn { get; init; } = new TurnDetailContract();
}

public sealed class TurnSummaryContract
{
	public string TurnId { get; init; } = string.Empty;
	public DateTime StartedAtUtc { get; init; }
	public DateTime? CompletedAtUtc { get; init; }
	public string Status { get; init; } = string.Empty;
	public string FirstUserMessageText { get; init; } = string.Empty;
	public string? LastAssistantMessageText { get; init; }
	public bool HasDetail { get; init; }
	public bool DetailLoaded { get; init; }
}

public sealed class TurnDetailContract
{
	public string TurnId { get; init; } = string.Empty;
	public DateTime StartedAtUtc { get; init; }
	public DateTime? CompletedAtUtc { get; init; }
	public string Status { get; init; } = string.Empty;
	public IReadOnlyList<TurnDetailMessageContract> Messages { get; init; } = Array.Empty<TurnDetailMessageContract>();
	public IReadOnlyList<TurnDetailEventContract> Events { get; init; } = Array.Empty<TurnDetailEventContract>();
}
```

### Contract Rules
- One typed contract path end-to-end.
- No alternate casing.
- No fallback readers.
- Invalid bind must fail immediately with diagnostics.

## Server-Side Design by Layer

### Core Session Projection Layer
Target areas:
- `Buffaly.Agent.Core\SessionObject.cs`
- `Buffaly.Agent.Core\TimelineRowSnapshot.cs`
- `Buffaly.Agent.Core\TooledAgent.cs`

Changes:
- Add deterministic turn projection helper over timeline rows.
- Projection computes summary text fields:
  - first user message
  - last assistant message if present
- Preserve detailed rows/events for detail retrieval by `TurnId`.
- Keep projection pure and deterministic for testability.

### Host and Service Endpoints Layer
Target areas:
- `Buffaly.Agent.Host\OpsAgent\Contracts\AgentServiceContracts.cs`
- `Buffaly.Agent.Host\Services\BuffalyAgentService.cs`
- `Buffaly.Agent.Host\Services\BuffalyAgentService.Private.cs`

Changes:
- Add typed request/response DTOs for bootstrap/watch/detail.
- Add service methods for the three new turn endpoints.
- Keep `GetSessionRefresh` and message APIs during migration, but stop using them for history UI path.
- Ensure fail-fast model binding and explicit error diagnostics.

### Session Management and Persistence Layer
Target areas:
- `Buffaly.Agent.Host\SessionManagement\SessionStoreProviders.cs`
- `Buffaly.Agent.Host\SessionManagement\Sessions.cs`
- `Buffaly.Agent.Host\SessionManagement\SqlSessionStore.cs`

Changes:
- Add store interfaces for turn summary bootstrap/watch and turn detail by `TurnId`.
- Implement cursor generation and idempotent watch semantics.
- Support retrieval of turn summaries without loading full detail payload.
- Keep detailed turn payload retrieval on explicit request.

### Generated Stubs and Contracts Expectations
Target areas:
- Generated JsonWs stubs used by web modules.

Changes:
- Generate stubs directly from new authoritative typed C# contracts.
- UI must call generated async methods directly.
- No handwritten payload wrappers for contract-backed methods.

## Client and UI Design by Module

### Session Refresh and Polling
Target area:
- `buffaly.agent.web\wwwroot\js\buffaly-agent-session-refresh.js`

Changes:
- Keep session status polling responsibilities from `GetSessionRefresh` only as needed for non-history status.
- Add turn timeline poll cycle:
  - bootstrap once per session attach/select
  - watch loop with `Cursor`
  - apply `Noop`, `Incremental`, `Full` semantics

### Timeline Rendering
Target area:
- `buffaly.agent.web\wwwroot\js\buffaly-agent-timeline.js`

Changes:
- Render turn summary cards collapsed by default.
- Historical turns remain collapsed by default.
- Expand action triggers `GetSessionTurnDetail` if not loaded.
- Merge detail into existing turn state by `TurnId`.
- Do not refetch detail once loaded unless explicitly invalidated.

### History Loading and Compaction
Target area:
- `buffaly.agent.web\wwwroot\js\buffaly-agent-timeline-compaction.js`

Changes:
- Replace message prepend workflow with turn summary continuation behavior.
- Remove dependency on `GetAgentMessagesBefore` for history UI path.
- Retain compaction behavior at turn summary level only.

### Transport Routing
Target area:
- `buffaly.agent.web\wwwroot\js\buffaly-agent-ops-service-router.js`

Changes:
- Add route methods for bootstrap/watch/detail contracts.
- Keep message API routes for migration compatibility callers.

## UI State Model
Per session:
- `OrderedTurnIds`
- `TurnSummariesById`
- `TurnDetailsById` (in memory only)
- `WatchCursor`
- `ExpandedTurnIds`

Behavior:
- Initial render uses summary list only.
- Expansion checks `TurnDetailsById` and loads detail if absent.
- Watch updates merge summaries and preserve user expansion choices.

## Caching and Persistence Strategy
- Persist summary data only.
- Persist very small recent cache only (recommended defaults):
  - last 3 sessions
  - up to 100 turn summaries per session
- Persist no detail payloads.
- In-memory detail cache is evicted on session switch or page reload.
- Use explicit cache version key and fail-fast reset when version mismatches.

## Diagnostics and Observability
- Add explicit logs for:
  - bootstrap request and result counts
  - watch mode transitions (`Noop`, `Incremental`, `Full`)
  - detail fetch by `TurnId`
  - contract bind failures with method and field names
- Maintain concise timeline metadata visibility while suppressing noisy transport-only lines.

## Migration Plan

### Phase 1: Contracts and Service Readiness
- Add typed turn contracts and service/store methods.
- Keep message APIs unchanged.

### Phase 2: UI Dual Wiring
- Add turn bootstrap/watch/detail UI path behind feature flag.
- Continue existing message path for rollback.

### Phase 3: Default Switch
- Enable turn-based history UI as default.
- Keep message APIs available for non-history consumers.

### Phase 4: Cleanup
- Remove message-history UI dependencies (`GetAgentMessagesBefore`, message prepend path).
- Retain or retire old methods based on caller inventory.

## Rollout and Compatibility Plan
- Compatibility is endpoint-level, not payload-shape normalization.
- During rollout:
  - message APIs remain callable
  - history UI uses turn APIs
- Any mismatch with new contracts must fail fast.
- No dual-shape parsing in JS or C#.

## Risks and Mitigations
- Risk: projection ambiguity on complex tool-heavy turns.
  - Mitigation: deterministic projection rules and regression tests for ordering.
- Risk: cursor bugs causing duplicate or missing updates.
  - Mitigation: explicit watch mode contract and replay tests.
- Risk: stale summary cache divergence.
  - Mitigation: small cache scope, versioned key, bootstrap reconciliation.
- Risk: accidental detail over-fetch.
  - Mitigation: strict separation between summary DTO and detail DTO.

## Acceptance Test Matrix

### Backend Projection
- Summary extraction uses first user message and last assistant message if present.
- Summary extraction with no assistant sets `LastAssistantMessageText` to null.
- Detail retrieval returns full ordered turn content for requested `TurnId`.

### API Contract and Binding
- Valid PascalCase payload binds successfully.
- Missing required contract members fail with explicit error diagnostics.
- Watch responses correctly enforce `Mode`, `NextCursor`, and turn set behavior.

### Polling and Watch Behavior
- Bootstrap seeds initial turn list and cursor.
- `Noop` watch result does not mutate timeline state.
- `Incremental` updates merge changed/new summaries only.
- `Full` refresh replaces summary set consistently.

### UI Rendering
- Old historical turns render collapsed by default.
- Summary card shows first user and last assistant snippets.
- Expanding non-loaded turn fetches detail once and renders full content.
- Re-expanding loaded turn uses in-memory detail without refetch.

### Cache Behavior
- Persisted cache contains summaries only.
- Persisted cache is limited to very small recent scope.
- Detail is not persisted across reload.
- Cache version mismatch clears cache and reboots from bootstrap.

### Migration and Compatibility
- With feature flag off, existing message history UI remains functional.
- With feature flag on, history UI uses turn endpoints exclusively.
- Message APIs remain available for migration period callers.

### Diagnostics
- Contract bind failures emit actionable logs.
- Watch mode and cursor progression are logged for traceability.

## File-by-File Implementation Checklist
- `Buffaly.Agent.Core\SessionObject.cs`: add turn projection entry points.
- `Buffaly.Agent.Core\TimelineRowSnapshot.cs`: confirm detail mapping source coverage.
- `Buffaly.Agent.Core\TooledAgent.cs`: verify turn boundary markers remain stable.
- `Buffaly.Agent.Host\OpsAgent\Contracts\AgentServiceContracts.cs`: add authoritative turn DTOs.
- `Buffaly.Agent.Host\Services\BuffalyAgentService.cs`: add typed turn methods.
- `Buffaly.Agent.Host\Services\BuffalyAgentService.Private.cs`: add projection-to-contract shaping helpers.
- `Buffaly.Agent.Host\SessionManagement\SessionStoreProviders.cs`: add turn-focused store interface methods.
- `Buffaly.Agent.Host\SessionManagement\Sessions.cs`: add pass-through methods for turn APIs.
- `Buffaly.Agent.Host\SessionManagement\SqlSessionStore.cs`: implement summary watch and detail retrieval.
- `buffaly.agent.web\wwwroot\js\buffaly-agent-ops-service-router.js`: add routes for turn endpoints.
- `buffaly.agent.web\wwwroot\js\buffaly-agent-session-refresh.js`: add bootstrap/watch orchestration.
- `buffaly.agent.web\wwwroot\js\buffaly-agent-timeline.js`: summary render and expand-on-demand detail.
- `buffaly.agent.web\wwwroot\js\buffaly-agent-timeline-compaction.js`: move from message prepend to turn summary flow.

## Notes on Existing APIs During Migration
- `GetSessionRefresh`, `GetAgentMessagesSince`, `GetAgentMessagesBefore` remain present during migration.
- History UI should switch to `GetSessionTurnBootstrap`, `WatchSessionTurns`, and `GetSessionTurnDetail`.
- No compatibility wrappers should be introduced between old and new contracts.
