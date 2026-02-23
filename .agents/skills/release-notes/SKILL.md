---
name: release-notes
description: "Create or update release notes for this repository. Use when asked to write release notes, whats new, or a changelog for a specific date or release. Includes summarizing changes from git commits for the target date, folding in any user-provided notes, including relevant screenshots from screenshots/, and adding or updating a README link to the new release notes markdown file."
---

# Release Notes Workflow (Buffaly.CodexEmbedded)

## Create The Release Notes File

1. Pick the target date.
   - If the user says "today", use the local date.
   - If unclear, ask for the exact date (YYYY-MM-DD).
2. Create a new file at `docs/release-notes-YYYY-MM-DD.md`.
3. Use this header format:
   - `# Release Notes - Month D, YYYY`
   - `## New Features`

## Mine The Commits For That Date

Collect the commits for the target date (PowerShell example):

```powershell
$day = "2026-02-23"
git log --since="$day 00:00" --until="$day 23:59:59" --date=short --pretty=format:"%h %s" --name-only
```

Extract:
- User-visible UI changes
- Server behavior and reliability changes
- Developer or diagnostics tooling changes

If a commit message is vague, open the diff for that commit and pull the actual behavior:

```powershell
git show <sha>
```

## Confirm Any New Screenshots

1. Check for new or untracked screenshots:

```powershell
git status --porcelain
Get-ChildItem screenshots -File | Sort-Object LastWriteTime -Descending | Select-Object -First 20 Name,LastWriteTime
```

2. Embed screenshots in the release notes using paths relative to `docs/`:
   - `![Alt text](../screenshots/<file>.png)`

## Verify Page Routes For New Screens

When documenting new web pages, confirm the real routes in `Buffaly.CodexEmbedded.Web/Program.cs`:

```powershell
rg -n 'MapGet\\(\"/(logs|watcher|server)\"' Buffaly.CodexEmbedded.Web/Program.cs
```

PowerShell quoting tip: prefer single quotes in `rg` patterns when the pattern contains quotes or `|`.

## Write It Like A Human

Keep it scannable:
- Start each section with 1 short sentence describing why it matters.
- Use 3 to 6 bullets per section, focused on outcomes.
- Avoid implementation details unless it changes behavior or reliability.

Recommended section layout:
- `### UI Improvements`
- `### Server Improvements`
- `### New Developer Features`
- `### Reliability and Sync Improvements`

## Link From README

1. Add a `## Release Notes` section near the top of `README.md` if it does not exist.
2. Add a bullet link to the new file:
   - `- [Release Notes - Month D, YYYY](docs/release-notes-YYYY-MM-DD.md)`

## Repo Writing Guardrail

Do not use en dash or em dash characters in any repository text. Use the plain ASCII hyphen-minus (`-`).

Quick check:

```powershell
rg -n -P "\\x{2013}|\\x{2014}" README.md docs/release-notes-*.md
```

## Optional Validation

If you changed only markdown, skip builds and JS checks.
If you touched JS, run:

```powershell
node --check Buffaly.CodexEmbedded.Web/wwwroot/app.js
node --check Buffaly.CodexEmbedded.Web/wwwroot/sessionTimeline.js
```
