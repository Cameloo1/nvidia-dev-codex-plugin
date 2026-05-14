# Limitations

- This plugin is not an NVIDIA SDK and does not include NVIDIA binaries.
- It does not automatically install Unreal, Unity, Streamline, RTX Video SDK, Video Codec SDK, CUDA, Nsight, or driver components.
- It does not perform full DLSS, RTX, ray-tracing, denoising, video enhancement, or codec integration in arbitrary projects.
- Implementation contracts are readiness gates, not proof that a renderer or media feature is implemented.
- The implementation-readiness report only returns `implementation_verified` when compile evidence, runtime evidence, and validation artifact files are supplied and pass deterministic marker checks.
- Unreal validation does not install plugins, copy NVIDIA binaries, or edit `.uproject` / `Config/*.ini` files without explicit approval.
- Unity HDRP validation is static readiness plus safe patch planning; it does not edit `ProjectSettings`, `Packages/manifest.json`, scenes, assets, or scripts without explicit approval.
- Unity HDRP validation does not report FPS, frame time, latency, profiler data, or runtime success unless a runnable Unity validation path actually produced artifacts.
- The D3D12 Streamline DLSS SR/DLAA kit creates a thin adapter, build wiring, and validation harness guidance; host renderer resource mapping remains explicit TODO work.
- The D3D12 kit does not generate DLSS Frame Generation, Multi Frame Generation, binary packaging, or finished runtime feature enablement.
- The D3D12 DXR starter kit is limited to basic ray-traced shadows/reflections scaffolding; it does not implement RTXDI, NRD, a full path tracer, or invasive render graph edits.
- The NRD bridge kit generates adapters and validation checklists only. It does not claim denoising works unless the project can provide noisy signals, guide buffers, motion vectors, camera state, render resolution, reset state, local NRD headers, and validation artifacts.
- The RTX Video native pipeline kit is for video enhancement only. It does not perform DLSS, Optical Flow FRUC frame interpolation, encode/decode control, browser-only native SDK calls, SDK downloads, or NVIDIA binary copying.
- The Video Codec native pipeline kit creates NVENC/NVDEC adapter scaffolds and FFmpeg/GStreamer/PyNvVideoCodec command plans only. It does not claim hardware acceleration, zero-copy, throughput, PSNR, SSIM, or VMAF results without local logs/artifacts.
- It does not claim pure browser apps can directly call native NVIDIA SDKs.
- Header-aware guidance depends on local SDK paths supplied by the user or found in the repo.
- Missing required header symbols block real SDK API guidance; generated output must stay template-only until headers are observed.
- Validation automation is local and best-effort; missing GPU/tools/SDKs are reported as environment state.
- NVIDIA Developer Forums are advisory only unless staff/date context is explicit.

## Capability Boundaries

- Planning output is not implementation.
- Scaffold generation is not integration.
- SDK-backed scaffold generation means local headers were observed; it does not mean the host app already supplies valid frame, video, codec, or ray-tracing resources.
- Compile verification requires build evidence from the target project.
- Runtime verification requires local runtime evidence such as logs, captures, quality metrics, throughput results, or validation artifacts.
- Verification applies only to the tested project, GPU, driver, SDK version, command, sample content, and configuration.

## Requires Local NVIDIA SDK/Header Evidence

- Streamline/DLSS/Reflex API guidance.
- D3D12 Streamline DLSS SR/DLAA implementation kit in real-API mode.
- NRD bridge work beyond template mode.
- RTX Video SDK native media enhancement kit beyond template mode.
- Video Codec SDK / NVENC / NVDEC native adapter work beyond command planning.

## Requires Explicit User Approval

- Any scaffold or artifact write.
- Any edit to project files.
- Any SDK download or credential-gated action.
- Any NVIDIA binary copy, package, release, redistribution, or signature-sensitive loading path.
- Any upload or sharing of source code, captures, videos, crash dumps, logs, SDK files, or proprietary artifacts.

## Blocked Until Project Contracts Are Satisfied

- DLSS work is blocked when color, depth, motion vectors, jitter, exposure, reset state, command-list/queue, or render insertion evidence is missing.
- DXR work is blocked when D3D12/DXR readiness, shader compilation, scene geometry, material/G-buffer access, insertion point, or fallback evidence is missing.
- NRD work is blocked when noisy signals, normals, roughness, depth/viewZ, motion vectors, camera matrices, render resolution, or temporal reset state is missing.
- RTX Video SDK work is blocked when decoded frame ownership, color format, bit depth, SDR/HDR path, native API route, or output surface ownership is missing.
- Video Codec SDK work is blocked when encode/decode goal, codec, pixel format, bit depth, target platform, GPU capability path, zero-copy validation, build/script path, or SDK headers are missing.

## Unsupported

- Arbitrary one-command RTX integration.
- Full DLSS Frame Generation or Multi Frame Generation implementation.
- Full RTXDI, full NRD renderer integration, full path tracing, or completed production renderer edits.
- Pure browser access to native NVIDIA SDKs.
- Game modding, DLL injection, driver-check bypassing, or unsupported runtime patching.
- Claims of performance, quality, hardware acceleration, zero-copy, or runtime correctness without local proof artifacts.
