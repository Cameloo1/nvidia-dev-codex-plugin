# NVIDIA RTX/DLSS Codex Plugin

[![CI](https://github.com/Cameloo1/nvidia-dev-codex-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Cameloo1/nvidia-dev-codex-plugin/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/Cameloo1/nvidia-dev-codex-plugin?label=version)](https://github.com/Cameloo1/nvidia-dev-codex-plugin/tags)
![Repo size](https://img.shields.io/github/repo-size/Cameloo1/nvidia-dev-codex-plugin)
![Last commit](https://img.shields.io/github/last-commit/Cameloo1/nvidia-dev-codex-plugin)
![Codex](https://img.shields.io/badge/Codex-plugin-6f42c1)
![MCP](https://img.shields.io/badge/MCP-tools-0a7ea4)
![NVIDIA](https://img.shields.io/badge/NVIDIA-focused-76b900)

![Codex to NVIDIA integration banner](assets/codex-nvidia-readme-pic.png)

**Not affiliated with, endorsed by, or sponsored by NVIDIA.** NVIDIA, RTX, DLSS, CUDA, Nsight, NVENC, NVDEC, and related names are trademarks or registered trademarks of NVIDIA Corporation.

`nvidia-rtx-dlss` is a release-candidate Codex plugin for NVIDIA-focused content technology work. It helps Codex classify a project, choose the right NVIDIA SDK route, inspect local SDK headers, produce implementation plans, generate narrow scaffold files, and create validation reports without downloading SDKs, copying NVIDIA binaries, or claiming unverified runtime results.

## Implementation Support

This plugin supports implementation work for a limited set of base cases. It does not solve arbitrary RTX integration.

Supported now:

- Unreal DLSS/Streamline plugin validation and config patch planning. It detects `.uproject`, plugin descriptors, engine-version clues, config files, packaging risks, and write-gated validation artifacts.
- Unity HDRP DLSS readiness validation and patch planning. It detects Unity version, HDRP package state, URP/custom SRP routing, render-pipeline hints, Reflex readiness, and blocks FPS/profiler claims unless Unity produced evidence.
- D3D12 Streamline DLSS Super Resolution / DLAA scaffold generation. It generates `NvidiaStreamlineBridge`, DLSS frame-input contracts, build-system wiring, and validation guidance after renderer and header gates pass.
- D3D12 DXR starter scaffold generation for basic ray-traced shadows/reflections. It generates context, acceleration-structure, shader-binding-table, pass, and HLSL template files after DXR readiness evidence is present.
- NRD denoiser bridge scaffold generation. It generates `NrdDenoiserBridge`, `NrdFrameInputs`, and signal-type contracts, but does not claim denoising works without required buffers and validation artifacts.
- RTX Video SDK native media enhancement scaffold generation. It generates `RtxVideoEnhancer`, frame/effect contracts, API-route checks, and validation plans for Super Resolution, artifact reduction, and SDR-to-HDR.
- Video Codec SDK / NVENC / NVDEC scaffold and command-plan generation. It generates `NvencPipelineAdapter`, `NvdecPipelineAdapter`, FFmpeg/GStreamer command plans, PyNvVideoCodec route notes, throughput checks, and PSNR/SSIM/VMAF validation plans.
- Local validation automation for environment reports, log analysis, validation harness planning, codec throughput planning, and quality comparison when local tools and files exist.

## Implementation Levels

- Planning: classification, technology routing, compatibility notes, patch plans, validation plans, and rollback plans. No code is generated or written.
- Scaffold generation: create-only adapter files, build wiring, docs, or validation scripts. Writes require explicit approval. Existing project files are not overwritten.
- SDK-backed implementation kit: generated scaffold output is grounded in detected local SDK headers and required symbols. Host renderer/media resources remain explicit TODO boundaries unless the project contract proves they exist.
- Compile-verified implementation: user-supplied build logs or compile artifacts prove the generated or edited code compiled in the target project.
- Runtime-verified implementation: user-supplied runtime logs, captures, metrics, or validation artifacts prove the NVIDIA path ran for the tested GPU, driver, SDK, workload, and project configuration.

The `nvidia_implementation_readiness_report` tool summarizes this as `ready_to_patch`, `blocked_missing_sdk`, `blocked_missing_renderer_contract`, `blocked_unsupported_project`, `unsafe_license_or_binary_boundary`, `validation_required`, or `implementation_verified`.

## Local SDK Requirements

Real SDK API guidance requires local NVIDIA headers or project-vendored headers. Without them, output is plan-only or template-only.

- Streamline/DLSS/Reflex work requires Streamline/DLSS/Reflex headers such as `sl.h`, `sl_dlss.h`, or Reflex-related headers/symbols.
- NRD work requires NRD headers and observed NRD/ReBLUR/ReLAX/SIGMA symbols.
- RTX Video SDK work requires RTX Video SDK header evidence.
- Video Codec SDK work requires `nvEncodeAPI.h`, `nvcuvid.h`, or equivalent Video Codec SDK header evidence.
- Missing SDKs are blocker states, not test failures.

## Approval Gates

The plugin requires explicit user approval before:

- writing scaffold files or validation artifacts;
- editing project files;
- downloading, installing, or locating credential-gated SDK content;
- copying, packaging, or redistributing NVIDIA binaries;
- uploading source, logs, videos, captures, crash dumps, SDK files, or proprietary artifacts.

## Renderer And Media Contracts

Implementation kits are blocked until required project evidence exists.

- DLSS SR/DLAA requires a native real-time renderer route, graphics API evidence, color/depth/motion-vector/jitter/exposure/reset inputs, a build path, SDK headers, and validation hooks.
- Frame Generation / Multi Frame Generation is readiness-only in this plugin baseline. Full implementation is not generated.
- DXR starter work requires D3D12/DXR readiness, shader compilation path, mesh/instance data access, render insertion point, and fallback path.
- NRD requires noisy signals, normals, roughness, depth/viewZ, motion vectors, camera matrices, render resolution, temporal reset state, and SDK/header evidence or explicit template mode.
- RTX Video SDK requires decoded video frame ownership, color format, bit depth, SDR/HDR path, supported native API route, output surface ownership, and local SDK/header evidence.
- Video Codec SDK requires encode/decode goal, codec, pixel format, bit depth, target platform, GPU capability path, zero-copy claim validation, build/script path, and local SDK/header evidence for native adapter work.

## Unsupported Cases

- Fully automated DLSS integration in arbitrary engines or renderers.
- DLSS Frame Generation / Multi Frame Generation full implementation.
- RTXDI, complete NRD integration into a renderer, or full path tracing.
- Browser-only direct calls to DLSS, RTX Video SDK, Video Codec SDK, Optical Flow SDK, or native NVIDIA APIs.
- Consumer modding, DLL injection, driver-check bypasses, or unsupported game patching.
- NVIDIA SDK downloads, binary packaging, or redistribution without explicit approval and license review.
- Claims of FPS, latency, image quality, hardware acceleration, zero-copy, or runtime success without local validation artifacts.

## MCP Tools

- `nvidia_project_classifier`
- `nvidia_sdk_locator`
- `nvidia_source_resolver`
- `nvidia_tech_router`
- `nvidia_feature_requirements`
- `nvidia_implementation_contracts`
- `nvidia_implementation_readiness_report`
- `nvidia_unreal_dlss_validator`
- `nvidia_unity_hdrp_validator`
- `nvidia_integration_plan`
- `nvidia_code_guidance`
- `nvidia_patch_plan`
- `nvidia_assisted_implementation`
- `nvidia_environment_probe`
- `nvidia_validation_harness`
- `nvidia_log_analyzer`
- `nvidia_quality_compare`
- `nvidia_sdk_header_grounding`
- `nvidia_header_inspector`
- `nvidia_registry_audit`
- `nvidia_release_readiness`
- `nvidia_submission_packager`
- `nvidia_validation_plan`
- `nvidia_known_issues_lookup`
- `nvidia_license_guard`

## Safety, NVIDIA SDK, And Licensing Boundaries

- No NVIDIA SDK downloads.
- No uploads of source, captures, logs, videos, crash dumps, or SDK files.
- No NVIDIA binary redistribution or packaging.
- No browser-only native SDK claims.
- Artifact/scaffold writes require explicit approval tokens.
- Local SDK docs and headers outrank generic web docs.

## Validation

Run from the plugin root:

```powershell
node --check .\scripts\nvidia-rtx-dlss-mcp.mjs
node .\scripts\nvidia-rtx-dlss-mcp.mjs --self-test
.\scripts\tests\test-routing-and-fixtures.ps1
.\scripts\tests\test-skill-usability.ps1
.\scripts\tests\test-assisted-implementation.ps1
.\scripts\tests\test-validation-automation.ps1
.\scripts\tests\test-implementation-contracts.ps1
.\scripts\tests\test-implementation-readiness-report.ps1
.\scripts\tests\test-header-grounded-generation.ps1
.\scripts\tests\test-unreal-dlss-validation.ps1
.\scripts\tests\test-unity-hdrp-validation.ps1
.\scripts\tests\test-d3d12-streamline-dlss-kit.ps1
.\scripts\tests\test-d3d12-dxr-raytracing-kit.ps1
.\scripts\tests\test-nrd-denoiser-bridge-kit.ps1
.\scripts\tests\test-rtx-video-native-pipeline-kit.ps1
.\scripts\tests\test-video-codec-native-pipeline-kit.ps1
.\scripts\tests\test-production-readiness.ps1
```

`scripts/smoke-test.mjs` performs a child-process MCP handshake. Some restricted Codex sandboxes block child spawning with `EPERM`; direct framed MCP calls remain supported.

## Contributing

Contributions are welcome. This project is open to issues, docs fixes, fixtures, tests, and pull requests that make the NVIDIA routing, SDK/header grounding, implementation scaffolds, or validation workflows more accurate.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Do not include NVIDIA SDK binaries, proprietary captures, private logs, credentials, or licensed files in issues or pull requests.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Examples](docs/examples.md)
- [Limitations](docs/limitations.md)
- [Tool Contracts](docs/tool-contracts.md)
- [Source Policy](docs/source-policy.md)
- [Security And Privacy](docs/security-privacy.md)
- [Release Readiness](docs/release-readiness.md)
- [Changelog](docs/changelog.md)
