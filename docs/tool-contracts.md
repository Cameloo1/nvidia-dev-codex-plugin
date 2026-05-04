# Tool Contracts

All tools return structured JSON and avoid hidden network, download, upload, or packaging actions.

## Core Tools

- `nvidia_project_classifier`: classifies repo shape and NVIDIA-relevant signals.
- `nvidia_sdk_locator`: finds local SDK/tool/header/binary candidates.
- `nvidia_source_resolver`: resolves local and official source evidence.
- `nvidia_tech_router`: chooses correct NVIDIA technology route and rejected routes.
- `nvidia_feature_requirements`: reports requirements, blockers, warnings, and missing info.
- `nvidia_integration_plan`: produces source-backed integration and validation plan.

## Repo And Implementation Tools

- `nvidia_code_guidance`: guidance without edits.
- `nvidia_patch_plan`: reviewable patch plan with rollback.
- `nvidia_assisted_implementation`: scaffold generation with approval gates.

## Validation Tools

- `nvidia_environment_probe`: local environment, GPU/driver, SDK/tool report.
- `nvidia_validation_harness`: command plans and pass/fail criteria.
- `nvidia_log_analyzer`: deterministic NVIDIA log findings.
- `nvidia_quality_compare`: local image/video quality checks.

## Release Tools

- `nvidia_header_inspector`: local SDK header and symbol inspection.
- `nvidia_registry_audit`: source registry freshness and metadata audit.
- `nvidia_release_readiness`: release-candidate readiness report.
- `nvidia_submission_packager`: submission checklist and package guidance.

## Safety Tools

- `nvidia_validation_plan`
- `nvidia_known_issues_lookup`
- `nvidia_license_guard`
