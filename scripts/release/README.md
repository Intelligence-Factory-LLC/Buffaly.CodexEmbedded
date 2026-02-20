# Release Scripts

From repository root:

```powershell
./scripts/release/build.ps1 -Configuration Release
./scripts/release/publish.ps1 -Runtime win-x64 -Configuration Release -OutputRoot artifacts/publish
./scripts/release/package.ps1 -Runtime win-x64 -Version v1.0.0 -Repository <owner/repo> -PublishRoot artifacts/publish -OutputRoot artifacts/release
```

Outputs:

- `artifacts/release/Buffaly.CodexEmbedded-win-x64-<version>.zip`
- `artifacts/release/SHA256SUMS-win-x64-<version>.txt`
