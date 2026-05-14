# Getting Started

Use this plugin when a project needs NVIDIA RTX, DLSS, Streamline, video, media, latency, profiling, or GPU content-pipeline guidance.

Start with:

```text
Classify this repo and choose the right NVIDIA route.
```

Then ask for:

```text
Create a repo-aware NVIDIA patch plan before implementation.
```

Before asking for real NVIDIA implementation work, evaluate the contract gates:

```text
Check strict implementation contracts for DLSS SR/DLAA in this renderer using my local Streamline SDK path.
```

For one combined readiness answer:

```text
Create an NVIDIA implementation readiness report for this renderer using my local SDK path. Tell me whether the state is ready_to_patch, blocked_missing_sdk, blocked_missing_renderer_contract, blocked_unsupported_project, unsafe_license_or_binary_boundary, validation_required, or implementation_verified.
```

For Unreal projects, run the dedicated validator:

```text
Validate this Unreal project for NVIDIA DLSS/Streamline plugin readiness and produce a safe config patch plan.
```

For Unity projects, run the HDRP readiness validator:

```text
Validate this Unity HDRP project for DLSS readiness, render pipeline evidence, and Reflex readiness without claiming FPS unless Unity runs.
```

For code-level guidance, provide local SDK paths when available:

```text
Inspect my local Streamline SDK headers at C:\SDKs\Streamline and produce code guidance for this renderer.
```

For real API guidance, the plugin checks observed header symbols first:

```text
Ground Streamline code guidance against C:\SDKs\Streamline and block any SDK calls that are not present in those headers.
```

For the first custom-renderer implementation kit:

```text
Create a D3D12 Streamline DLSS SR/DLAA implementation kit for this renderer using my local Streamline SDK headers.
```

For the first ray-tracing starter kit:

```text
Create a D3D12 DXR ray-tracing starter kit for basic shadows/reflections, with BLAS/TLAS, SBT, shader templates, fallback, and Nsight validation.
```

For NRD denoiser bridge work:

```text
Create an NRD denoiser bridge kit for noisy ray-traced signals, but block any working-denoising claim unless noisy signal, normals, roughness, depth, motion vectors, camera matrices, render resolution, temporal reset state, and local NRD headers are accounted for.
```

For RTX Video SDK native media enhancement:

```text
Create an RTX Video SDK native media enhancement pipeline kit for this media player, with input frame, color format, 8-bit/10-bit, SDR/HDR, DX11/DX12/Vulkan/CUDA route, output surface, and SR/artifact-reduction/SDR-to-HDR validation gates.
```

For Video Codec SDK/NVENC/NVDEC pipeline work:

```text
Create a Video Codec SDK NVENC/NVDEC native pipeline kit for this FFmpeg, GStreamer, or Python video pipeline, with encode/decode goal, codec, pixel format, bit depth, target platform, GPU capability, zero-copy validation, throughput, PSNR, SSIM, and VMAF gates.
```

For validation:

```text
Run a local NVIDIA environment probe and create a validation harness plan.
```

The plugin will not download SDKs, upload files, or package NVIDIA binaries.
