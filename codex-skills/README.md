# Codex Skills (Repo Local)

This folder contains Codex skills intended for this repository.

## Install Into Local Discovery Path

Codex discovers repo-scoped skills from:

`<repo>/.agents/skills/<skill-name>/SKILL.md`

If your environment allows it, copy a skill folder into `.agents/skills`.

Example (PowerShell):

```powershell
New-Item -ItemType Directory -Force .agents/skills | Out-Null
Copy-Item -Recurse -Force codex-skills/release-notes .agents/skills/release-notes
```
