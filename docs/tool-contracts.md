# Tool Contracts

All tools return structured JSON and avoid hidden network, download, upload, or packaging actions.

The tools separate five levels of work:

- Planning: classify, route, plan, and list validation steps without code output.
- Scaffold generation: produce create-only files or snippets behind approval gates.
- SDK-backed implementation kit: generate narrow adapters or build wiring only after local SDK/header evidence is detected.
- Compile-verified implementation: report compile success only when local build evidence is supplied.
- Runtime-verified implementation: report runtime success only when local runtime and validation artifacts are supplied.

## Core Tools

- `nvidia_project_classifier`: classifies repo shape and NVIDIA-relevant signals.
- `nvidia_sdk_locator`: finds local SDK/tool/header/binary candidates.
- `nvidia_source_resolver`: resolves local and official source evidence.
- `nvidia_tech_router`: chooses correct NVIDIA technology route and rejected routes.
- `nvidia_feature_requirements`: reports requirements, blockers, warnings, and missing info.
- `nvidia_integration_plan`: produces source-backed integration and validation plan.

## Repo And Implementation Tools

- `nvidia_code_guidance`: guidance without edits.
- `nvidia_implementation_contracts`: strict pre-implementation contract gates for real NVIDIA development targets.
- `nvidia_implementation_readiness_report`: one structured state report that combines classifier, SDK locator, header inspector, implementation contracts, patch plan, validation harness, license guard, and compile/runtime evidence. It never returns `implementation_verified` without compile, runtime, and validation artifact evidence.
- `nvidia_unreal_dlss_validator`: Unreal project DLSS/Streamline plugin validation, config/package risk report, and safe patch planning.
- `nvidia_unity_hdrp_validator`: Unity HDRP DLSS readiness validation, URP/custom SRP routing, Reflex readiness evidence, no-fake-metrics policy, and safe patch planning.
- `nvidia_patch_plan`: reviewable patch plan with rollback.
- `nvidia_assisted_implementation`: scaffold generation with approval gates, including the D3D12 Streamline DLSS SR/DLAA adapter kit, the D3D12 DXR ray-tracing starter kit, the NRD denoiser bridge kit, the RTX Video SDK native media enhancement kit, and the Video Codec SDK/NVENC/NVDEC native pipeline kit when repo evidence satisfies the gate.

`nvidia_assisted_implementation` currently supports these base cases:

- Unreal plugin/config validation artifacts.
- CMake include/lib path wiring.
- Streamline initialization scaffold.
- D3D12 Streamline DLSS SR/DLAA adapter kit.
- D3D12 DXR basic shadows/reflections starter kit.
- NRD denoiser bridge kit.
- RTX Video SDK native media enhancement kit.
- Video Codec SDK / NVENC / NVDEC native adapter kit plus FFmpeg/GStreamer/PyNvVideoCodec command plans.
- Nsight marker scaffold.
- Reflex marker scaffold.

It does not generate full host-renderer integration, full DLSS Frame Generation/Multi Frame Generation, RTXDI, full NRD integration, full path tracing, SDK downloads, or NVIDIA binary packaging.

## Validation Tools

- `nvidia_environment_probe`: local environment, GPU/driver, SDK/tool report.
- `nvidia_validation_harness`: command plans and pass/fail criteria.
- `nvidia_log_analyzer`: deterministic NVIDIA log findings.
- `nvidia_quality_compare`: local image/video quality checks.

## Release Tools

- `nvidia_sdk_header_grounding`: detected SDK root/version, relevant headers/symbols, missing symbols, confidence, and real-API generation gate.
- `nvidia_header_inspector`: local SDK header and symbol inspection.
- `nvidia_registry_audit`: source registry freshness and metadata audit.
- `nvidia_release_readiness`: release-candidate readiness report.
- `nvidia_submission_packager`: submission checklist and package guidance.

## Safety Tools

- `nvidia_validation_plan`
- `nvidia_known_issues_lookup`
- `nvidia_license_guard`

## Approval And Evidence Rules

- Tools that write files require explicit approval tokens.
- Tools that inspect headers do not imply the SDK is redistributable or package-ready.
- Binary copy/package/upload/download actions are safety and licensing boundaries.
- Missing SDKs, missing renderer contracts, unsupported browser-only paths, and missing validation artifacts are normal blocked states.
- No tool should claim implementation success from static source inspection alone.
