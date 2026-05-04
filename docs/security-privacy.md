# Security And Privacy

The plugin is local-first and approval-gated.

It may read local project files, SDK headers, logs, and media paths when the user asks. It must not upload those artifacts unless the user explicitly names a destination and approves the action.

Blocked by default:

- SDK downloads.
- credential-gated actions.
- NVIDIA binary copying or packaging.
- upload of source, captures, logs, crash dumps, videos, images, or SDK files.
- browser-only native NVIDIA SDK claims.
- unsupported modding, injection, DRM bypass, or platform restriction bypass.

Artifact writes:

- scaffold files: `APPROVED_PHASE_3_EDITS`
- validation reports: `APPROVED_PHASE_4_ARTIFACTS`
