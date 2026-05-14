# Release Readiness

Before release, run:

```powershell
Get-ChildItem -Path .\scripts -Recurse -File -Filter *.mjs | ForEach-Object { node --check $_.FullName }
node .\scripts\nvidia-rtx-dlss-mcp.mjs --self-test
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-production-readiness.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-skill-usability.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-implementation-contracts.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-implementation-readiness-report.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-header-grounded-generation.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-unreal-dlss-validation.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-unity-hdrp-validation.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-d3d12-streamline-dlss-kit.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-d3d12-dxr-raytracing-kit.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-nrd-denoiser-bridge-kit.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-rtx-video-native-pipeline-kit.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tests\test-video-codec-native-pipeline-kit.ps1
```

Release gates:

- manifest version matches MCP server version.
- author metadata is not placeholder text.
- production docs exist.
- phase-development docs are removed.
- NVIDIA skill passes skill-creator-style usability checks.
- registry audit score is release-candidate quality or documented.
- fixture tests pass.
- strict implementation contracts report satisfied, blocked, rejected, and missing-SDK states correctly.
- implementation-readiness report covers ready_to_patch, missing-SDK, missing-renderer-contract, unsupported-project, unsafe-license/binary-boundary, validation-required, and implementation-verified states without fake verification.
- header-grounded generation blocks real API guidance when required symbols are missing.
- Unreal DLSS validation reports missing, present, mismatch, patch-plan, and write-gate states.
- Unity HDRP validation reports supported, URP/custom advanced, missing-HDRP, version-mismatch, patch-plan, no-fake-metrics, and write-gate states.
- D3D12 Streamline DLSS SR/DLAA kit reports header-grounded, missing-SDK, fake-header limited, reviewable-files, validation-harness, and write-gate states.
- D3D12 DXR ray-tracing starter kit reports ready, missing-DXR-readiness, shader-template, no-invasive-edit, validation-checklist, and write-gate states.
- NRD denoiser bridge kit reports ready, missing-motion-vectors, missing-SDK template-only, ReBLUR/ReLAX/SIGMA readiness, no-working-claim, and write-gate states.
- RTX Video native pipeline kit reports media-ready, missing-SDK, browser-boundary, validation-harness, route-separation, no-working-claim, and write-gate states.
- Video Codec native pipeline kit reports FFmpeg, GStreamer, Python, missing-SDK, missing-tool graceful-skip, throughput/quality validation, zero-copy-claim, no-acceleration-claim, and write-gate states.
- scaffold and artifact write gates are tested.
- no NVIDIA SDK binaries are bundled.

Documentation gates:

- README states exactly which base cases are supported now.
- README and limitations distinguish planning, scaffold generation, SDK-backed implementation kits, compile verification, and runtime verification.
- README and limitations state which work requires local NVIDIA SDK/header evidence.
- README and limitations state which work requires explicit user approval.
- Limitations list renderer/media contracts that block implementation.
- Examples show scoped prompts and expected output level.
- Unsupported cases are stated directly: no arbitrary RTX integration, no browser-only native SDK calls, no modding/injection, no unverified performance or quality claims.
- Release notes avoid language that implies arbitrary RTX integration is solved.

Recommended release label: `1.0.0-rc.1`.
