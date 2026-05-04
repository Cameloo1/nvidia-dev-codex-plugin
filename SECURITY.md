# Security

This plugin is local-first.

It must not upload source code, logs, captures, crash dumps, videos, images, SDK files, or generated artifacts unless the user explicitly requests a destination.

It must not download NVIDIA SDKs, install tools, copy NVIDIA binaries, or package redistributables automatically.

Write gates:

- Phase 3 scaffold files require `approval_token=APPROVED_PHASE_3_EDITS`.
- Phase 4 validation artifacts require `approval_token=APPROVED_PHASE_4_ARTIFACTS`.

Report security issues or unsafe behavior in the plugin repository or private review channel used for this project.
