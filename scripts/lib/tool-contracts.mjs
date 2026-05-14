export const TOOL_CONTRACTS = [
  ["nvidia_project_classifier", "Classify repo type, language, APIs, build systems, content path, and NVIDIA dependencies."],
  ["nvidia_sdk_locator", "Locate local NVIDIA SDKs, headers, binaries, docs, tools, and acceleration clues."],
  ["nvidia_source_resolver", "Resolve local and official source evidence for NVIDIA technology claims."],
  ["nvidia_tech_router", "Map user goals and repo facts to the correct NVIDIA route with rejected alternatives."],
  ["nvidia_feature_requirements", "Report feature requirements, compatibility state, blockers, warnings, and missing info."],
  ["nvidia_implementation_contracts", "Evaluate strict pre-implementation contracts before real NVIDIA code-generation work."],
  ["nvidia_implementation_readiness_report", "Combine classifier, SDK/header discovery, contracts, patch plan, validation harness, license guard, and evidence into one ready/blocked/unsafe/verified state."],
  ["nvidia_unreal_dlss_validator", "Validate Unreal DLSS/Streamline plugin readiness and produce safe config patch plans."],
  ["nvidia_unity_hdrp_validator", "Validate Unity HDRP DLSS readiness, URP/custom SRP routing, Reflex readiness, and safe patch plans."],
  ["nvidia_integration_plan", "Produce source-backed implementation and validation planning."],
  ["nvidia_code_guidance", "Produce repo-aware implementation guidance without edits."],
  ["nvidia_patch_plan", "Produce reviewable patch plans, risks, validation, rollback, and approval gates."],
  ["nvidia_assisted_implementation", "Generate gated scaffold files/snippets for narrow workflows, including D3D12 Streamline DLSS SR/DLAA adapter kits, D3D12 DXR starter kits, NRD denoiser bridge kits, RTX Video SDK native media enhancement kits, and Video Codec SDK/NVENC/NVDEC native pipeline kits."],
  ["nvidia_environment_probe", "Report local environment, GPU/driver, SDK/tool, and project state."],
  ["nvidia_validation_harness", "Generate local validation command plans and pass/fail criteria."],
  ["nvidia_log_analyzer", "Parse NVIDIA-relevant local logs into deterministic findings."],
  ["nvidia_quality_compare", "Prepare or run local quality metrics with missing-tool handling."],
  ["nvidia_sdk_header_grounding", "Gate real API guidance on observed local SDK headers and required symbols."],
  ["nvidia_header_inspector", "Inspect local NVIDIA SDK headers and summarize observed symbols."],
  ["nvidia_registry_audit", "Audit source registry freshness, coverage, and release readiness."],
  ["nvidia_release_readiness", "Summarize docs, metadata, tests, registry, and tool contracts before release."],
  ["nvidia_submission_packager", "Prepare marketplace submission checklist and local package manifest guidance."],
  ["nvidia_validation_plan", "Produce technology-specific validation plans and metrics."],
  ["nvidia_known_issues_lookup", "Lookup official known issues and troubleshooting context."],
  ["nvidia_license_guard", "Check download, packaging, upload, redistribution, and trust-boundary concerns."]
];

export function toolContractSummaries() {
  return TOOL_CONTRACTS.map(([name, purpose]) => ({
    name,
    purpose,
    stability: "release_candidate",
    output_expectations: [
      "structured JSON",
      "explicit missing information",
      "source or local evidence where applicable",
      "no hidden uploads/downloads"
    ]
  }));
}
