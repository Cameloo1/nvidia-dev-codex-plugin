---
name: nvidia-rtx-dlss
description: Use official-source-grounded NVIDIA RTX/DLSS expertise for NVIDIA technology routing, implementation-readiness reports, SDK/header grounding, Unreal DLSS validation, Unity HDRP DLSS validation, D3D12 Streamline DLSS SR/DLAA scaffolds, D3D12 DXR starter scaffolds, NRD bridge scaffolds, RTX Video SDK media enhancement scaffolds, Video Codec SDK/NVENC/NVDEC scaffolds, validation automation, and NVIDIA SDK/licensing boundaries.
---

# NVIDIA RTX/DLSS

Use this skill for NVIDIA RTX, DLSS, Streamline, RTX Video SDK, Optical Flow SDK, NvOFFRUC, Video Codec SDK, NVENC, NVDEC, Reflex, Nsight, Aftermath, RTX Kit, Unreal/Unity NVIDIA plugins, media enhancement, video encode/decode, custom renderers, WebGPU/native boundaries, and NVIDIA GPU-focused content pipelines.

This is an implementation-readiness and scaffolding skill. Use it to plan, gate, and generate narrow NVIDIA integration scaffolds. Do not imply arbitrary RTX integration is solved.

## Operating Flow

1. Classify the project and content pipeline.
2. Route to the correct NVIDIA technology and reject wrong routes.
3. For implementation work, prefer `nvidia_implementation_readiness_report` first.
4. Resolve local SDK docs/headers before SDK-level guidance.
5. Run strict implementation contracts before code-generation or patch planning.
6. Produce patch and validation plans before edits.
7. Generate scaffolds only after explicit approval.
8. Run or plan local validation before claiming implementation readiness.
9. Require compile/runtime evidence before claiming verified implementation.

## Implementation Levels

- Planning: classify, route, plan, and list validation steps. Do not generate or write code.
- Scaffold generation: create narrow adapter/build/doc/script files. Require approval for writes. Do not overwrite project files.
- SDK-backed implementation kit: ground generated scaffolds in observed local headers and required symbols. Keep host renderer/media resources as explicit TODOs unless the project contract proves them.
- Compile-verified implementation: require supplied build logs or compile artifacts.
- Runtime-verified implementation: require supplied runtime logs, captures, metrics, or validation artifacts for the tested GPU, driver, SDK, workload, and project configuration.

## Tool Selection

- Use `nvidia_project_classifier` for repo shape, engine, language, API, build system, content path, and NVIDIA dependency detection.
- Use `nvidia_tech_router` when the user asks which NVIDIA technology applies.
- Use `nvidia_implementation_readiness_report` when the user asks whether real NVIDIA implementation work is ready, blocked, unsafe, validation-required, or verified.
- Use `nvidia_implementation_contracts` when a specific target must be gated before code generation.
- Use `nvidia_sdk_locator`, `nvidia_header_inspector`, or `nvidia_sdk_header_grounding` before SDK-level API guidance.
- Use `nvidia_unreal_dlss_validator` before Unreal `.uproject`, plugin, config, packaging, or log guidance.
- Use `nvidia_unity_hdrp_validator` before Unity HDRP DLSS, Reflex, render-pipeline, camera, package, or project-setting guidance.
- Use `nvidia_patch_plan` for repo-aware planned edits with rollback.
- Use `nvidia_assisted_implementation` only for narrow scaffold generation and only with approval before writes.
- Use `nvidia_environment_probe`, `nvidia_validation_harness`, `nvidia_log_analyzer`, and `nvidia_quality_compare` for local validation automation.
- Use `nvidia_license_guard` for SDK download, binary copy, packaging, upload, redistribution, signature, or proprietary-artifact boundaries.
- Use `nvidia_release_readiness` and `nvidia_submission_packager` before public release or marketplace claims.

## Supported Base Cases

- Unreal DLSS/Streamline plugin validation and safe patch planning.
- Unity HDRP DLSS readiness validation and safe patch planning.
- D3D12 Streamline DLSS Super Resolution / DLAA adapter scaffold generation.
- D3D12 DXR starter scaffold generation for basic ray-traced shadows/reflections.
- NRD denoiser bridge scaffold generation for ReBLUR/ReLAX/SIGMA readiness.
- RTX Video SDK native media enhancement scaffold generation.
- Video Codec SDK / NVENC / NVDEC native adapter scaffold generation plus FFmpeg/GStreamer/PyNvVideoCodec command plans.
- Nsight marker and Reflex marker scaffolds.
- Local validation reports, validation harness plans, log analysis, codec throughput plans, and quality comparison plans.

## Required Gates

Treat these as normal blocked states, not tool failures:

- Missing local SDK/header evidence: return `blocked_missing_sdk` or template-only guidance.
- Missing renderer/media contract evidence: return `blocked_missing_renderer_contract`.
- Browser-only or unsupported project shape: return `blocked_unsupported_project` and route to WebGPU/WebCodecs, Electron/native helper, native app/plugin, or server-side GPU.
- Download, copy, package, redistribute, upload, or binary/signature boundary: return `unsafe_license_or_binary_boundary` or require explicit approval.
- Patch already approved or implementation present but proof missing: return `validation_required`.
- Compile and runtime evidence plus validation artifacts supplied and passing: only then return `implementation_verified`.

## Routing Rules

- Games and real-time renderers: route to Streamline, DLSS, Reflex, and Nsight planning.
- Unreal: prefer the official NVIDIA Unreal plugin matched to engine version.
- Unity HDRP: prefer native HDRP DLSS/Reflex paths. Treat URP/custom SRP as advanced until inspected.
- Media playback enhancement: route to RTX Video SDK, not DLSS.
- Frame-rate up-conversion for decoded video: route to Optical Flow SDK / NvOFFRUC through a native/backend layer, not DLSS Frame Generation.
- Encode/decode/transcode/capture/streaming: route to Video Codec SDK, NVENC, NVDEC, FFmpeg/GStreamer, DirectX Video, Vulkan Video, or PyNvVideoCodec.
- Animation, asset, visualization, and rendering tools: route to RTX Kit, CUDA, Video Codec SDK, and Nsight depending on the pipeline.
- Pure browser apps: do not claim direct native NVIDIA SDK access.

## Output Contract

For major answers include:

- Classification
- Recommended NVIDIA route
- Rejected routes
- Compatibility state
- Required data/resources
- Integration or patch plan
- Validation plan
- Risks and blockers
- Sources or local evidence

For implementation tasks also include:

- No-edit diagnosis
- Implementation-readiness state
- Files likely affected
- Approval gates
- Rollback plan
- What remains unverified

## Do Not Overclaim

- Do not provide guessed SDK function calls.
- Do not claim DLSS, ray tracing, denoising, RTX Video, NVENC/NVDEC, zero-copy, FPS, latency, throughput, quality, or runtime success without local evidence.
- Do not use RTX Video SDK for DLSS, DLSS for media enhancement, or DLSS Frame Generation for decoded video frame insertion.
- Do not generate full DLSS Frame Generation/Multi Frame Generation, RTXDI, full NRD renderer integration, full path tracing, or arbitrary renderer integration.
- Do not download SDKs, copy NVIDIA binaries, package redistributables, upload artifacts, or edit project files without explicit approval.
- Do not recommend modding, DLL injection, driver-check bypasses, or unsupported game patching.
