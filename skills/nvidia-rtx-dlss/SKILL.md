---
name: nvidia-rtx-dlss
description: Use official-source-grounded NVIDIA RTX/DLSS expertise to classify projects, route technologies, plan integrations, validate compatibility, and avoid NVIDIA SDK/licensing mistakes.
---

# NVIDIA RTX/DLSS

Use this skill when the user asks about NVIDIA RTX, DLSS, Streamline, RTX Video SDK, Optical Flow SDK, NvOFFRUC, Video Codec SDK, NVENC, NVDEC, Reflex, Nsight, Aftermath, RTX Kit, Unreal/Unity NVIDIA plugins, media playback enhancement, video encode/decode, custom renderers, WebGPU/native boundaries, or NVIDIA GPU-focused content pipelines.

This plugin is a planner, source-grounded routing layer, repo-aware patch-planning layer, gated assisted-implementation scaffold layer, local validation automation layer, and release-readiness layer. Do not jump directly to broad code edits.

## Required Reasoning Order

1. Classify the project and content pipeline.
2. Route to the correct NVIDIA technology.
3. Identify explicitly rejected NVIDIA routes.
4. Resolve local SDK docs/headers first, then official NVIDIA sources.
5. Produce compatibility and missing-information checks.
6. Produce integration and validation plans.
7. For implementation requests, produce repo-aware code guidance and a patch plan before edits.
8. Only after explicit user approval, move from patch planning to narrow Phase 3 assisted implementation scaffolds.
9. Run or plan Phase 4 local validation automation before claiming implementation readiness.
10. Inspect local SDK headers before giving code-level API guidance when SDK paths are available.
11. Use release-readiness and submission checks before marketplace or public release claims.
12. Treat broad renderer/media implementation edits as future work unless the user separately approves a specific patch.

## Preferred MCP Tools

- `nvidia_project_classifier`: inspect repo type, engine, APIs, languages, build system, content path, and NVIDIA dependencies.
- `nvidia_sdk_locator`: locate local NVIDIA SDKs, tools, docs, headers, plugins, and binaries.
- `nvidia_source_resolver`: search official-source registry, local docs, and optionally fetch official docs.
- `nvidia_tech_router`: map the user's goal to the correct NVIDIA route.
- `nvidia_feature_requirements`: generate structured compatibility reports.
- `nvidia_integration_plan`: produce source-backed integration plans.
- `nvidia_code_guidance`: produce Phase 2 repo-aware code guidance without modifying files.
- `nvidia_patch_plan`: produce Phase 2 patch plans, likely files, risks, validation, rollback, and approval gates.
- `nvidia_assisted_implementation`: produce Phase 3 reviewable scaffold files/snippets for narrow approved workflows; writes are off by default and create new files only after explicit approval.
- `nvidia_environment_probe`: produce Phase 4 local environment, GPU/driver, SDK/tool, FFmpeg/GStreamer, and project classification reports.
- `nvidia_validation_harness`: produce Phase 4 local validation harness command plans, expected artifacts, and pass/fail criteria.
- `nvidia_log_analyzer`: parse local logs for NVIDIA-relevant validation findings.
- `nvidia_quality_compare`: prepare or run local image/video quality metric checks with graceful missing-tool handling.
- `nvidia_header_inspector`: inspect local NVIDIA SDK headers and summarize observed symbols before code-level guidance.
- `nvidia_registry_audit`: audit registry source freshness and metadata completeness.
- `nvidia_release_readiness`: summarize metadata, docs, tests, registry health, tool contracts, and release gaps.
- `nvidia_submission_packager`: produce marketplace/GitHub submission checklist and packaging guidance without uploading.
- `nvidia_validation_plan`: produce validation workflows and metrics.
- `nvidia_known_issues_lookup`: find official known-issue/troubleshooting context.
- `nvidia_license_guard`: check download, packaging, redistribution, signature, upload, and licensing boundaries.

## Core Routing Rules

- Games and real-time renderers: use Streamline, DLSS, Reflex, and Nsight planning.
- Unreal Engine: prefer official NVIDIA Unreal plugin matched to the engine version.
- Unity HDRP: prefer native HDRP DLSS/Reflex paths. Treat URP/custom SRP as advanced and inspect first.
- Media playback enhancement: use RTX Video SDK, not DLSS.
- Video frame insertion/frame-rate up-conversion: use NVIDIA Optical Flow SDK / NvOFFRUC through a native or backend layer, not DLSS Frame Generation.
- Encode/decode/transcode/capture/streaming: use Video Codec SDK, NVENC, NVDEC, FFmpeg/GStreamer, DirectX Video, Vulkan Video, or PyNvVideoCodec.
- Animation, asset, visualization, and rendering tools: route to RTX Kit, Video Codec SDK, CUDA, and Nsight depending on the pipeline.
- Pure browser apps: do not claim direct native DLSS/RTX Video/Video Codec SDK access. Route to WebGPU/WebCodecs, Electron/native companion, native app/plugin, or server-side NVIDIA GPU pipeline.

## Output Contract

Major answers should include:

- Classification
- Recommended NVIDIA route
- Why this route
- Rejected routes
- Compatibility state
- Required data/resources
- Integration plan
- Validation plan
- Risks
- Sources

For implementation tasks, add a no-edit diagnosis, patch plan, files likely affected, risk analysis, validation plan, and rollback plan before edits.

For Phase 3 assisted implementation, keep scope to:

- Unreal plugin config validation.
- CMake include/lib path setup.
- Streamline initialization scaffolding.
- Video Codec SDK sample adaptation.
- RTX Video SDK pipeline skeletons.
- Nsight marker insertion.
- Reflex marker scaffolding.

Do not use Phase 3 to perform full DLSS integration in arbitrary renderers, install Unreal plugins, download SDKs, package NVIDIA binaries, bypass browser/native boundaries, or replace complete media pipelines.

For Phase 4 validation automation, keep validation local-first. Do not upload logs, media, captures, crash dumps, or SDK files. Artifact writing must remain gated behind explicit approval.

For release-candidate work, prefer production docs, fixture-backed tests, explicit tool contracts, header-aware guidance, and source-registry audits. Do not leave phase-development docs or placeholder metadata in the final plugin package.

## Strictness

Avoid unsupported claims, stale version assumptions, hallucinated SDK functions, generic graphics advice, non-NVIDIA fallback plans, unsupported modding/injection guidance, automatic SDK downloads, and NVIDIA binary redistribution advice without license review.
