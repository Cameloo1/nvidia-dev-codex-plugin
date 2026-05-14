# Examples

These examples are intentionally scoped. Ask for a readiness report or implementation kit when moving beyond planning. Ask for compile/runtime verification only when you have local evidence artifacts.

## Custom Renderer

```text
Use nvidia-rtx-dlss to classify this D3D12 renderer, inspect local Streamline headers, and create a DLSS patch plan with validation and rollback.
```

Expected level: planning. This should not generate code or claim DLSS is implemented.

## D3D12 DLSS SR/DLAA Kit

```text
Create a gated D3D12 Streamline DLSS Super Resolution / DLAA implementation kit using this renderer and my local Streamline SDK path.
```

Expected level: SDK-backed scaffold generation. It should generate adapter/build/validation scaffolds only if the renderer contract and local headers are present.

## Implementation Readiness Report

```text
Create a structured NVIDIA implementation readiness report for this project. Combine classifier, SDK locator, header inspector, implementation contracts, patch plan, validation harness, and license guard. Do not claim implementation_verified unless compile and runtime evidence artifacts are supplied.
```

Expected level: single state report. Valid states include `ready_to_patch`, `blocked_missing_sdk`, `blocked_missing_renderer_contract`, `blocked_unsupported_project`, `unsafe_license_or_binary_boundary`, `validation_required`, and `implementation_verified`.

## D3D12 DXR Starter Kit

```text
Create a D3D12 DXR ray-tracing starter kit for basic ray-traced shadows/reflections, but block implementation if DXR readiness evidence is missing.
```

Expected level: scaffold generation. It should not claim RTXDI, full path tracing, or production ray tracing.

## NRD Denoiser Bridge Kit

```text
Create an NRD denoiser bridge kit for ReBLUR/ReLAX/SIGMA readiness, and keep it template-only if local NRD SDK headers or required frame inputs are missing.
```

Expected level: scaffold generation or template-only output. It should not claim denoising works without noisy signal, guide buffer, temporal state, and validation evidence.

## RTX Video Native Pipeline Kit

```text
Create an RTX Video SDK native media enhancement pipeline kit for this media player. Keep it separate from DLSS and Optical Flow FRUC, and block real implementation if local RTX Video SDK headers are missing.
```

Expected level: SDK-backed scaffold generation. It is for media enhancement, not game-frame DLSS, video encoding, or browser-only playback.

## Video Codec Native Pipeline Kit

```text
Create a Video Codec SDK NVENC/NVDEC native pipeline kit for this FFmpeg/GStreamer/Python video project. Require local `nvEncodeAPI.h`/`nvcuvid.h` evidence, block unsupported zero-copy claims, and generate throughput plus PSNR/SSIM/VMAF validation plans.
```

Expected level: scaffold and command-plan generation. It should not claim hardware acceleration, throughput, quality, or zero-copy until logs and metrics exist.

## Unreal

```text
Inspect this Unreal project and tell me whether the official NVIDIA DLSS plugin route is correct for its engine version.
```

Expected level: validation and patch planning. It should not download the Unreal plugin or copy binaries.

## Unity HDRP

```text
Validate this Unity project for HDRP DLSS readiness, URP/custom SRP routing, camera/render pipeline evidence, and Reflex readiness without fabricating profiler data.
```

Expected level: static readiness and validation planning. It should not report FPS, frame time, or runtime success unless Unity actually ran and produced artifacts.

## Media Player

```text
This is a media player, not a game. Route video upscaling and SDR-to-HDR to the correct NVIDIA SDK and produce a validation plan.
```

Expected route: RTX Video SDK for enhancement. Do not route this to DLSS.

## Encode/Decode

```text
Analyze this FFmpeg/GStreamer pipeline and recommend a NVENC/NVDEC strategy with throughput validation, quality metrics, and hardware-acceleration log checks.
```

Expected route: Video Codec SDK concepts, FFmpeg/GStreamer, or PyNvVideoCodec. Do not describe NVENC/NVDEC as CUDA-core work.

## Web/Electron

```text
Check whether this Electron app needs a native NVIDIA helper, pure WebGPU/WebCodecs, or server-side GPU route.
```

Expected route: explicit browser/native/backend boundary. Do not claim a pure browser app can directly call native NVIDIA SDKs.

## Compile Verification

```text
Create an implementation-readiness report using these compile logs, runtime logs, and validation artifacts. Only return implementation_verified if all evidence checks pass.
```

Expected level: compile/runtime evidence review. This is the only path that can produce `implementation_verified`.

## Release Readiness

```text
Run NVIDIA plugin release readiness and submission packaging checks.
```
