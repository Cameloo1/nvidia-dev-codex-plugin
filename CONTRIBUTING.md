# Contributing

Contributions are welcome. You can help with docs, tests, fixtures, bug reports, feature requests, and narrow implementation improvements.

## Good First Contributions

- Fix unclear documentation.
- Add examples for supported project types.
- Add test fixtures for Unreal, Unity, D3D12, RTX Video SDK, Video Codec SDK, FFmpeg, GStreamer, or Python video pipelines.
- Improve blocked-state messages so users know exactly what evidence is missing.
- Add tests for SDK/header detection, validation planning, or safety gates.

## Before Opening A Pull Request

1. Keep changes focused.
2. Do not add NVIDIA SDK binaries, redistributable DLLs, proprietary captures, private logs, credentials, or licensed files.
3. Do not claim runtime success, FPS, latency, throughput, image quality, hardware acceleration, or zero-copy behavior without local evidence artifacts.
4. Add or update tests when behavior changes.
5. Run the relevant checks from the README when possible.

## Pull Request Notes

Please describe:

- what changed;
- which plugin tools, docs, or fixtures were affected;
- what validation you ran;
- any missing SDK, hardware, driver, engine, or runtime evidence.

## Safety And Licensing

This project is not affiliated with NVIDIA. NVIDIA SDKs, headers, binaries, plugins, samples, documentation, and trademarks remain governed by NVIDIA's terms.

When in doubt, link to official NVIDIA docs instead of copying licensed SDK content into this repository.
