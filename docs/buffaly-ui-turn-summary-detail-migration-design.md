# Buffaly UI Migration Design - Turn Summary and On-Demand Turn Detail

## 1) Problem Statement and Goals

### Problem
Buffaly currently retrieves and renders history as message pages (`GetSessionRefresh`, `GetAgentMessagesBefore`, `GetAgentMessagesSince`). This creates three recurring issues:
- Expensive payloads for old sessions because all timeline message rows are treated as render-ready detail.
- UI complexity in compaction and prepend flows because history retrieval is message-first, not turn-first.
- Weak separation between list view data and expanded detail data, which limits fast initial render for long histories.

### Goals
- Move from message-based history retrieval to turn-based retrieval with one authoritative typed contract path.
- Return turn summaries by default, where summary is first user message plus last assistant message if present.
- Load full detail only on user expansion of a turn.
- Render old historical turns collapsed by default.
- Keep poll/watch idempotent and incremental.
- Persist only summary data for a small recent cache set.
- Preserve PascalCase contract names end-to-end with fail-fast binding.

## 2) Non-Goals
- Reworking model execution or tool call runtime behavior in `TooledAgent`.
- Changing SQL schema beyond fields required for the new typed turn summary/detail flow.
- Adding compatibility normalization, dual casing, or multi-shape payload readers.
- Introducing parallel DTO stacks for the same flow.

## 3) Reference Findings from Buffaly.CodexEmbedded

Authoritative implementation evidence:
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\SessionOrchestrator.cs`
  - `WatchTurns(...)` creates incremental watch snapshots keyed by cursor and mode (`noop`, `incremental`, `full`).
  - `GetTurnDetail(...)` resolves one turn and returns full projection only when requested.
  - `ToSummaryTurn(...)` builds compact turn summary projection.
  - `ToWatchActiveTurnDetail(...)` carries active turn detail metadata in watch response.
  - `ThreadTurnCacheState` tracks per-thread projected turn cache and cursor state.
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\WebEndpointMappings.cs`
  - `/api/turns/bootstrap` returns initial summary snapshot.
  - `/api/turns/watch` returns incremental/full/noop updates with cursor.
  - `/api/turns/detail` returns full detail for one turn.
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\TimelineProjection.cs`
  - Projects transport events (`session_meta`, `turn_context`, `response_item`, `event_msg`) into turn-level structures.
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\wwwroot\app.js`
  - `mergeIncomingTurnsWithExisting`, `mergeTurnWithDetail`, `fetchTurnDetailForThread`, `rememberTimelineCache`, `restoreTimelineFromCache`.
  - Bootstrap then watch polling loop with cursor and explicit mode handling.
- `C:\dev\Buffaly.CodexEmbedded\Buffaly.CodexEmbedded.Web\wwwroot\sessionTimeline.js`
  - Collapsed turn render defaults and explicit on-demand detail request (`turn-detail-request`) when not loaded.

Proven pattern to borrow:
- Summary feed and detail feed are separate contracts.
- Watch endpoint is cursor-based and idempotent.
- UI stores summary cache and merges detail only when requested.

## 4) Current Buffaly Architecture Findings

### Backend and Core Session Model
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\SessionObject.cs`
  - `TimelineMessages` is the canonical in-memory timeline store.
  - Snapshot/load/prepend methods (`GetTimelineRowsSnapshot`, `LoadTimelineRows`, `PrependMissingTimelineRows`) operate on message rows.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\TimelineRowSnapshot.cs`
  - Message-row snapshot contract used across persistence and transport mapping.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\TooledAgent.cs`
  - Runtime appends timeline rows from assistant/tool events.

### Host and Service Layer
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\Services\BuffalyAgentService.cs`
  - `GetSessionRefresh`, `GetAgentMessagesSince`, `GetAgentMessagesBefore`, `GetAgentMessagePage` expose message-first retrieval.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\Services\BuffalyAgentService.Private.cs`
  - `BuildSessionRefreshContract` composes refresh payload with timeline page data.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Contracts\AgentServiceContracts.cs`
  - `SessionRefreshContract` mixes status, session metadata, and message page payload.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Contracts\MessagesSinceResponse.cs`
  - Delta/full message page response semantics.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Services\SessionTimelineRowContractMapper.cs`
  - Maps `TimelineRowSnapshot` to transport contracts.

### Session Management, History, and Cache
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\SessionStoreProviders.cs`
  - `ISessionStore` defines message-based history retrieval and turn-row helpers.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\Sessions.cs`
  - Forwards `GetLatestMessages`, `GetMessagesSince`, `GetMessagesBefore`, `GetTurnRows`, `GetMessageByKey`.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\SqlSessionStore.cs`
  - Implements message page retrieval and fallback across SQL/cache.

### JS UI, Timeline, Refresh, and Transport
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-session-refresh.js`
  - Polling loop centered on `GetSessionRefresh` and message deltas.
  - Local cache usage keyed to session message payload shape.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-timeline.js`
  - Message render and append paths (`renderSessionMessages`, `appendDeltaSessionMessages`).
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-timeline-compaction.js`
  - Older history prepend via `GetAgentMessagesBefore`.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-ops-service-router.js`
  - Client transport routing for refresh and history methods.

## 5) Proposed End-to-End Design

### Core and Session Model
- Add one authoritative turn projection contract in C# and persist it as typed data.
- Keep existing row capture in `SessionObject`, but project rows into turn snapshots at the service boundary and store summary projection in session cache.
- Turn identity must be stable (`TurnId`) and unique per session.

### Host and Service API Surface
- Add turn-specific APIs and deprecate message history APIs for UI timeline use.
- Keep old APIs temporarily for non-migrated callers only.

### Typed Contracts
- Define one contract set for:
  - bootstrap summary snapshot
  - watch updates
  - turn detail fetch
- No alternate casing or wrapper DTOs.

### Server-Side Projection Rules
- Turn summary fields include:
  - `TurnId`
  - `StartedAtUtc`
  - `CompletedAtUtc`
  - `Status`
  - `FirstUserMessageText`
  - `LastAssistantMessageText` (nullable)
  - `HasDetail`
  - `DetailLoaded` (always false in summary payload)
- Turn detail fields include ordered full row/message detail for that turn.
- Summary text extraction rule:
  - `FirstUserMessageText` = first user message in the turn.
  - `LastAssistantMessageText` = last assistant message in the turn if present; otherwise null.

### Polling and Watch Semantics
- `GetSessionTurnBootstrap` returns current cursor and initial summary page.
- `WatchSessionTurns` accepts `Cursor` and returns:
  - `Mode = Noop | Incremental | Full`
  - `NextCursor`
  - `Turns`
  - active turn metadata
- Noop responses must not mutate current UI state.

### UI State Model
- Replace message-page timeline state with turn summary list state.
- Maintain a per-session map:
  - `TurnSummariesById`
  - `OrderedTurnIds`
  - `TurnDetailsById` (loaded on demand)
  - `Cursor`

### UI Rendering Behavior
- Default render shows collapsed summary card per turn.
- Old historical turns are collapsed by default.
- Expand action calls detail endpoint for that turn if `DetailLoaded == false`.
- Once detail is loaded, expand/collapse toggles local state only.

### Cache Model
- Persist only turn summaries and only for a small recent set (example: latest 5 sessions and latest 200 summaries per session).
- Do not persist full turn details.
- On restore, render cached summaries immediately, then reconcile with bootstrap/watch.

### Migration and Rollout
- Phase 1: Add new typed contracts and service methods behind feature flag.
- Phase 2: Wire JS timeline to turn summary bootstrap/watch/detail while keeping old methods available.
- Phase 3: Remove UI dependency on `GetSessionRefresh` timeline payload and on `GetAgentMessagesBefore` for timeline.
- Phase 4: Retire old timeline message retrieval APIs after callers are removed.

### Compatibility During Transition
- Compatibility is endpoint-level, not payload normalization.
- Old callers use old contracts unchanged.
- New UI uses new contracts only.
- Any contract bind mismatch fails fast with diagnostics.

## 6) Proposed Contract Shapes (C#-Style Pseudocode)

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

public sealed class GetTurnDetailRequest
{
	public string SessionId { get; init; } = string.Empty;
	public string TurnId { get; init; } = string.Empty;
}

public sealed class GetTurnDetailResponse
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

## 7) Proposed API Methods and Differences from Existing Methods

### New Methods
- `GetSessionTurnBootstrap(GetSessionTurnBootstrapRequest) -> GetSessionTurnBootstrapResponse`
- `WatchSessionTurns(WatchSessionTurnsRequest) -> WatchSessionTurnsResponse`
- `GetTurnDetail(GetTurnDetailRequest) -> GetTurnDetailResponse`

### Existing Method Differences
- `GetSessionRefresh`
  - Today: mixes session status plus message-page timeline in one response.
  - Proposed: keep session status use, remove timeline dependency for UI; timeline moves to bootstrap/watch summary contracts.
- `GetAgentMessagesBefore`
  - Today: prepends older message rows.
  - Proposed: replaced by summary retrieval plus expand-on-demand detail. Old historical turns remain collapsed, not bulk message loaded.

## 8) File-by-File Change Plan (Buffaly)

### Core Projection and Models
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\SessionObject.cs`
  - Add turn projection helpers returning typed summary/detail structures.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\TimelineRowSnapshot.cs`
  - Reuse as source rows for detail payloads without contract duplication.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Core\TooledAgent.cs`
  - Ensure turn boundaries needed by projection remain explicit and stable.

### Host Contracts and Services
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Contracts\AgentServiceContracts.cs`
  - Add new turn summary/detail request and response DTOs.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\Services\BuffalyAgentService.cs`
  - Add service methods for bootstrap/watch/detail.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\Services\BuffalyAgentService.Private.cs`
  - Add summary/detail projection and response builders.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\OpsAgent\Services\SessionTimelineRowContractMapper.cs`
  - Add mapper methods for turn summary and turn detail contracts.

### Session Store and History Retrieval
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\SessionStoreProviders.cs`
  - Extend `ISessionStore` with turn summary watch/detail methods.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\Sessions.cs`
  - Add pass-through methods for new turn APIs.
- `C:\dev\Buffaly.Development\Buffaly.Agent.Host\SessionManagement\SqlSessionStore.cs`
  - Implement summary projection retrieval with cursor and detail-by-turn lookup.

### Web UI and Transport
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-ops-service-router.js`
  - Add routes for new methods.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-session-refresh.js`
  - Remove timeline message dependency from refresh flow.
  - Add bootstrap/watch orchestration and cursor state.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-timeline.js`
  - Render collapsed summary cards and expand-on-demand detail.
- `C:\dev\Buffaly.Development\buffaly.agent.web\wwwroot\js\buffaly-agent-timeline-compaction.js`
  - Replace message-prepend history loading with summary-based pagination semantics.

## 9) Risks and Mitigations
- Risk: Turn projection ambiguity for incomplete or tool-heavy turns.
  - Mitigation: define deterministic extraction order and status rules; add fail-fast diagnostics on invalid turn structure.
- Risk: UI regressions during mixed old/new retrieval period.
  - Mitigation: feature flag at entry point and endpoint-level separation.
- Risk: payload size spikes if detail is accidentally included in summary responses.
  - Mitigation: contract-level prohibition of detail collections in summary DTO.
- Risk: stale cache mismatch.
  - Mitigation: summary cache version key plus cursor reconciliation and hard reset on schema mismatch.

## 10) Acceptance Criteria
- New turn bootstrap/watch/detail APIs return typed PascalCase contracts only.
- Timeline initial render uses summary data only.
- Summary content is first user message and last assistant message if present.
- Expanding a turn loads detail on demand exactly once per turn per session view.
- Old historical turns render collapsed by default.
- Persisted cache stores summaries only and only for small recent session set.
- No normalization logic is added in C# or JavaScript paths.

## 11) Test Plan

### Backend Projection
- Verify summary extraction for normal turn: first user and last assistant are correct.
- Verify summary extraction when assistant missing: `LastAssistantMessageText` is null.
- Verify detail response contains ordered full messages/events for one turn.

### API Contracts
- Contract binding success with valid PascalCase payloads.
- Fail-fast binding errors for missing required fields.
- Watch mode behavior: `Noop`, `Incremental`, `Full` semantics validated against cursor transitions.

### UI Behavior
- Cold load: cached summaries render immediately; bootstrap reconciles without flicker/clobber.
- Timeline render: historical turns collapsed by default.
- Expand action: requests detail, merges into existing summary card, retains expansion state.
- Repeat expand/collapse: no extra network request after detail loaded.

### Cache and Polling
- Cache persists summary-only payload for recent limited set.
- Schema version bump invalidates incompatible cache.
- Poll noop leaves UI unchanged.
- Poll incremental appends/updates only changed turns.

### Migration and Fallback
- With feature flag off: existing message-based UI path still works.
- With feature flag on: timeline uses only new turn APIs.
- Transition does not require multi-shape normalization in any layer.

## 12) Open Questions and Decisions to Confirm
- Confirm final cache limits (session count and max summaries per session).
- Confirm whether `GetSessionRefresh` continues to carry non-timeline status only or is split further.
- Confirm canonical turn completion status values for UI badges.
- Confirm whether detail payload should include tool-call raw JSON or projected display-only fields.
- Confirm deprecation timeline and caller inventory for `GetAgentMessagesBefore` and `GetAgentMessagesSince`.
