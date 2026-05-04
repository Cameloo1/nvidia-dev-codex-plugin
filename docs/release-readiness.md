# Release Readiness

Before release, run:

```powershell
node .\scripts\nvidia-rtx-dlss-mcp.mjs --self-test
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-production-readiness.ps1
```

Release gates:

- manifest version matches MCP server version.
- author metadata is not placeholder text.
- production docs exist.
- phase-development docs are removed.
- registry audit score is release-candidate quality or documented.
- fixture tests pass.
- scaffold and artifact write gates are tested.
- no NVIDIA SDK binaries are bundled.

Recommended release label: `1.0.0-rc.1`.
