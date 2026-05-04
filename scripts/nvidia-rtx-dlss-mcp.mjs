#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { inspectNvidiaHeaders } from "./lib/header-inspector.mjs";
import { auditTechnologyRegistry } from "./lib/registry-audit.mjs";
import { toolContractSummaries } from "./lib/tool-contracts.mjs";

const VERSION = "1.0.0-rc.1";
const PROTOCOL_VERSION = "2024-11-05";
const CACHE_TTL_MS = Number(process.env.NVIDIA_RTX_DLSS_CACHE_TTL_MS || 30 * 60 * 1000);
const USER_AGENT = `nvidia-rtx-dlss-codex-plugin/${VERSION}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const REGISTRY_PATH = join(PLUGIN_ROOT, "data", "nvidia-technology-registry.json");
const registry = loadRegistry();
const cache = new Map();
let inputBuffer = Buffer.alloc(0);

const tools = [
  {
    name: "nvidia_project_classifier",
    description:
      "Inspect a repository and classify engine, language, graphics/media APIs, build system, content path, and NVIDIA-relevant dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository or project path. Defaults to current working directory." },
        max_files: { type: "number", default: 8000 },
        include_evidence: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_sdk_locator",
    description:
      "Locate local NVIDIA SDKs, plugins, docs, headers, binaries, tools, and common FFmpeg/GStreamer NVIDIA acceleration clues.",
    inputSchema: {
      type: "object",
      properties: {
        roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Additional roots to scan."
        },
        include_common_roots: { type: "boolean", default: true },
        max_files_per_root: { type: "number", default: 12000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_source_resolver",
    description:
      "Search the local NVIDIA technology registry, optional local SDK/docs paths, and optionally fetch official source pages for citation-grade context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Technology, feature, symbol, error, SDK version, or compatibility query." },
        technology: { type: "string", description: "Optional technology id or name filter." },
        local_paths: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional local SDK or docs paths to search first."
        },
        include_web_fetch: {
          type: "boolean",
          description: "Fetch official docs pages from the registry and search their text.",
          default: false
        },
        limit: { type: "number", default: 12 }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_tech_router",
    description:
      "Map a user goal and optional repo classification to the correct NVIDIA technology route, with rejected routes and source-backed reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "User goal or project description." },
        project_path: { type: "string", description: "Optional repo path to classify before routing." },
        project_summary: { type: "string", description: "Optional existing project summary." }
      },
      required: ["goal"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_feature_requirements",
    description:
      "Create a structured compatibility and missing-information report for a NVIDIA feature or technology route.",
    inputSchema: {
      type: "object",
      properties: {
        technology: { type: "string", description: "Technology id or name, such as dlss-streamline, optical-flow-fruc, rtx-video-sdk, video-codec-sdk, reflex, nsight-aftermath, rtx-kit, or web-boundary." },
        feature: { type: "string", description: "Optional feature name, such as DLSS Frame Generation, RTX Video Super Resolution, NVENC AV1, or Nsight Aftermath." },
        project_path: { type: "string" },
        target_os: { type: "string" },
        graphics_api: { type: "string" },
        engine: { type: "string" },
        gpu_generation: { type: "string" },
        sdk_version: { type: "string" },
        probe_environment: {
          type: "boolean",
          description: "Try local environment checks such as nvidia-smi. This is best-effort and never required.",
          default: false
        }
      },
      required: ["technology"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_integration_plan",
    description:
      "Produce the Phase 1 output contract: classification, recommended route, rejected routes, compatibility state, required data/resources, integration plan, validation plan, risks, and sources.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the user wants to build or fix." },
        project_path: { type: "string", description: "Optional repo path." },
        technology: { type: "string", description: "Optional forced technology route." },
        depth: { type: "string", enum: ["brief", "standard", "detailed"], default: "standard" }
      },
      required: ["goal"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_code_guidance",
    description:
      "Produce Phase 2 repo-aware, source-grounded code guidance without editing files. Covers Unreal, Unity HDRP, custom C++ renderers, FFmpeg/GStreamer, Python video, and web/native boundary projects.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the user wants to build, integrate, debug, or prepare." },
        project_path: { type: "string", description: "Optional repository or project path to inspect before guidance." },
        technology: { type: "string", description: "Optional forced NVIDIA technology route." },
        target_workflow: {
          type: "string",
          enum: ["auto", "unreal", "unity-hdrp", "custom-cpp-renderer", "ffmpeg-gstreamer", "python-video", "web-electron"],
          default: "auto"
        },
        max_files: { type: "number", default: 8000 },
        include_evidence: { type: "boolean", default: true }
      },
      required: ["goal"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_patch_plan",
    description:
      "Generate a Phase 2 repo-aware patch plan, files likely affected, risks, validation, and rollback. It does not perform edits and requires user approval before implementation.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The NVIDIA integration or modernization goal." },
        project_path: { type: "string", description: "Optional repository or project path to inspect before planning." },
        technology: { type: "string", description: "Optional forced NVIDIA technology route." },
        target_workflow: {
          type: "string",
          enum: ["auto", "unreal", "unity-hdrp", "custom-cpp-renderer", "ffmpeg-gstreamer", "python-video", "web-electron"],
          default: "auto"
        },
        risk_tolerance: { type: "string", enum: ["low", "medium", "high"], default: "low" },
        include_tests: { type: "boolean", default: true },
        include_rollback: { type: "boolean", default: true },
        max_files: { type: "number", default: 8000 },
        include_evidence: { type: "boolean", default: true }
      },
      required: ["goal"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_assisted_implementation",
    description:
      "Produce Phase 3 assisted implementation scaffolds for narrow approved workflows. Writes are off by default and only create new reviewable scaffold files when explicitly approved.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The implementation goal." },
        project_path: { type: "string", description: "Optional repository or project path to inspect and use as default output root." },
        technology: { type: "string", description: "Optional forced NVIDIA technology route." },
        workflow: {
          type: "string",
          enum: [
            "auto",
            "unreal-plugin-config-validation",
            "cmake-sdk-wiring",
            "streamline-init-scaffold",
            "video-codec-sample-adaptation",
            "rtx-video-pipeline-skeleton",
            "nsight-marker-insertion",
            "reflex-marker-scaffold"
          ],
          default: "auto"
        },
        sdk_root: { type: "string", description: "Optional user-provided SDK root path. This tool never downloads SDKs." },
        output_dir: {
          type: "string",
          description: "Optional output directory for generated scaffold files. Defaults to <project_path>/_nvidia_phase3_scaffolds when write_files is true."
        },
        write_files: {
          type: "boolean",
          default: false,
          description: "When false, return scaffold files and snippets only. When true, create new scaffold files only after approval_token is supplied."
        },
        approval_token: {
          type: "string",
          description: "Required exact value APPROVED_PHASE_3_EDITS when write_files is true."
        },
        max_files: { type: "number", default: 8000 },
        include_evidence: { type: "boolean", default: true }
      },
      required: ["goal"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_environment_probe",
    description:
      "Run Phase 4 local environment probing for OS, Node, NVIDIA GPU/driver, CUDA env vars, SDK/tool discovery, FFmpeg/GStreamer, and optional project classification.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Optional repository or project path to classify and use as default artifact root." },
        include_sdk_scan: { type: "boolean", default: true },
        include_process_tools: { type: "boolean", default: true },
        write_artifacts: { type: "boolean", default: false },
        output_dir: { type: "string" },
        approval_token: { type: "string", description: "Required exact value APPROVED_PHASE_4_ARTIFACTS when write_artifacts is true." }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_validation_harness",
    description:
      "Create Phase 4 local validation harness plans for sample launch checks, frame-capture checklists, codec throughput, and quality comparison planning.",
    inputSchema: {
      type: "object",
      properties: {
        technology: { type: "string" },
        workflow: { type: "string" },
        project_path: { type: "string" },
        sample_path: { type: "string" },
        command: { type: "string" },
        mode: {
          type: "string",
          enum: ["sample-launch-check", "frame-capture-checklist", "codec-throughput", "quality-compare-plan"]
        }
      },
      required: ["technology", "workflow", "mode"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_log_analyzer",
    description:
      "Parse local logs for NVIDIA-relevant Streamline/DLSS, Unreal plugin, NVENC/NVDEC, FFmpeg/GStreamer, Nsight, and Aftermath validation findings.",
    inputSchema: {
      type: "object",
      properties: {
        technology: { type: "string" },
        log_paths: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
        },
        project_path: { type: "string" },
        limit: { type: "number", default: 200 }
      },
      required: ["log_paths"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_quality_compare",
    description:
      "Prepare or run local image/video quality comparisons. FFmpeg-backed PSNR/SSIM/VMAF runs only when files and local FFmpeg support are available.",
    inputSchema: {
      type: "object",
      properties: {
        reference_path: { type: "string" },
        candidate_path: { type: "string" },
        metric_set: {
          type: "string",
          enum: ["video-basic", "image-basic", "ffmpeg-psnr-ssim", "ffmpeg-vmaf"],
          default: "video-basic"
        },
        write_artifacts: { type: "boolean", default: false },
        output_dir: { type: "string" },
        approval_token: { type: "string", description: "Required exact value APPROVED_PHASE_4_ARTIFACTS when write_artifacts is true." }
      },
      required: ["reference_path", "candidate_path"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_header_inspector",
    description:
      "Inspect local NVIDIA SDK headers and summarize observed headers/symbols so code guidance is based on installed SDK facts instead of hallucinated APIs.",
    inputSchema: {
      type: "object",
      properties: {
        roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "SDK, repo, or include roots to scan. Defaults to current working directory."
        },
        technology: { type: "string", description: "Optional technology id/name filter such as dlss-streamline or video-codec-sdk." },
        max_files: { type: "number", default: 12000 },
        include_snippets: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_registry_audit",
    description:
      "Audit the NVIDIA technology registry for source freshness, missing fields, unresolved source ids, and release-candidate readiness.",
    inputSchema: {
      type: "object",
      properties: {
        staleness_days: { type: "number", default: 90 }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_release_readiness",
    description:
      "Produce a release-candidate readiness report covering metadata, docs, tests, tool contracts, registry health, safety docs, and remaining gaps.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Optional project/plugin path. Defaults to plugin root." },
        include_environment_probe: { type: "boolean", default: false },
        include_registry_audit: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_submission_packager",
    description:
      "Prepare marketplace submission guidance, required files, metadata checks, privacy/security notes, and local packaging commands without uploading anything.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Optional plugin path. Defaults to plugin root." },
        target: { type: "string", enum: ["local-review", "codex-plugin-store", "github-release"], default: "local-review" }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_validation_plan",
    description:
      "Generate a technology-specific validation plan for DLSS/Streamline, RTX Video SDK, Video Codec SDK, Reflex, Nsight/Aftermath, RTX Kit, or web/native boundary workflows.",
    inputSchema: {
      type: "object",
      properties: {
        technology: { type: "string" },
        scenario: { type: "string" },
        project_path: { type: "string" },
        include_metrics: { type: "boolean", default: true }
      },
      required: ["technology"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_known_issues_lookup",
    description:
      "Search official sources and the registry for known issues, warnings, release-note context, and troubleshooting guidance. Forum context must be treated as advisory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        technology: { type: "string" },
        include_web_fetch: { type: "boolean", default: false },
        limit: { type: "number", default: 10 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_license_guard",
    description:
      "Check whether a proposed action touches NVIDIA downloads, binaries, SDK redistribution, signatures, production packaging, credentials, or proprietary artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Examples: download SDK, copy DLLs, package game, upload capture, inspect local SDK, generate plan." },
        technology: { type: "string" },
        files: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
        },
        destination: { type: "string" }
      },
      required: ["action"],
      additionalProperties: false
    }
  }
];

const handlers = {
  nvidia_project_classifier: handleProjectClassifier,
  nvidia_sdk_locator: handleSdkLocator,
  nvidia_source_resolver: handleSourceResolver,
  nvidia_tech_router: handleTechRouter,
  nvidia_feature_requirements: handleFeatureRequirements,
  nvidia_integration_plan: handleIntegrationPlan,
  nvidia_code_guidance: handleCodeGuidance,
  nvidia_patch_plan: handlePatchPlan,
  nvidia_assisted_implementation: handleAssistedImplementation,
  nvidia_environment_probe: handleEnvironmentProbe,
  nvidia_validation_harness: handleValidationHarness,
  nvidia_log_analyzer: handleLogAnalyzer,
  nvidia_quality_compare: handleQualityCompare,
  nvidia_header_inspector: handleHeaderInspector,
  nvidia_registry_audit: handleRegistryAudit,
  nvidia_release_readiness: handleReleaseReadiness,
  nvidia_submission_packager: handleSubmissionPackager,
  nvidia_validation_plan: handleValidationPlan,
  nvidia_known_issues_lookup: handleKnownIssuesLookup,
  nvidia_license_guard: handleLicenseGuard
};

if (process.argv.includes("--self-test")) {
  console.log(
    JSON.stringify(
      {
        name: "nvidia-rtx-dlss",
        version: VERSION,
        registry_version: registry.schema_version,
        technologies: registry.technologies.map((item) => item.id),
        tools: tools.map((tool) => tool.name)
      },
      null,
      2
    )
  );
  process.exit(0);
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  for (;;) {
    const message = readMessage();
    if (!message) return;
    void handleMessage(message);
  }
});

process.stdin.on("end", () => {
  // Allow in-flight async work to complete before Node exits naturally.
});

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.id === undefined || message.id === null) {
    return;
  }

  try {
    if (message.method === "initialize") {
      sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "nvidia-rtx-dlss", version: VERSION }
      });
      return;
    }

    if (message.method === "tools/list") {
      sendResult(message.id, { tools });
      return;
    }

    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const handler = handlers[name];
      if (!handler) throw new McpError(-32602, `Unknown tool: ${name}`);
      const result = await handler(args);
      sendResult(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      });
      return;
    }

    sendError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    sendError(message.id, error instanceof McpError ? error.code : -32000, errorMessage(error), error?.data);
  }
}

async function handleProjectClassifier(args) {
  const root = resolveInputPath(args.path || process.cwd());
  const inventory = inventoryProject(root, {
    maxFiles: clampInt(args.max_files, 8000, 100, 50000),
    includeEvidence: args.include_evidence !== false
  });
  return {
    tool: "nvidia_project_classifier",
    root,
    scanned_files: inventory.scannedFiles,
    classification: classifyInventory(inventory),
    evidence: args.include_evidence === false ? undefined : inventory.evidence,
    confidence_notes: [
      "Classification is based on observable files and shallow text scans.",
      "Project source and build files remain the final arbiter.",
      "If important SDK folders are outside the repo, run nvidia_sdk_locator with explicit roots."
    ],
    sources: sourceRefs(["nvidia-dlss", "nvidia-streamline-page", "rtx-video-sdk", "video-codec-sdk", "webgpu-explainer"])
  };
}

async function handleSdkLocator(args) {
  const roots = buildSdkRoots(args);
  const results = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    const found = scanForSdks(root, clampInt(args.max_files_per_root, 12000, 100, 100000));
    results.push(...found);
  }

  return {
    tool: "nvidia_sdk_locator",
    scanned_roots: [...seen],
    found: dedupeSdkFinds(results),
    missing_is_not_failure: true,
    notes: [
      "This locator never assumes SDK presence.",
      "Pass explicit SDK roots when NVIDIA SDKs are installed outside common paths.",
      "Downloads or credential-gated SDK actions require separate user approval."
    ],
    sources: sourceRefs(["streamline-releases", "nvidia-optical-flow-sdk", "rtx-video-sdk", "video-codec-sdk", "nvidia-reflex", "rtx-kit"])
  };
}

async function handleSourceResolver(args) {
  const query = String(args.query || args.technology || "").trim();
  if (!query) throw new McpError(-32602, "query or technology is required");

  const limit = clampInt(args.limit, 12, 1, 50);
  const localMatches = searchLocalPaths(normalizeStringList(args.local_paths), query, limit);
  const registryMatches = searchRegistry(query, args.technology, limit);
  const webMatches = args.include_web_fetch ? await fetchAndSearchOfficialSources(registryMatches, query, limit) : [];

  return {
    tool: "nvidia_source_resolver",
    query,
    retrieval_date: new Date().toISOString(),
    source_policy: registry.policy.source_ranking,
    local_matches: localMatches,
    registry_matches: registryMatches.slice(0, limit),
    fetched_official_matches: webMatches.slice(0, limit),
    freshness_notes: [
      "Local SDK docs and headers should outrank generic web pages for implementation details.",
      "If local SDK version differs from the registry baseline, prefer local version-specific docs.",
      "include_web_fetch only fetches allowlisted official NVIDIA/GitHub/standards URLs from the registry."
    ]
  };
}

async function handleTechRouter(args) {
  const project = args.project_path ? classifyInventory(inventoryProject(resolveInputPath(args.project_path), { maxFiles: 8000, includeEvidence: true })) : null;
  const route = routeGoal(args.goal, args.project_summary, project);
  return {
    tool: "nvidia_tech_router",
    goal: args.goal,
    project_classification: project,
    recommended_routes: route.recommended,
    rejected_routes: route.rejected,
    routing_principle: "Route the content pipeline before implementation. DLSS is not a generic video enhancer, and RTX Video SDK is not a game-frame DLSS substitute.",
    missing_information: route.missing,
    assumptions: route.assumptions,
    sources: route.sources
  };
}

async function handleFeatureRequirements(args) {
  const tech = findTechnology(args.technology);
  if (!tech) throw new McpError(-32602, `Unknown technology: ${args.technology}`);

  const project = args.project_path ? classifyInventory(inventoryProject(resolveInputPath(args.project_path), { maxFiles: 8000, includeEvidence: true })) : null;
  const env = args.probe_environment ? probeEnvironment() : null;
  const report = requirementsReport(tech, args, project, env);

  return {
    tool: "nvidia_feature_requirements",
    technology: tech.id,
    feature: args.feature || null,
    compatibility_state: report.compatibility_state,
    known_inputs: report.known_inputs,
    required_checks: report.required_checks,
    missing_information: report.missing_information,
    blockers: report.blockers,
    warnings: report.warnings,
    environment_probe: env,
    project_classification: project,
    sources: sourceRefs(tech.official_sources)
  };
}

async function handleIntegrationPlan(args) {
  const project = args.project_path ? classifyInventory(inventoryProject(resolveInputPath(args.project_path), { maxFiles: 8000, includeEvidence: true })) : null;
  const route = args.technology
    ? routeFromTechnology(args.technology)
    : routeGoal(args.goal, "", project);
  const primary = route.recommended[0];
  if (!primary) throw new McpError(-32602, "No NVIDIA route could be selected from the provided goal.");
  const tech = findTechnology(primary.technology_id) || findTechnology(args.technology);
  const requirements = tech ? requirementsReport(tech, args, project, null) : null;

  return {
    tool: "nvidia_integration_plan",
    phase: "Phase 1 source-grounded planner",
    edit_policy: "No repository edits are performed by this tool. Use nvidia_patch_plan for Phase 2 repo-aware patch planning before any approved implementation work.",
    classification: project || {
      state: "needs_inspection",
      note: "No project_path provided; classification is inferred from the goal text only."
    },
    recommended_nvidia_route: primary,
    why_this_route: primary.reasoning,
    rejected_routes: route.rejected,
    compatibility_state: requirements?.compatibility_state || "needs_inspection",
    required_data_resources: requiredResourcesFor(primary.technology_id),
    integration_plan: integrationSteps(primary.technology_id, args.goal, args.depth || "standard"),
    validation_plan: validationSteps(primary.technology_id),
    risks: riskList(primary.technology_id),
    missing_information: [...(route.missing || []), ...(requirements?.missing_information || [])],
    assumptions: route.assumptions,
    sources: primary.sources || (tech ? sourceRefs(tech.official_sources) : [])
  };
}

async function handleCodeGuidance(args) {
  const context = buildPhase2Context(args);
  const workflow = phase2WorkflowPlan(context);

  return {
    tool: "nvidia_code_guidance",
    phase: "Phase 2 repo-aware code guidance",
    edit_policy: "No target repository files are edited by this tool. It produces inspection-grounded guidance only.",
    approval_gate: "Use nvidia_patch_plan next for reviewable steps; implementation edits require a separate explicit user approval.",
    classification: context.project || {
      state: "needs_inspection",
      note: "No project_path provided; guidance is based on the goal and selected technology route."
    },
    repo_workflow: context.workflow,
    recommended_nvidia_route: context.primaryRoute,
    rejected_routes: context.route.rejected,
    compatibility_state: context.requirements?.compatibility_state || "needs_inspection",
    no_edit_diagnosis: noEditDiagnosis(context, workflow),
    code_guidance: workflow.code_guidance,
    source_backed_constraints: workflow.source_backed_constraints,
    likely_files: workflow.likely_files,
    missing_information: phase2MissingInformation(context, workflow),
    validation_requirements: workflow.validation_focus,
    risks: workflow.risks,
    sources: workflow.sources
  };
}

async function handlePatchPlan(args) {
  const context = buildPhase2Context(args);
  const workflow = phase2WorkflowPlan(context);
  const riskTolerance = args.risk_tolerance || "low";

  return {
    tool: "nvidia_patch_plan",
    phase: "Phase 2 repo-aware patch planning",
    edit_policy: "Plan only. Do not modify target repo files from this tool output.",
    approval_gate: "Before any Phase 3 implementation, ask the user to approve this patch plan and confirm SDK/license/download boundaries.",
    classification: context.project || {
      state: "needs_inspection",
      note: "No project_path provided; patch plan is a route-specific template and must be re-run after repo inspection."
    },
    repo_workflow: context.workflow,
    recommended_nvidia_route: context.primaryRoute,
    rejected_routes: context.route.rejected,
    compatibility_state: context.requirements?.compatibility_state || "needs_inspection",
    no_edit_diagnosis: noEditDiagnosis(context, workflow),
    files_likely_affected: workflow.likely_files,
    patch_plan: tunePatchPlanForRisk(workflow.patch_plan, riskTolerance),
    risk_analysis: {
      risk_tolerance: riskTolerance,
      risks: workflow.risks,
      regression_hotspots: workflow.regression_hotspots
    },
    validation_plan: args.include_tests === false ? workflow.validation_focus : workflow.validation_plan,
    rollback_plan: args.include_rollback === false ? undefined : workflow.rollback_plan,
    license_guard: licenseGuardSummary(context),
    missing_information: phase2MissingInformation(context, workflow),
    sources: workflow.sources
  };
}

async function handleAssistedImplementation(args) {
  const context = buildPhase3Context(args);
  const implementation = phase3ImplementationPackage(context, args);
  const writtenFiles = writeImplementationFiles(implementation.files, context, args);

  return {
    tool: "nvidia_assisted_implementation",
    phase: "Phase 3 assisted implementation",
    edit_policy:
      "This tool generates narrow, reviewable implementation scaffolds. It does not alter existing target files; write_files only creates new scaffold files after explicit approval.",
    approval_gate:
      args.write_files === true
        ? "write_files was requested and approval_token was accepted before creating scaffold files."
        : "No files were written. To create scaffolds, call again with write_files=true and approval_token=APPROVED_PHASE_3_EDITS.",
    workflow: context.phase3Workflow,
    classification: context.project || {
      state: "needs_inspection",
      note: "No project_path provided; implementation scaffolds are generic for the selected workflow."
    },
    recommended_nvidia_route: context.primaryRoute,
    rejected_routes: context.route.rejected,
    compatibility_state: context.requirements?.compatibility_state || "needs_inspection",
    sdk_root: context.sdkRoot,
    implementation_package: implementation,
    written_files: writtenFiles,
    host_repo_edits_required_after_scaffold: implementation.host_repo_edits_required,
    validation_plan: implementation.validation_plan,
    rollback_plan: implementation.rollback_plan,
    license_guard: licenseGuardSummary(context),
    missing_information: phase3MissingInformation(context, implementation),
    sources: implementation.sources
  };
}

async function handleEnvironmentProbe(args) {
  const projectRoot = args.project_path ? resolveInputPath(args.project_path) : null;
  const project = projectRoot && existsSync(projectRoot)
    ? classifyInventory(inventoryProject(projectRoot, { maxFiles: 8000, includeEvidence: true }))
    : null;
  const report = buildEnvironmentReport({
    projectRoot,
    includeSdkScan: args.include_sdk_scan !== false,
    includeProcessTools: args.include_process_tools !== false,
    project
  });
  const writtenArtifacts = writePhase4Artifacts(
    [
      {
        relative_path: "environment-report.json",
        content: `${JSON.stringify(report, null, 2)}\n`
      }
    ],
    { projectRoot },
    args
  );

  return {
    tool: "nvidia_environment_probe",
    phase: "Phase 4 validation automation",
    artifact_policy:
      args.write_artifacts === true
        ? "write_artifacts requested and approval_token accepted before writing local artifacts."
        : "No artifacts were written. Use write_artifacts=true and approval_token=APPROVED_PHASE_4_ARTIFACTS to write local reports.",
    report,
    written_artifacts: writtenArtifacts,
    warnings: environmentWarnings(report),
    sources: sourceRefs(["streamline-releases", "nvidia-optical-flow-sdk", "rtx-video-sdk", "video-codec-sdk", "nsight-graphics"])
  };
}

async function handleValidationHarness(args) {
  const tech = findTechnology(args.technology);
  const projectRoot = args.project_path ? resolveInputPath(args.project_path) : null;
  const samplePath = args.sample_path ? resolveInputPath(args.sample_path) : null;
  const harness = buildValidationHarness({
    technology: tech,
    technologyInput: args.technology,
    workflow: args.workflow,
    projectRoot,
    samplePath,
    command: args.command,
    mode: args.mode
  });

  return {
    tool: "nvidia_validation_harness",
    phase: "Phase 4 validation automation",
    mode: args.mode,
    technology: tech?.id || args.technology,
    workflow: args.workflow,
    execution_state: harness.execution_state,
    blocked_reasons: harness.blocked_reasons,
    command_plan: harness.command_plan,
    required_tools: harness.required_tools,
    expected_artifacts: harness.expected_artifacts,
    pass_fail_criteria: harness.pass_fail_criteria,
    safety_notes: harness.safety_notes,
    rollback_notes: harness.rollback_notes,
    sources: harness.sources
  };
}

async function handleLogAnalyzer(args) {
  const paths = normalizeStringList(args.log_paths).map(resolveInputPath);
  const limit = clampInt(args.limit, 200, 1, 2000);
  const analysis = analyzeLogs(paths, args.technology, limit);
  return {
    tool: "nvidia_log_analyzer",
    phase: "Phase 4 validation automation",
    technology: args.technology || null,
    scanned_paths: paths,
    findings_by_severity: groupFindingsBySeverity(analysis.findings),
    findings: analysis.findings,
    unreadable_paths: analysis.unreadable_paths,
    caveats: [
      "Log parsing is deterministic pattern matching, not proof of correctness.",
      "Use local SDK docs and runtime validation before changing implementation.",
      "Forum-derived or informal log interpretations are not used as normative sources."
    ],
    sources: sourceRefs(["streamline-programming-guide", "streamline-dlssg-guide", "video-codec-sdk", "nsight-graphics", "nsight-graphics-2025-2"])
  };
}

async function handleQualityCompare(args) {
  const referencePath = resolveInputPath(args.reference_path);
  const candidatePath = resolveInputPath(args.candidate_path);
  const metricSet = args.metric_set || "video-basic";
  const result = buildQualityCompareResult(referencePath, candidatePath, metricSet);
  const writtenArtifacts = writePhase4Artifacts(
    [
      {
        relative_path: `quality-compare-${metricSet}.json`,
        content: `${JSON.stringify(result, null, 2)}\n`
      }
    ],
    { projectRoot: null },
    args
  );

  return {
    tool: "nvidia_quality_compare",
    phase: "Phase 4 validation automation",
    metric_set: metricSet,
    execution_state: result.execution_state,
    command_plan: result.command_plan,
    parsed_metrics: result.parsed_metrics,
    missing_requirements: result.missing_requirements,
    actionable_errors: result.actionable_errors,
    written_artifacts: writtenArtifacts,
    safety_notes: [
      "Quality comparison is local-only and does not upload media.",
      "Use license-approved test media.",
      "VMAF is only available when local FFmpeg includes libvmaf."
    ],
    sources: sourceRefs(["video-codec-sdk", "rtx-video-sdk"])
  };
}

async function handleHeaderInspector(args) {
  const roots = normalizeStringList(args.roots);
  const result = inspectNvidiaHeaders({
    roots: roots.length ? roots.map(resolveInputPath) : [process.cwd()],
    technology: args.technology,
    max_files: args.max_files,
    include_snippets: args.include_snippets === true
  });
  return {
    tool: "nvidia_header_inspector",
    phase: "Phase 5 production hardening",
    source_policy: "Observed local headers outrank generic docs for code-level guidance.",
    technology: args.technology || null,
    ...result,
    sources: sourceRefs(["streamline-programming-guide", "video-codec-sdk", "nvidia-optical-flow-sdk", "rtx-video-sdk", "nvidia-reflex", "nsight-graphics"])
  };
}

async function handleRegistryAudit(args) {
  const audit = auditTechnologyRegistry(registry, {
    staleness_days: clampInt(args.staleness_days, 90, 1, 10000)
  });
  return {
    tool: "nvidia_registry_audit",
    phase: "Phase 5 production hardening",
    audit,
    release_gate:
      audit.readiness_score >= 85 && !audit.missing_source_fields.length
        ? "registry_release_candidate"
        : "registry_needs_refresh_before_marketplace_submission"
  };
}

async function handleReleaseReadiness(args) {
  const root = args.project_path ? resolveInputPath(args.project_path) : PLUGIN_ROOT;
  const manifest = safeJson(join(root, ".codex-plugin", "plugin.json"));
  const docs = releaseDocsStatus(root);
  const scripts = releaseScriptStatus(root);
  const registryAudit = args.include_registry_audit === false ? null : auditTechnologyRegistry(registry, { staleness_days: 90 });
  const env = args.include_environment_probe ? buildEnvironmentReport({ projectRoot: root, includeSdkScan: false, includeProcessTools: true, project: null }) : null;
  const checklist = releaseChecklist({ root, manifest, docs, scripts, registryAudit });
  return {
    tool: "nvidia_release_readiness",
    phase: "Phase 5 production hardening",
    root,
    version: VERSION,
    manifest_summary: manifest
      ? {
          name: manifest.name,
          version: manifest.version,
          display_name: manifest.interface?.displayName,
          description: manifest.description
        }
      : null,
    tool_contracts: toolContractSummaries(),
    docs,
    scripts,
    registry_audit: registryAudit
      ? {
          readiness_score: registryAudit.readiness_score,
          source_count: registryAudit.source_count,
          technology_count: registryAudit.technology_count,
          stale_source_count: registryAudit.stale_source_count,
          missing_source_field_count: registryAudit.missing_source_fields.length,
          recommendation_count: registryAudit.recommendations.length
        }
      : null,
    environment_probe: env,
    readiness: checklist,
    sources: sourceRefs(["nvidia-dlss", "nvidia-streamline-page", "rtx-video-sdk", "video-codec-sdk", "rtx-kit"])
  };
}

async function handleSubmissionPackager(args) {
  const root = args.project_path ? resolveInputPath(args.project_path) : PLUGIN_ROOT;
  const target = args.target || "local-review";
  const manifest = safeJson(join(root, ".codex-plugin", "plugin.json"));
  const docs = releaseDocsStatus(root);
  const requiredFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "PRIVACY.md",
    "docs/getting-started.md",
    "docs/examples.md",
    "docs/limitations.md",
    "docs/tool-contracts.md",
    "docs/source-policy.md",
    "docs/changelog.md",
    "scripts/nvidia-rtx-dlss-mcp.mjs",
    "data/nvidia-technology-registry.json"
  ];
  return {
    tool: "nvidia_submission_packager",
    phase: "Phase 5 marketplace polish",
    target,
    root,
    upload_policy: "No upload is performed by this tool.",
    manifest_summary: manifest
      ? {
          name: manifest.name,
          version: manifest.version,
          display_name: manifest.interface?.displayName,
          category: manifest.interface?.category,
          capabilities: manifest.interface?.capabilities
        }
      : null,
    required_files: requiredFiles.map((file) => ({
      path: file,
      exists: existsSync(join(root, ...file.split("/")))
    })),
    docs,
    package_commands: [
      "node scripts/nvidia-rtx-dlss-mcp.mjs --self-test",
      "powershell -ExecutionPolicy Bypass -File scripts/tests/test-production-readiness.ps1",
      "Create a zip/tarball from the plugin root only after tests pass and license/privacy docs are reviewed."
    ],
    review_notes: [
      "Confirm author metadata is not placeholder text.",
      "Confirm NVIDIA SDK binaries are not bundled.",
      "Confirm docs state local-only validation and approval-gated artifacts.",
      "Confirm source registry verified dates are current enough for submission."
    ]
  };
}

async function handleValidationPlan(args) {
  const tech = findTechnology(args.technology);
  if (!tech) throw new McpError(-32602, `Unknown technology: ${args.technology}`);
  const project = args.project_path ? classifyInventory(inventoryProject(resolveInputPath(args.project_path), { maxFiles: 8000, includeEvidence: true })) : null;
  return {
    tool: "nvidia_validation_plan",
    technology: tech.id,
    scenario: args.scenario || null,
    classification: project,
    validation_plan: validationSteps(tech.id, args.include_metrics !== false),
    expected_artifacts: expectedArtifacts(tech.id),
    metrics: args.include_metrics === false ? undefined : metricsFor(tech.id),
    failure_modes: riskList(tech.id),
    sources: sourceRefs(tech.official_sources)
  };
}

async function handleKnownIssuesLookup(args) {
  const registryHits = searchKnownIssues(args.query, args.technology);
  const sourceHits = args.include_web_fetch
    ? await fetchAndSearchOfficialSources(searchRegistry(args.query, args.technology, 10), args.query, clampInt(args.limit, 10, 1, 50))
    : [];

  return {
    tool: "nvidia_known_issues_lookup",
    query: args.query,
    advisory_policy: "Official docs and release notes are normative. Forum-derived context must be dated and marked advisory.",
    registry_hits: registryHits.slice(0, clampInt(args.limit, 10, 1, 50)),
    fetched_official_matches: sourceHits,
    forum_policy: "NVIDIA Developer Forums are not queried by this MVP tool unless future versions add an explicit forum search mode with staff/date labeling.",
    sources: sourceRefs(["streamline-programming-guide", "streamline-dlssg-guide", "streamline-releases", "nvidia-optical-flow-sdk", "nvidia-nvofa-fruc-guide", "rtx-video-sdk", "video-codec-sdk", "nsight-graphics"])
  };
}

async function handleLicenseGuard(args) {
  const action = lower(args.action);
  const files = normalizeStringList(args.files);
  const binaryLike = files.filter((file) => /\.(dll|so|dylib|lib|a|exe|bin|zip|7z)$/i.test(file));
  const wantsDownload = /download|fetch|install|get sdk|sdk/.test(action);
  const wantsPackage = /package|ship|redistribute|publish|release|bundle|copy/.test(action);
  const wantsUpload = /upload|share|send/.test(action);
  const tech = args.technology ? findTechnology(args.technology) : null;

  const decisions = [];
  if (wantsDownload) {
    decisions.push({
      decision: "ask_user_first",
      reason: "NVIDIA SDK downloads can be license-gated or credential-gated. Use official download pages or user-provided SDK paths."
    });
  }
  if (wantsPackage || binaryLike.length) {
    decisions.push({
      decision: "license_review_required",
      reason: "Packaging or copying NVIDIA binaries requires the user's license terms to permit redistribution. Use production/non-watermarked libraries where official docs require it."
    });
  }
  if (wantsUpload) {
    decisions.push({
      decision: "explicit_destination_required",
      reason: "Do not upload proprietary code, captures, crash dumps, images, videos, or SDK files unless the user explicitly approves the destination."
    });
  }
  if (!decisions.length) {
    decisions.push({
      decision: "plan_only_ok",
      reason: "Planning, local inspection, and citation lookup do not copy, download, redistribute, or upload NVIDIA assets."
    });
  }

  return {
    tool: "nvidia_license_guard",
    action: args.action,
    technology: tech?.id || args.technology || null,
    files,
    destination: args.destination || null,
    decisions,
    required_user_approval: decisions.some((item) => item.decision !== "plan_only_ok"),
    trust_boundaries: [
      "public docs",
      "local SDK docs",
      "source code",
      "user-provided credentials",
      "generated plans",
      "generated code edits",
      "packaged artifacts"
    ],
    sources: sourceRefs(["streamline-programming-guide", "streamline-releases", "nvidia-optical-flow-download", "rtx-video-sdk", "video-codec-sdk"])
  };
}

function inventoryProject(root, options) {
  const maxFiles = options.maxFiles || 8000;
  const evidence = [];
  const files = [];
  const ignoredDirs = new Set([
    ".git",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "Library",
    "Temp",
    "Saved",
    "Intermediate",
    ".vs",
    ".idea",
    ".vscode"
  ]);

  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const relative = relativePath(root, full);
        files.push({ full, relative, name: entry.name, ext: extname(entry.name).toLowerCase() });
      }
    }
  }

  walk(root);
  const contentIndex = [];
  for (const file of files) {
    if (!isInterestingForText(file)) continue;
    const text = safeRead(file.full, 120000);
    if (text) contentIndex.push({ ...file, text });
  }

  const addEvidence = (kind, signal, file, detail) => {
    evidence.push({ kind, signal, file: file?.relative || file || null, detail });
  };

  return { root, files, contentIndex, evidence, addEvidence, scannedFiles: files.length };
}

function classifyInventory(inventory) {
  const scores = {};
  const languages = new Set();
  const graphicsApis = new Set();
  const buildSystems = new Set();
  const existingNvidia = new Set();
  const contentPaths = new Set();
  const targetPlatforms = new Set();

  const bump = (key, amount = 1) => {
    scores[key] = (scores[key] || 0) + amount;
  };
  const evidence = inventory.evidence;
  const add = (kind, signal, file, detail) => inventory.addEvidence(kind, signal, file, detail);
  const hasPath = (pattern) => inventory.files.find((file) => pattern.test(file.relative.replaceAll("\\", "/")));
  const hasText = (pattern) => inventory.contentIndex.find((file) => pattern.test(file.text) || pattern.test(file.relative));

  for (const file of inventory.files) {
    const rel = file.relative.replaceAll("\\", "/");
    if (/\.uproject$/i.test(file.name)) {
      bump("unreal", 10);
      contentPaths.add("real_time_rendering");
      buildSystems.add("Unreal Build Tool");
      languages.add("C++");
      add("engine", "Unreal .uproject", file, rel);
    }
    if (/\.uplugin$/i.test(file.name)) {
      bump("unreal", 2);
      add("engine", "Unreal plugin", file, rel);
    }
    if (/ProjectSettings\/ProjectVersion\.txt$/i.test(rel) || /Packages\/manifest\.json$/i.test(rel)) {
      bump("unity", 3);
      add("engine", "Unity project structure", file, rel);
    }
    if (/package\.json$/i.test(file.name)) {
      buildSystems.add("npm");
      languages.add("TypeScript/JavaScript");
      bump("web_or_electron", 1);
    }
    if (/^(pyproject\.toml|requirements\.txt|environment\.ya?ml|Pipfile)$/i.test(file.name)) {
      buildSystems.add("Python");
      languages.add("Python");
      bump("python_video", /video|decode|encode|ffmpeg|opencv|cv2|dataset|preprocess/i.test(rel) ? 3 : 1);
    }
    if (/CMakeLists\.txt$/i.test(file.name)) {
      buildSystems.add("CMake");
      bump("custom_cpp", 2);
      add("build", "CMake", file, rel);
    }
    if (/\.(sln|vcxproj)$/i.test(file.name)) {
      buildSystems.add("MSBuild/Visual Studio");
      bump("custom_cpp", 2);
    }
    if (/\.(cpp|cc|cxx|hpp|h|inl)$/i.test(file.name)) {
      languages.add("C/C++");
      bump("custom_cpp", 1);
    }
    if (/\.cs$/i.test(file.name)) languages.add("C#");
    if (/\.rs$/i.test(file.name)) languages.add("Rust");
    if (/\.py$/i.test(file.name)) languages.add("Python");
    if (/\.(hlsl|glsl|slang|fx|shader)$/i.test(file.name)) languages.add("Shader languages");
    if (/\.cu$/i.test(file.name)) {
      languages.add("CUDA");
      existingNvidia.add("CUDA");
      bump("cuda_pipeline", 3);
    }
    if (/DLSS|Streamline|NVIDIA|NVIDIA DLSS/i.test(rel)) {
      existingNvidia.add("NVIDIA project artifact");
      bump("nvidia_present", 1);
    }
    if (/ffmpeg|libav|gstreamer|gst/i.test(rel)) {
      bump("video_pipeline", 2);
      contentPaths.add("video_encode_decode");
    }
  }

  for (const file of inventory.contentIndex) {
    const text = file.text;
    const rel = file.relative.replaceAll("\\", "/");
    if (/com\.unity\.render-pipelines\.high-definition/i.test(text)) {
      bump("unity_hdrp", 10);
      contentPaths.add("real_time_rendering");
      add("engine", "Unity HDRP package", file, "com.unity.render-pipelines.high-definition");
    }
    if (/electron/i.test(text) && /package\.json$/i.test(file.name)) {
      bump("electron", 8);
      targetPlatforms.add("desktop_web_hybrid");
      add("platform", "Electron dependency or script", file, "electron");
    }
    if (/manifest_version"\s*:\s*3|manifest_version\s*:\s*3/i.test(text) && /manifest\.json$/i.test(file.name)) {
      bump("browser_extension", 8);
      targetPlatforms.add("browser");
      add("platform", "Chrome/Chromium Manifest V3", file, "manifest_version: 3");
    }
    if (/nativeMessaging|native_messaging|offscreen|tabCapture|content_scripts|service_worker/i.test(text) && /manifest\.json$|package\.json$/i.test(file.name)) {
      bump("web_or_electron", 3);
      targetPlatforms.add("browser");
      add("platform", "web/native boundary clue", file, snippetFor(text, tokenize("native messaging offscreen tabCapture content_scripts service_worker")));
    }
    if (/navigator\.gpu|GPUDevice|GPUCanvasContext|webgpu/i.test(text)) {
      bump("browser_webgpu", 5);
      graphicsApis.add("WebGPU");
      targetPlatforms.add("browser");
    }
    if (/WebCodecs|VideoDecoder|VideoEncoder/i.test(text)) {
      bump("browser_video", 5);
      contentPaths.add("browser_video");
      targetPlatforms.add("browser");
    }
    if (/d3d12\.h|ID3D12|Direct3D\s*12|D3D12/i.test(text)) {
      graphicsApis.add("D3D12");
      bump("custom_cpp_renderer", 3);
    }
    if (/d3d11\.h|ID3D11|Direct3D\s*11|D3D11/i.test(text)) {
      graphicsApis.add("D3D11");
      bump("custom_cpp_renderer", 3);
    }
    if (/vulkan\/vulkan\.h|VkInstance|VkDevice|Vulkan/i.test(text)) {
      graphicsApis.add("Vulkan");
      bump("custom_cpp_renderer", 3);
    }
    if (/OpenGL|glfw|glad|glew/i.test(text)) graphicsApis.add("OpenGL");
    if (/sl\.h|sl_dlss|sl::|sl\.interposer|Streamline/i.test(text) || /Streamline/i.test(rel)) {
      existingNvidia.add("Streamline");
      bump("streamline_existing", 8);
    }
    if (/nvngx|DLSS|Ray Reconstruction|Frame Generation/i.test(text)) {
      existingNvidia.add("DLSS/NGX");
      bump("dlss_existing", 5);
    }
    if (/NVAPI|nvapi/i.test(text)) existingNvidia.add("NVAPI");
    if (/Reflex|NvLowLatency|latency marker/i.test(text)) existingNvidia.add("Reflex");
    if (/nvEncodeAPI|NV_ENC|h264_nvenc|hevc_nvenc|av1_nvenc/i.test(text)) {
      existingNvidia.add("NVENC");
      bump("video_pipeline", 6);
      contentPaths.add("video_encode_decode");
    }
    if (/cuvid|nvcuvid|NVDEC|CUVID/i.test(text)) {
      existingNvidia.add("NVDEC");
      bump("video_pipeline", 6);
      contentPaths.add("video_encode_decode");
    }
    if (/PyNvVideoCodec|pynvvideocodec/i.test(text)) {
      existingNvidia.add("PyNvVideoCodec");
      bump("python_video", 7);
      contentPaths.add("video_encode_decode");
    }
    if (/\.py$/i.test(file.name) && /cv2|opencv|moviepy|imageio|ffmpeg|av\.open|decord|torchvision\.io|VideoCapture|VideoWriter/i.test(text)) {
      bump("python_video", 5);
      contentPaths.add("video_encode_decode");
      add("content_path", "Python video processing", file, snippetFor(text, tokenize("cv2 ffmpeg video decode encode")));
    }
    if (/NvOFFRUC|NVOFA|NvOF|Optical Flow|optical-flow/i.test(text) || /NvOFFRUC|NVOFA|NvOF|Optical Flow|optical-flow/i.test(rel)) {
      existingNvidia.add("Optical Flow SDK / NvOFFRUC");
      bump("video_frame_interpolation", 7);
      contentPaths.add("video_frame_interpolation");
    }
    if (/libavcodec|avcodec|avformat|ffmpeg/i.test(text)) {
      bump("ffmpeg", 5);
      contentPaths.add("video_encode_decode");
    }
    if (/gstreamer|gst_element|nvh264enc|nvh265enc|nvav1enc/i.test(text)) {
      bump("gstreamer", 5);
      contentPaths.add("video_encode_decode");
    }
  }

  if (hasPath(/Source\/.+\.(cpp|h)$/i)) bump("unreal", 1);
  if (hasPath(/Assets\//i)) bump("unity", 2);
  if (hasText(/render graph|swapchain|present\(|motion vector|depth buffer|jitter/i)) {
    contentPaths.add("real_time_rendering");
    bump("custom_cpp_renderer", 4);
  }

  if (os.platform() === "win32") targetPlatforms.add("Windows");
  if (os.platform() === "linux") targetPlatforms.add("Linux");

  const projectTypes = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, score]) => ({ name, score, confidence: confidenceFromScore(score) }));

  return {
    primary_type: projectTypes[0]?.name || "unknown",
    project_types: projectTypes,
    languages: [...languages],
    graphics_apis: [...graphicsApis],
    build_systems: [...buildSystems],
    content_paths: [...contentPaths],
    target_platforms: [...targetPlatforms],
    existing_nvidia_dependencies: [...existingNvidia],
    existing_feature_state: existingNvidia.size ? "present_or_partial" : "unknown_or_absent",
    confidence: projectTypes[0]?.confidence || "low",
    evidence: evidence.slice(0, 80)
  };
}

function buildSdkRoots(args) {
  const roots = new Set();
  for (const value of normalizeStringList(args.roots)) roots.add(resolveInputPath(value));
  for (const value of normalizeStringList(process.env.NVIDIA_RTX_DLSS_EXTRA_SDK_ROOTS)) roots.add(resolveInputPath(value));

  if (args.include_common_roots !== false) {
    roots.add(process.cwd());
    roots.add(PLUGIN_ROOT);
    for (const envName of ["CUDA_PATH", "CUDA_HOME", "NVIDIA_SDK_ROOT", "STREAMLINE_SDK", "RTX_VIDEO_SDK", "VIDEO_CODEC_SDK"]) {
      if (process.env[envName]) roots.add(resolveInputPath(process.env[envName]));
    }
    if (process.platform === "win32") {
      for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData, process.env.USERPROFILE]) {
        if (!base) continue;
        roots.add(join(base, "NVIDIA Corporation"));
        roots.add(join(base, "NVIDIA GPU Computing Toolkit"));
        roots.add(join(base, "Downloads"));
      }
    } else {
      for (const base of ["/usr/local/cuda", "/opt/nvidia", "/usr/local", os.homedir()]) roots.add(base);
    }
  }
  return [...roots];
}

function scanForSdks(root, maxFiles) {
  const inventory = inventoryProject(root, { maxFiles, includeEvidence: false });
  const finds = [];
  const add = (type, file, evidence, version = null) => {
    finds.push({
      type,
      root,
      path: file.full,
      relative_path: file.relative,
      version,
      evidence,
      confidence: "medium"
    });
  };

  for (const file of inventory.files) {
    const rel = file.relative.replaceAll("\\", "/");
    if (/include\/sl\.h$/i.test(rel) || /sl\.interposer\.dll$/i.test(file.name)) add("Streamline SDK", file, "Streamline header or interposer");
    if (/ProgrammingGuideDLSS_G\.md$/i.test(file.name)) add("Streamline DLSS-G docs", file, "DLSS Frame Generation programming guide");
    if (/nvngx_dlss\.dll$/i.test(file.name) || /sl\.dlss\.dll$/i.test(file.name) || /sl\.dlss_g\.dll$/i.test(file.name)) add("DLSS feature binary", file, "DLSS/Streamline binary");
    if (/nvEncodeAPI\.h$/i.test(file.name)) add("Video Codec SDK NVENC header", file, "nvEncodeAPI.h");
    if (/nvcuvid\.h$|cuviddec\.h$/i.test(file.name)) add("Video Codec SDK NVDEC header", file, "NVDEC/CUVID header");
    if (/PyNvVideoCodec/i.test(rel)) add("PyNvVideoCodec", file, "PyNvVideoCodec file path");
    if (/NvOFFRUC|NVOFA|NvOF|Optical Flow|optical-flow/i.test(rel)) add("Optical Flow SDK / NvOFFRUC candidate", file, "Optical Flow or FRUC naming clue");
    if (/cuda\.h$/i.test(file.name) || /nvcc(\.exe)?$/i.test(file.name)) add("CUDA Toolkit", file, "CUDA header or compiler");
    if (/GFSDK_Aftermath\.h$/i.test(file.name)) add("Nsight Aftermath SDK", file, "Aftermath header");
    if (/ngfx-capture(\.exe)?$/i.test(file.name) || /Nsight Graphics/i.test(rel)) add("Nsight Graphics", file, "Nsight Graphics tool path");
    if (/DLSS.*\.uplugin$/i.test(file.name) || /Streamline.*\.uplugin$/i.test(file.name)) add("Unreal NVIDIA/DLSS plugin", file, "Unreal plugin descriptor");
    if (/RTXVideo|RTX Video|rtxvsr|VSR/i.test(rel)) add("RTX Video SDK candidate", file, "RTX Video naming clue");
    if (/RTXNTC|NeuralTexture|RTX Kit|MegaGeometry/i.test(rel)) add("RTX Kit component candidate", file, "RTX Kit naming clue");
  }

  for (const find of finds) {
    const version = tryVersionNear(find.path);
    if (version) find.version = version;
  }
  return finds;
}

function dedupeSdkFinds(results) {
  const seen = new Set();
  return results.filter((item) => {
    const key = `${item.type}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchLocalPaths(paths, query, limit) {
  const results = [];
  const tokens = tokenize(query);
  for (const root of paths.map(resolveInputPath).filter(existsSync)) {
    const inventory = inventoryProject(root, { maxFiles: 5000, includeEvidence: false });
    for (const file of inventory.contentIndex) {
      const haystack = lower(`${file.relative}\n${file.text}`);
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      if (score > 0) {
        results.push({
          source: "local_path",
          path: file.full,
          relative_path: file.relative,
          score,
          snippet: snippetFor(file.text, tokens)
        });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function searchRegistry(query, technology, limit) {
  const tokens = tokenize(`${query} ${technology || ""}`);
  const items = [];
  for (const source of registry.sources) {
    if (technology && !lower(JSON.stringify(source)).includes(lower(technology))) continue;
    const haystack = lower(JSON.stringify(source));
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    if (score) items.push({ type: "source", score, ...source });
  }
  for (const tech of registry.technologies) {
    if (technology && !lower(`${tech.id} ${tech.canonical_name}`).includes(lower(technology))) continue;
    const haystack = lower(JSON.stringify(tech));
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    if (score) items.push({ type: "technology", score, ...tech });
  }
  return items.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function fetchAndSearchOfficialSources(registryMatches, query, limit) {
  const tokens = tokenize(query);
  const sourceIds = new Set();
  for (const match of registryMatches) {
    if (match.type === "source") sourceIds.add(match.id);
    for (const id of match.official_sources || []) sourceIds.add(id);
  }
  if (!sourceIds.size) {
    for (const source of registry.sources) {
      if (tokens.some((token) => lower(JSON.stringify(source)).includes(token))) sourceIds.add(source.id);
    }
  }
  const results = [];
  for (const id of [...sourceIds].slice(0, 10)) {
    const source = registry.sources.find((item) => item.id === id);
    if (!source || !isAllowedOfficialUrl(source.url)) continue;
    try {
      const text = await fetchText(toFetchUrl(source.url));
      const haystack = htmlToText(text);
      const score = tokens.reduce((sum, token) => sum + (lower(haystack).includes(token) ? 1 : 0), 0);
      if (score > 0 || !tokens.length) {
        results.push({
          source_id: source.id,
          name: source.name,
          url: source.url,
          kind: source.kind,
          score,
          retrieval_date: new Date().toISOString(),
          snippet: snippetFor(haystack, tokens)
        });
      }
    } catch (error) {
      results.push({
        source_id: source.id,
        name: source.name,
        url: source.url,
        error: errorMessage(error),
        retrieval_date: new Date().toISOString()
      });
    }
  }
  return results.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

function routeGoal(goal, projectSummary, project) {
  const text = lower(`${goal}\n${projectSummary || ""}\n${JSON.stringify(project || {})}`);
  const recommended = [];
  const rejected = [];
  const missing = [];
  const assumptions = [];

  const addRoute = (technologyId, confidence, reasoning) => {
    const tech = findTechnology(technologyId);
    recommended.push({
      technology_id: technologyId,
      name: tech?.canonical_name || technologyId,
      confidence,
      reasoning,
      sources: tech ? sourceRefs(tech.official_sources) : []
    });
  };
  const reject = (technologyId, reason) => {
    const tech = findTechnology(technologyId);
    rejected.push({ technology_id: technologyId, name: tech?.canonical_name || technologyId, reason });
  };

  if (matchesAny(text, ["gpu crash", "tdr", "hang", "stutter", "rendering corruption", "shader bug", "capture", "nsight", "aftermath"])) {
    addRoute("nsight-aftermath", "high", "The goal is diagnostic/profiling/crash oriented, so Nsight/Aftermath planning should lead.");
  }
  if (matchesAny(text, ["unreal", ".uproject", "ue5", "ue 5"])) {
    addRoute("unreal-dlss-plugin", "high", "Unreal projects should start with the official NVIDIA Unreal DLSS plugin route for the detected engine version.");
  }
  if (matchesAny(text, ["unity", "hdrp"])) {
    addRoute("unity-hdrp-dlss", text.includes("hdrp") ? "high" : "medium", "Unity HDRP is the first-class Unity DLSS route; URP/custom SRP needs project-specific inspection.");
  }
  if (matchesAny(text, ["add more frames", "more frames", "frame interpolation", "frame-rate up conversion", "frame rate up conversion", "fruc", "nvoffruc", "optical flow", "120fps", "120 fps", "youtube"])) {
    addRoute("optical-flow-fruc", "high", "Video frame insertion/up-conversion maps to NVIDIA Optical Flow SDK / NvOFFRUC, with a native/backend boundary for YouTube or browser playback.");
    reject("dlss-streamline", "DLSS Frame Generation is for real-time rendered frames from a game/renderer, not arbitrary decoded YouTube video.");
    reject("rtx-video-sdk", "RTX Video SDK handles video enhancement such as super resolution, artifact reduction, and SDR-to-HDR; it is not the frame insertion route.");
  }
  if (matchesAny(text, ["media player", "video upscal", "sdr-to-hdr", "sdr to hdr", "artifact reduction", "playback enhancement", "rtx video"])) {
    addRoute("rtx-video-sdk", "high", "Media playback enhancement maps to RTX Video SDK, not DLSS.");
    reject("dlss-streamline", "DLSS/Streamline is for real-time rendered frames, not generic decoded video enhancement.");
  }
  if (matchesAny(text, ["encode", "decode", "transcode", "streaming encoder", "stream output", "capture", "nvenc", "nvdec", "ffmpeg", "gstreamer", "webcodecs", "video dataset"])) {
    addRoute("video-codec-sdk", "high", "Encode/decode/transcode/capture/streaming maps to Video Codec SDK, NVENC, NVDEC, or framework integrations.");
    reject("rtx-video-sdk", "RTX Video SDK is for enhancement effects, not the general encode/decode control plane.");
  }
  if (matchesAny(text, ["game", "renderer", "rendering engine", "framerate", "frame rate", "dlss", "streamline", "ray reconstruction", "frame generation", "dlaa", "motion vectors"]) && !matchesAny(text, ["youtube", "decoded video", "browser video playback", "web player", "webplayer"])) {
    addRoute("dlss-streamline", "high", "Real-time rendered frames with temporal data map to DLSS through Streamline by default.");
  }
  if (matchesAny(text, ["latency", "click-to-photon", "reflex", "input lag", "frame generation latency"])) {
    addRoute("reflex", "high", "Latency-sensitive rendering and Frame Generation workflows need Reflex and latency markers.");
  }
  if (matchesAny(text, ["animation", "asset", "texture", "path tracing", "neural texture", "neural shader", "mega geometry", "dcc", "visualization"])) {
    addRoute("rtx-kit", "medium", "Advanced content/rendering/asset workflows should evaluate RTX Kit components.");
  }
  if (matchesAny(text, ["browser", "webgpu", "web player", "webplayer", "webcodecs", "youtube"])) {
    addRoute("web-boundary", "high", "Browser content requires WebGPU/WebCodecs/native-companion/server-side boundary routing.");
    reject("dlss-streamline", "Pure browser apps cannot be assumed to call native DLSS/Streamline APIs.");
    reject("rtx-video-sdk", "Pure browser apps cannot be assumed to call native RTX Video SDK APIs.");
  }
  if (matchesAny(text, ["electron", "native companion", "desktop-web", "desktop web"])) {
    addRoute("web-boundary", "high", "Electron/hybrid apps should define a native NVIDIA backend boundary if native SDKs are required.");
  }

  if (!recommended.length) {
    missing.push("Clarify whether the content is real-time rendered frames, decoded video, encoded video, browser content, asset pipeline content, or diagnostics.");
    assumptions.push("No NVIDIA route selected because the goal does not contain enough content-pipeline signals.");
  }
  if (!project) {
    missing.push("No repo classification was provided. Project inspection is required before implementation claims.");
  }

  const deduped = dedupeRoutes(recommended);
  if (deduped.some((item) => item.technology_id === "dlss-streamline") && !matchesAny(text, ["motion vector", "depth", "jitter", "exposure", "camera", "swapchain", "render graph"])) {
    missing.push("For DLSS/Streamline, inspect whether the renderer can provide required temporal and present-time resources.");
  }

  return {
    recommended: deduped,
    rejected: dedupeRoutes(rejected),
    missing: [...new Set(missing)],
    assumptions: [...new Set(assumptions)],
    sources: deduped.flatMap((item) => item.sources || [])
  };
}

function routeFromTechnology(technology) {
  const tech = findTechnology(technology);
  if (!tech) throw new McpError(-32602, `Unknown technology: ${technology}`);
  return {
    recommended: [
      {
        technology_id: tech.id,
        name: tech.canonical_name,
        confidence: "user_forced",
        reasoning: "User or caller explicitly selected this NVIDIA technology route.",
        sources: sourceRefs(tech.official_sources)
      }
    ],
    rejected: [],
    missing: [],
    assumptions: ["Technology route was forced rather than inferred."]
  };
}

function requirementsReport(tech, args, project, env) {
  const knownInputs = {
    target_os: args.target_os || env?.os || null,
    graphics_api: args.graphics_api || project?.graphics_apis?.join(", ") || null,
    engine: args.engine || project?.primary_type || null,
    gpu_generation: args.gpu_generation || env?.gpu?.name || null,
    sdk_version: args.sdk_version || null
  };
  const requiredChecks = [...(tech.requirements || [])];
  const missing = [];
  const blockers = [];
  const warnings = [];

  if (!knownInputs.target_os) missing.push("Target OS and deployment environment are unknown.");
  if (["dlss-streamline", "optical-flow-fruc", "rtx-video-sdk", "video-codec-sdk", "rtx-kit"].includes(tech.id) && !knownInputs.gpu_generation) {
    missing.push("NVIDIA GPU generation/capability is unknown.");
  }
  if (["dlss-streamline", "unreal-dlss-plugin", "unity-hdrp-dlss"].includes(tech.id) && !knownInputs.graphics_api && !knownInputs.engine) {
    missing.push("Renderer API or engine route is unknown.");
  }
  if (tech.id === "web-boundary") {
    warnings.push("Pure browser code must not be treated as having direct access to native NVIDIA SDK APIs.");
  }
  if (tech.id === "rtx-video-sdk" && knownInputs.target_os && !/win/i.test(knownInputs.target_os)) {
    blockers.push("RTX Video SDK baseline in registry is Windows-focused. Confirm current official docs before non-Windows planning.");
  }
  if (tech.id === "dlss-streamline" && knownInputs.graphics_api && /webgpu|browser/i.test(knownInputs.graphics_api)) {
    blockers.push("DLSS/Streamline cannot be assumed available directly from pure WebGPU/browser APIs.");
  }
  if (project?.existing_feature_state === "unknown_or_absent") {
    warnings.push("No existing NVIDIA integration was observed in the scanned repo.");
  }

  return {
    compatibility_state: blockers.length ? "blocked_or_needs_reroute" : missing.length ? "needs_inspection" : "plausible_pending_sdk_feature_query",
    known_inputs: knownInputs,
    required_checks: requiredChecks,
    missing_information: [...new Set(missing)],
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)]
  };
}

function buildPhase2Context(args) {
  const root = args.project_path ? resolveInputPath(args.project_path) : null;
  const inventory = root
    ? inventoryProject(root, {
        maxFiles: clampInt(args.max_files, 8000, 100, 50000),
        includeEvidence: args.include_evidence !== false
      })
    : null;
  const project = inventory ? classifyInventory(inventory) : null;
  const route = args.technology ? routeFromTechnology(args.technology) : routeGoal(args.goal, "", project);
  const primaryRoute = route.recommended[0];
  if (!primaryRoute) throw new McpError(-32602, "No NVIDIA route could be selected from the provided goal.");
  const tech = findTechnology(primaryRoute.technology_id);
  const requirements = tech ? requirementsReport(tech, args, project, null) : null;
  const workflow = normalizePhase2Workflow(args.target_workflow, args.goal, project, primaryRoute);

  return {
    goal: args.goal,
    root,
    inventory,
    project,
    route,
    primaryRoute,
    tech,
    technologyId: primaryRoute.technology_id,
    requirements,
    workflow
  };
}

function normalizePhase2Workflow(requested, goal, project, primaryRoute) {
  const explicit = lower(requested || "auto");
  const allowed = new Set(["unreal", "unity-hdrp", "custom-cpp-renderer", "ffmpeg-gstreamer", "python-video", "web-electron"]);
  if (allowed.has(explicit)) return explicit;

  const text = lower(`${goal}\n${primaryRoute?.technology_id || ""}\n${JSON.stringify(project || {})}`);
  if (matchesAny(text, ["unreal", ".uproject", "unreal-dlss-plugin"])) return "unreal";
  if (matchesAny(text, ["unity_hdrp", "unity hdrp", "com.unity.render-pipelines.high-definition", "unity-hdrp-dlss"])) return "unity-hdrp";
  if (matchesAny(text, ["ffmpeg", "gstreamer", "libav", "gst_", "nvenc", "nvdec"])) return "ffmpeg-gstreamer";
  if (matchesAny(text, ["python_video", "pynvvideocodec", "requirements.txt", "pyproject.toml", "python video"])) return "python-video";
  if (matchesAny(text, ["electron", "browser", "webgpu", "webcodecs", "manifest_version", "youtube", "web-boundary"])) return "web-electron";
  if (matchesAny(text, ["custom_cpp_renderer", "custom_cpp", "d3d12", "d3d11", "vulkan", "swapchain", "present", "cmake"])) return "custom-cpp-renderer";

  if (primaryRoute?.technology_id === "unreal-dlss-plugin") return "unreal";
  if (primaryRoute?.technology_id === "unity-hdrp-dlss") return "unity-hdrp";
  if (["video-codec-sdk", "rtx-video-sdk"].includes(primaryRoute?.technology_id)) return "ffmpeg-gstreamer";
  if (["dlss-streamline", "reflex", "rtx-kit"].includes(primaryRoute?.technology_id)) return "custom-cpp-renderer";
  if (["optical-flow-fruc", "web-boundary"].includes(primaryRoute?.technology_id)) return "web-electron";
  return "custom-cpp-renderer";
}

function phase2WorkflowPlan(context) {
  const observedFiles = selectRelevantFiles(context.inventory, context.workflow);
  const sources = phase2Sources(context);
  const commonConstraints = [
    "Local SDK docs and headers outrank generic web docs for implementation details.",
    "Feature support must be queried through the selected SDK/plugin where available before exposing user-facing controls.",
    "NVIDIA downloads, SDK binaries, redistributable libraries, signatures, and production packaging stay behind explicit user approval and license review.",
    "This Phase 2 output is a patch plan, not an implementation diff."
  ];
  const baseValidation = validationSteps(context.technologyId, true);
  const baseRisks = riskList(context.technologyId);
  const templates = {
    unreal: {
      code_guidance: [
        "Treat the official NVIDIA Unreal plugin as the default integration route unless the repo clearly uses a custom engine branch that requires lower-level Streamline work.",
        "Inspect engine association, plugin descriptors, project settings, console variables, and packaged-build configuration before proposing edits.",
        "Separate editor validation from packaged-build validation; many DLSS/Streamline issues only appear in runtime logs or shipping layout."
      ],
      source_backed_constraints: [
        ...commonConstraints,
        "Match the NVIDIA Unreal plugin to the detected Unreal Engine version.",
        "Do not copy plugin binaries or SDK redistributables into a release package without license and production-binary checks."
      ],
      likely_files: observedFiles,
      patch_plan: [
        patchStep("Confirm Unreal route", ["*.uproject", "EngineAssociation", "Config/DefaultEngine.ini"], "Read engine version and plugin state, then decide official plugin versus custom Streamline route.", ["No plugin download or binary copy in Phase 2."]),
        patchStep("Plan plugin/config edits", ["*.uproject", "Plugins/**/*.uplugin", "Config/*.ini"], "Prepare a reviewable config-only change set for enabling the official NVIDIA plugin and runtime options.", ["Keep changes reversible through project settings or config diffs."]),
        patchStep("Plan build/package checks", ["Source/**/*.Build.cs", "Config/DefaultGame.ini", "Packaging settings"], "Identify packaged-build paths, logs, and production library checks before any binary movement.", ["Do not package watermarked or development libraries."]),
        patchStep("Plan validation hooks", ["Saved/Logs", "runtime console variables", "representative maps"], "Define editor and packaged-build validation scenes, expected logs, and feature availability checks.", ["Validate unsupported GPUs/drivers hide or disable UI."])
      ],
      validation_focus: [
        "Detect UE version and official plugin compatibility.",
        "Validate plugin loading in editor and packaged build.",
        "Check runtime feature support, logs, UI gating, and production packaging."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Run editor startup and representative map validation.",
        "Run a packaged build check with runtime logs.",
        "Record the exact UE version, NVIDIA plugin version, GPU, driver, and packaging mode."
      ]),
      risks: mergePlan(baseRisks, ["Wrong UE/plugin version pairing can produce editor-only success but packaged failure."]),
      regression_hotspots: ["project plugin descriptors", "DefaultEngine.ini rendering settings", "packaging output layout", "runtime UI feature gating"],
      rollback_plan: rollbackPlan("Disable or remove planned plugin/config changes, restore prior .uproject and Config files, and leave NVIDIA binaries untouched unless their placement was separately approved."),
      missing_information: ["Detected Unreal Engine version", "Official plugin package/version", "Target packaging mode"]
    },
    "unity-hdrp": {
      code_guidance: [
        "Confirm Unity HDRP before planning DLSS edits; URP/custom SRP is advanced and should be routed to custom render-pipeline inspection.",
        "Inspect Unity version, HDRP package version, render pipeline asset, camera settings, dynamic resolution settings, and Reflex needs.",
        "Keep the patch plan focused on package/project settings and validation scenes until feasibility is proven."
      ],
      source_backed_constraints: [
        ...commonConstraints,
        "Unity HDRP is the first-class Unity DLSS route in this plugin baseline.",
        "Do not claim URP/custom SRP support without render-pipeline and native-plugin inspection."
      ],
      likely_files: observedFiles,
      patch_plan: [
        patchStep("Confirm Unity/HDRP route", ["ProjectSettings/ProjectVersion.txt", "Packages/manifest.json"], "Read Unity and HDRP package versions and classify HDRP versus URP/custom SRP.", ["If HDRP is absent, stop and re-route as custom/advanced."]),
        patchStep("Plan project settings changes", ["ProjectSettings/GraphicsSettings.asset", "ProjectSettings/QualitySettings.asset", "Assets/**/*.asset"], "Identify render pipeline asset, camera/dynamic-resolution settings, and feature toggles that would be adjusted later.", ["Do not mutate Unity serialized assets without a narrow diff and backup plan."]),
        patchStep("Plan Reflex/latency markers if needed", ["Assets/**/*.cs", "ProjectSettings"], "Find latency-sensitive entry points and marker/measurement locations.", ["Reflex planning should not be bundled into a DLSS change unless latency is in scope."]),
        patchStep("Plan validation scenes", ["Assets/Scenes", "ProjectSettings"], "Select representative HDRP scenes and performance captures.", ["Validate image quality and latency separately."])
      ],
      validation_focus: [
        "Validate Unity version, HDRP version, render pipeline asset, camera settings, and dynamic resolution state.",
        "Test representative HDRP scenes and latency-sensitive interactions if Reflex is in scope."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Record Unity version, HDRP package version, GPU, driver, render pipeline asset, and target platform.",
        "Validate feature UI only appears when runtime support passes."
      ]),
      risks: mergePlan(baseRisks, ["Unity serialized project settings are easy to over-edit; patch plans should stay narrow and reviewable."]),
      regression_hotspots: ["Packages/manifest.json", "ProjectSettings assets", "camera settings", "render pipeline asset references"],
      rollback_plan: rollbackPlan("Revert package/project settings changes and restore prior render pipeline assets before removing any generated validation scripts."),
      missing_information: ["Unity version", "HDRP package version", "Render pipeline asset path"]
    },
    "custom-cpp-renderer": {
      code_guidance: [
        "Treat Streamline as the default DLSS route for custom real-time renderers unless the inspected codebase proves a direct NGX-style route is required.",
        "Map device creation, swapchain/present, render graph/resource lifetime, temporal data generation, HUD/UI composition, and latency markers before planning edits.",
        "DLSS Super Resolution and Frame Generation are different patch surfaces; do not collapse their required inputs into one generic upscaler step."
      ],
      source_backed_constraints: [
        ...commonConstraints,
        "Plan SDK feature requirement queries for the user's OS, driver, GPU, API, settings, and SDK version.",
        "Frame Generation planning must account for present-time resources, HUD-less color, UI color, camera matrices/state, frame index, reset flags, and Reflex integration where required."
      ],
      likely_files: observedFiles,
      patch_plan: [
        patchStep("Map renderer boundaries", ["CMakeLists.txt", "*.vcxproj", "Renderer/*", "Swapchain/*", "Present/*"], "Identify graphics API setup, device lifetime, swapchain/present, and frame resource ownership.", ["No SDK calls until resource lifetime and present path are understood."]),
        patchStep("Plan dependency wiring", ["CMakeLists.txt", "*.vcxproj", "third_party/*"], "Prepare include/lib/runtime path changes for user-provided Streamline SDK paths.", ["Do not vendor or redistribute NVIDIA binaries without approval."]),
        patchStep("Plan feature requirement queries", ["renderer init", "settings UI", "capability cache"], "Add future support-query and UI gating locations for selected DLSS/Reflex features.", ["Unsupported combinations must be hidden or disabled before runtime use."]),
        patchStep("Plan resource tagging", ["render graph", "motion vectors", "depth", "exposure", "jitter", "camera constants"], "Identify exact producers/consumers for required DLSS inputs and frame reset flags.", ["If motion vectors/depth/jitter are missing, plan those first."]),
        patchStep("Plan present-time and UI/HUD handling", ["present path", "UI compositor", "HUD pass"], "For Frame Generation, identify HUD-less color, UI color, present-time constants, and pause/menu/resolution-change gates.", ["Disable FG during pause, loading, menus, resolution transitions, and non-gameplay frames."]),
        patchStep("Plan profiling/debug hooks", ["logging", "Nsight capture points", "Streamline debug"], "Add future logging, debug visualization, and capture steps.", ["Validation must include frame pacing and latency, not just FPS."])
      ],
      validation_focus: [
        "Confirm D3D11, D3D12, or Vulkan path and SDK feature support.",
        "Validate motion vectors, depth, jitter, exposure, camera state, frame index, reset flags, and present-time resources.",
        "Validate Reflex/latency and frame pacing for Frame Generation workflows."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Capture representative frames in Nsight Graphics before and after future implementation.",
        "Record image quality artifacts and frame pacing under camera cuts, pause, menu, loading, and resolution changes."
      ]),
      risks: mergePlan(baseRisks, ["Renderer integrations can regress lifetime, synchronization, and resource-state ownership if patch boundaries are too broad."]),
      regression_hotspots: ["device/swapchain lifetime", "render graph resource states", "temporal buffer generation", "UI/HUD compositor", "settings and packaging"],
      rollback_plan: rollbackPlan("Keep dependency wiring, feature query, resource tagging, and UI exposure in separate commits so the renderer can fall back to the pre-Streamline path."),
      missing_information: ["Graphics API", "SDK path/version", "motion vector/depth/jitter/exposure producers", "present path"]
    },
    "ffmpeg-gstreamer": {
      code_guidance: [
        "For encode/decode/transcode/capture, route through Video Codec SDK concepts and existing FFmpeg/GStreamer acceleration when the repo already uses those frameworks.",
        "Keep NVENC/NVDEC planning separate from CUDA compute; NVENC/NVDEC are dedicated hardware engines.",
        "Plan codec capability checks, memory path, color format, bit depth, chroma, rate control, and quality metrics before changing pipeline strings or encoder options."
      ],
      source_backed_constraints: [
        ...commonConstraints,
        "Check GPU codec support before selecting codec, chroma, bit depth, throughput, or rate-control assumptions.",
        "Use RTX Video SDK only for video enhancement effects; use Video Codec SDK/NVENC/NVDEC for encode/decode control."
      ],
      likely_files: observedFiles,
      patch_plan: [
        patchStep("Classify existing pipeline", ["CMakeLists.txt", "configure scripts", "Dockerfile", "*ffmpeg*", "*gstreamer*", "*gst*"], "Find framework usage, current codecs, filters, caps, muxing, and hardware acceleration flags.", ["Do not rewrite pipeline architecture before observing current data flow."]),
        patchStep("Plan capability probe", ["startup diagnostics", "CLI args", "config"], "Add future GPU/driver/codec support detection and fallback behavior.", ["Codec support must be queried or documented per GPU."]),
        patchStep("Plan NVENC/NVDEC changes", ["encoder setup", "decoder setup", "pipeline strings"], "Prepare narrow encoder/decoder option changes for selected codec, profile, rate control, bit depth, and chroma.", ["Keep CPU fallback and error messages."]),
        patchStep("Plan zero-copy/memory path", ["frame upload/download", "filter graph", "hwframes context"], "Identify copies between CPU, CUDA, DirectX/Vulkan, and framework buffers.", ["Do not claim zero-copy until measured and inspected."]),
        patchStep("Plan quality/performance tests", ["test scripts", "sample media harness"], "Define throughput, PSNR/SSIM/VMAF, latency, and A/V sync tests.", ["Use license-approved sample clips only."])
      ],
      validation_focus: [
        "Validate codec support, throughput, rate control, profile, bit depth, chroma, memory path, and A/V sync.",
        "Measure NVENC/NVDEC utilization separately from CUDA/graphics workload."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Run short and long sample transcodes with expected codec/profile outputs.",
        "Collect throughput, latency, quality metrics, dropped frames, and A/V sync drift."
      ]),
      risks: mergePlan(baseRisks, ["Framework pipelines can silently fall back to CPU or introduce CPU copies unless diagnostics prove the GPU path."]),
      regression_hotspots: ["pipeline strings", "encoder/decoder option maps", "hwframes context", "container/muxer settings", "Docker/CI GPU access"],
      rollback_plan: rollbackPlan("Keep hardware acceleration options behind config flags and preserve the previous CPU/software pipeline as a fallback."),
      missing_information: ["Framework version", "target codec/profile", "GPU codec support", "input/output formats"]
    },
    "python-video": {
      code_guidance: [
        "For Python video pipelines, plan around PyNvVideoCodec or framework-backed NVENC/NVDEC when encode/decode is the goal, and route enhancement/interpolation separately.",
        "Inspect dependency files, current frame containers, tensor/array formats, color conversions, and multiprocessing/async pipeline boundaries before proposing code edits.",
        "Plan small adapter modules and test harnesses rather than broad rewrites of analysis/training/data ingestion code."
      ],
      source_backed_constraints: [
        ...commonConstraints,
        "Do not claim GPU decode/encode unless the dependency and runtime path prove NVDEC/NVENC use.",
        "Avoid uploading sample videos, datasets, or captures; keep validation local unless the user approves a destination."
      ],
      likely_files: observedFiles,
      patch_plan: [
        patchStep("Classify Python dependencies", ["pyproject.toml", "requirements.txt", "environment.yml", "setup.cfg"], "Find PyNvVideoCodec, OpenCV, FFmpeg wrappers, CUDA/Torch, and platform pins.", ["Do not add binary or SDK dependencies without user approval."]),
        patchStep("Map frame data model", ["*.py video loaders", "dataset readers", "preprocess scripts"], "Identify decode, color conversion, resize, batching, and CPU/GPU transfer boundaries.", ["Keep frame format and timestamp handling explicit."]),
        patchStep("Plan NVIDIA adapter module", ["src/*", "video/*", "pipeline/*"], "Prepare a small future adapter around decode/encode/enhancement/interpolation capability checks.", ["Preserve existing software fallback paths."]),
        patchStep("Plan benchmark harness", ["tests/*", "scripts/*", "benchmarks/*"], "Define throughput, latency, quality, and determinism checks on approved local clips.", ["Do not use proprietary datasets in automated logs without approval."]),
        patchStep("Plan packaging/runtime checks", ["README", "env files", "CI"], "Document GPU/driver/SDK expectations and skip behavior on unsupported hosts.", ["Tests should skip gracefully without NVIDIA hardware."])
      ],
      validation_focus: [
        "Validate dependency availability, GPU/driver/runtime support, frame format, timestamps, throughput, and output quality.",
        "Compare CPU/software fallback and NVIDIA path outputs with stable sample clips."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Run dependency import checks and a short approved sample through the planned path.",
        "Measure decode/encode/enhancement FPS, GPU utilization, CPU copies, and output consistency."
      ]),
      risks: mergePlan(baseRisks, ["Python wrappers can hide CPU copies, format conversions, or software fallbacks unless benchmarked directly."]),
      regression_hotspots: ["dependency pins", "frame/tensor format conversion", "timestamp handling", "multiprocessing queues", "dataset loaders"],
      rollback_plan: rollbackPlan("Keep NVIDIA path behind a feature flag or adapter selection and preserve the current Python video path as the default fallback until validated."),
      missing_information: ["Python dependency set", "frame container format", "target NVIDIA SDK/wrapper", "sample clip/test dataset"]
    },
    "web-electron": {
      code_guidance: [
        "Do not plan direct browser calls to DLSS, RTX Video SDK, Optical Flow SDK, or Video Codec SDK.",
        "If NVIDIA native SDKs are required, plan an Electron/native companion, native app/plugin, or server-side NVIDIA GPU boundary with explicit IPC and data ownership.",
        "Keep control-plane messages separate from raw frame transport; raw frame movement needs a dedicated latency/security design."
      ],
      source_backed_constraints: [
        ...commonConstraints,
        "Pure WebGPU/WebCodecs does not expose every vendor-specific native GPU API.",
        "Native helpers must be local-first and must not upload user media or captures without explicit approval."
      ],
      likely_files: observedFiles,
      patch_plan: [
        patchStep("Classify browser versus native boundary", ["package.json", "manifest.json", "electron main/preload", "native host manifest"], "Determine pure web, Electron, browser extension, native companion, or server-side architecture.", ["No native SDK claims in pure browser-only code."]),
        patchStep("Plan control-plane schema", ["IPC/native messaging schemas", "preload bridge", "service worker"], "Define start/stop/capability/status/error messages for a future native helper.", ["Do not use browser native messaging for raw high-rate frame transport without separate design."]),
        patchStep("Plan frame/source legality", ["capture modules", "WebCodecs", "tabCapture/offscreen permissions"], "Identify legal, user-approved frame sources and platform restrictions.", ["No DRM bypass, credential misuse, or hidden capture."]),
        patchStep("Plan native helper boundary", ["native service", "localhost API", "Electron main process"], "Choose local native process, IPC, texture/frame sharing, and lifecycle constraints.", ["Downloads and SDK paths require user approval."]),
        patchStep("Plan UX and validation", ["settings UI", "status UI", "logs"], "Expose capability state and clear unsupported/blocked reasons.", ["Do not present unavailable NVIDIA features as enabled."])
      ],
      validation_focus: [
        "Validate browser/native capability detection, IPC latency, frame ownership, user consent, and unsupported-browser behavior.",
        "Verify no proprietary frames/captures leave the machine without approval."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Test pure browser fallback and native-helper-present scenarios separately.",
        "Record IPC latency, frame delivery jitter, copy count, and failure messages."
      ]),
      risks: mergePlan(baseRisks, ["Web/native integrations can overpromise NVIDIA SDK access if the boundary is not explicit."]),
      regression_hotspots: ["browser permissions", "Electron preload isolation", "IPC schemas", "native helper lifecycle", "media/capture consent"],
      rollback_plan: rollbackPlan("Keep native-helper integration behind a disabled-by-default capability flag and preserve browser-native behavior as fallback."),
      missing_information: ["Deployment model", "frame source", "native helper language/API", "user consent model"]
    }
  };

  const selected = templates[context.workflow] || templates["custom-cpp-renderer"];
  return {
    ...selected,
    likely_files: selected.likely_files.length ? selected.likely_files : expectedFilesForWorkflow(context.workflow),
    sources
  };
}

function patchStep(step, likelyFiles, editShape, guardrails = []) {
  return {
    step,
    likely_files: likelyFiles,
    edit_shape: editShape,
    guardrails
  };
}

function tunePatchPlanForRisk(plan, riskTolerance) {
  return plan.map((step, index) => ({
    order: index + 1,
    ...step,
    phase2_gate:
      riskTolerance === "low"
        ? "Keep this as a small, separately reviewable future diff with validation before moving to the next step."
        : "Still requires explicit user approval before Phase 3 implementation."
  }));
}

function noEditDiagnosis(context, workflow) {
  const observed = [];
  if (context.root) observed.push(`Inspected project path: ${context.root}`);
  if (context.project?.primary_type) observed.push(`Primary classifier result: ${context.project.primary_type} (${context.project.confidence} confidence)`);
  if (context.project?.existing_nvidia_dependencies?.length) {
    observed.push(`Observed NVIDIA-related dependencies: ${context.project.existing_nvidia_dependencies.join(", ")}`);
  }
  if (workflow.likely_files?.length && workflow.likely_files[0].path) {
    observed.push(`Found ${workflow.likely_files.length} likely repo file(s) for this workflow.`);
  }
  if (!context.root) observed.push("No repo path was provided, so this remains a template until the project is inspected.");

  return {
    state: context.root ? "repo_inspected_plan_ready" : "needs_repo_inspection",
    observed,
    blockers: context.requirements?.blockers || [],
    warnings: context.requirements?.warnings || [],
    not_yet_editable: [
      "User has not approved implementation edits in this Phase 2 tool call.",
      "SDK paths, versions, and licensing boundaries may still need confirmation.",
      "Generated code must wait for a reviewable patch plan and validation plan."
    ],
    evidence: context.project?.evidence?.slice(0, 20) || []
  };
}

function phase2MissingInformation(context, workflow) {
  const missing = [
    ...(context.route.missing || []),
    ...(context.requirements?.missing_information || []),
    ...(workflow.missing_information || [])
  ];
  if (!context.root) missing.push("Project path for repo-aware file mapping.");
  if (!context.tech) missing.push("Resolved NVIDIA technology registry entry.");
  return [...new Set(missing)];
}

function licenseGuardSummary(context) {
  const needsSdk = ["dlss-streamline", "optical-flow-fruc", "rtx-video-sdk", "video-codec-sdk", "unreal-dlss-plugin", "unity-hdrp-dlss"].includes(
    context.technologyId
  );
  return {
    required_user_approval: needsSdk,
    decisions: [
      {
        decision: "plan_only_ok",
        reason: "Repo-aware patch planning and local inspection do not copy, download, redistribute, or upload NVIDIA assets."
      },
      ...(needsSdk
        ? [
            {
              decision: "approval_required_before_sdk_or_binary_actions",
              reason: "SDK downloads, binary placement, redistributable packaging, and production-library checks require explicit user approval and license review."
            }
          ]
        : [])
    ],
    trust_boundaries: ["public docs", "local SDK docs", "source code", "user media/captures", "generated patch plans", "future code edits", "packaged artifacts"]
  };
}

function phase2Sources(context) {
  const ids = new Set(context.tech?.official_sources || []);
  const workflowIds = {
    unreal: ["nvidia-dlss", "streamline-releases"],
    "unity-hdrp": ["nvidia-dlss", "nvidia-reflex"],
    "custom-cpp-renderer": ["nvidia-dlss", "nvidia-streamline-page", "streamline-programming-guide", "streamline-dlssg-guide", "nvidia-reflex", "nsight-graphics"],
    "ffmpeg-gstreamer": ["video-codec-sdk", "rtx-video-sdk"],
    "python-video": ["video-codec-sdk", "nvidia-optical-flow-sdk", "rtx-video-sdk"],
    "web-electron": ["webgpu-explainer", "nvidia-optical-flow-sdk", "rtx-video-sdk", "video-codec-sdk"]
  };
  for (const id of workflowIds[context.workflow] || []) ids.add(id);
  return sourceRefs([...ids]);
}

function selectRelevantFiles(inventory, workflow) {
  if (!inventory) return [];
  const rules = {
    unreal: [
      [/\.uproject$/i, "Unreal project descriptor"],
      [/\.uplugin$/i, "Unreal plugin descriptor"],
      [/^Config\/.*\.ini$/i, "Unreal config"],
      [/^Source\/.*\.(Build\.cs|cpp|h|hpp)$/i, "Unreal source/build file"],
      [/^Plugins\/.*$/i, "Project plugin path"]
    ],
    "unity-hdrp": [
      [/^ProjectSettings\/ProjectVersion\.txt$/i, "Unity version file"],
      [/^Packages\/manifest\.json$/i, "Unity package manifest"],
      [/^ProjectSettings\/.*\.(asset|json)$/i, "Unity project settings"],
      [/^Assets\/.*\.(asset|cs|unity)$/i, "Unity asset/script/scene"]
    ],
    "custom-cpp-renderer": [
      [/CMakeLists\.txt$/i, "CMake build entry"],
      [/\.(sln|vcxproj|props)$/i, "Visual Studio/MSBuild file"],
      [/\.(cpp|cc|cxx|h|hpp|hlsl|glsl|slang)$/i, "renderer/source/shader candidate"],
      [/(render|renderer|swapchain|present|d3d|dx12|vulkan|vk|motion|depth|jitter|camera|streamline|dlss)/i, "renderer integration signal"]
    ],
    "ffmpeg-gstreamer": [
      [/(ffmpeg|libav|avcodec|avformat|gstreamer|gst|nvenc|nvdec)/i, "video framework/codec signal"],
      [/CMakeLists\.txt$/i, "native build entry"],
      [/(Dockerfile|docker-compose|configure|meson\.build|Makefile)$/i, "build/runtime container signal"],
      [/\.(cpp|cc|cxx|h|hpp|py|sh|ps1)$/i, "pipeline code/script candidate"]
    ],
    "python-video": [
      [/(pyproject\.toml|requirements\.txt|environment\.yml|setup\.cfg|setup\.py)$/i, "Python dependency file"],
      [/\.(py)$/i, "Python source candidate"],
      [/(video|decode|encode|ffmpeg|opencv|cv2|torch|cuda|pynv|dataset|preprocess)/i, "Python video pipeline signal"]
    ],
    "web-electron": [
      [/package\.json$/i, "npm/Electron manifest"],
      [/manifest\.json$/i, "browser extension or web manifest"],
      [/(electron|preload|main|native|ipc|webgpu|webcodecs|content-script|service-worker|background)/i, "web/native boundary signal"],
      [/\.(ts|tsx|js|jsx|json)$/i, "web application source/config"]
    ]
  };
  const selected = [];
  const seen = new Set();
  for (const file of inventory.files) {
    const rel = file.relative.replaceAll("\\", "/");
    for (const [pattern, reason] of rules[workflow] || []) {
      if (!pattern.test(rel)) continue;
      if (seen.has(rel)) break;
      seen.add(rel);
      selected.push({ path: file.full, relative_path: rel, reason });
      break;
    }
    if (selected.length >= 40) break;
  }
  return selected;
}

function expectedFilesForWorkflow(workflow) {
  const table = {
    unreal: ["*.uproject", "Plugins/**/*.uplugin", "Config/*.ini", "Source/**/*.Build.cs", "Source/**/*.{cpp,h}"],
    "unity-hdrp": ["ProjectSettings/ProjectVersion.txt", "Packages/manifest.json", "ProjectSettings/*.asset", "Assets/**/*.cs", "Assets/**/*.unity"],
    "custom-cpp-renderer": ["CMakeLists.txt", "*.vcxproj", "Renderer/**/*", "Source/**/*.{cpp,h,hlsl}", "third_party/ or extern/"],
    "ffmpeg-gstreamer": ["pipeline source files", "CMakeLists.txt/meson.build/Makefile", "Dockerfile", "FFmpeg/GStreamer config", "test media harness"],
    "python-video": ["pyproject.toml", "requirements.txt", "src/**/*.py", "tests/**/*.py", "scripts/benchmarks"],
    "web-electron": ["package.json", "manifest.json", "Electron main/preload files", "IPC schema files", "native helper manifest"]
  };
  return (table[workflow] || []).map((pattern) => ({ pattern, reason: "Expected file pattern; not observed because no matching repo file was found." }));
}

function mergePlan(first, second) {
  return [...new Set([...(first || []), ...(second || [])])];
}

function rollbackPlan(summary) {
  return [
    summary,
    "Keep future changes split by dependency wiring, feature gating, resource integration, tests, and packaging so each can be reverted independently.",
    "Record pre-change config/build settings and preserve the existing software or no-NVIDIA fallback path.",
    "Remove or disable planned feature flags before removing shared helper code."
  ];
}

function buildPhase3Context(args) {
  const context = buildPhase2Context({
    ...args,
    target_workflow: phase2WorkflowForPhase3(args.workflow),
    max_files: args.max_files,
    include_evidence: args.include_evidence
  });
  const phase3Workflow = normalizePhase3Workflow(args.workflow, args.goal, context.project, context.primaryRoute);
  return {
    ...context,
    phase3Workflow,
    sdkRoot: args.sdk_root ? resolveInputPath(args.sdk_root) : null
  };
}

function phase2WorkflowForPhase3(workflow) {
  const map = {
    "unreal-plugin-config-validation": "unreal",
    "cmake-sdk-wiring": "custom-cpp-renderer",
    "streamline-init-scaffold": "custom-cpp-renderer",
    "video-codec-sample-adaptation": "ffmpeg-gstreamer",
    "rtx-video-pipeline-skeleton": "ffmpeg-gstreamer",
    "nsight-marker-insertion": "custom-cpp-renderer",
    "reflex-marker-scaffold": "custom-cpp-renderer"
  };
  return map[workflow] || "auto";
}

function normalizePhase3Workflow(requested, goal, project, primaryRoute) {
  const explicit = lower(requested || "auto");
  const allowed = new Set([
    "unreal-plugin-config-validation",
    "cmake-sdk-wiring",
    "streamline-init-scaffold",
    "video-codec-sample-adaptation",
    "rtx-video-pipeline-skeleton",
    "nsight-marker-insertion",
    "reflex-marker-scaffold"
  ]);
  if (allowed.has(explicit)) return explicit;

  const text = lower(`${goal}\n${primaryRoute?.technology_id || ""}\n${JSON.stringify(project || {})}`);
  if (matchesAny(text, ["unreal", ".uproject", "ue5", "ue 5"])) return "unreal-plugin-config-validation";
  if (matchesAny(text, ["cmake", "include path", "lib path", "library path", "sdk wiring", "build setup"])) return "cmake-sdk-wiring";
  if (matchesAny(text, ["rtx video", "super resolution", "artifact reduction", "sdr-to-hdr", "sdr to hdr"])) return "rtx-video-pipeline-skeleton";
  if (matchesAny(text, ["video codec", "nvenc", "nvdec", "ffmpeg", "gstreamer", "transcode", "decode", "encode"])) return "video-codec-sample-adaptation";
  if (matchesAny(text, ["nsight", "gpu marker", "debug marker", "profile marker", "capture marker"])) return "nsight-marker-insertion";
  if (matchesAny(text, ["reflex", "latency", "click-to-photon", "input lag"])) return "reflex-marker-scaffold";
  if (matchesAny(text, ["streamline", "dlss", "frame generation", "ray reconstruction", "renderer", "d3d12", "vulkan"])) return "streamline-init-scaffold";

  if (primaryRoute?.technology_id === "unreal-dlss-plugin") return "unreal-plugin-config-validation";
  if (primaryRoute?.technology_id === "rtx-video-sdk") return "rtx-video-pipeline-skeleton";
  if (primaryRoute?.technology_id === "video-codec-sdk") return "video-codec-sample-adaptation";
  if (primaryRoute?.technology_id === "reflex") return "reflex-marker-scaffold";
  if (primaryRoute?.technology_id === "nsight-aftermath") return "nsight-marker-insertion";
  return "streamline-init-scaffold";
}

function phase3ImplementationPackage(context, args) {
  const baseValidation = validationSteps(context.technologyId, true);
  const common = {
    write_mode: args.write_files === true ? "approved_create_new_scaffold_files" : "preview_only",
    generated_files_are_create_only: true,
    existing_repo_edits_are_described_not_applied: true,
    approval_token_required_for_writes: "APPROVED_PHASE_3_EDITS"
  };

  const table = {
    "unreal-plugin-config-validation": () => ({
      summary: "Create a local validation helper for Unreal DLSS/Streamline/Reflex plugin readiness without installing or copying NVIDIA binaries.",
      files: [
        scaffoldFile(
          "tools/nvidia/validate-unreal-dlss-plugin.ps1",
          "powershell",
          "Validates Unreal project metadata, plugin clues, config clues, and packaging risk before manual plugin work.",
          unrealValidationScript()
        ),
        scaffoldFile(
          "docs/nvidia/unreal-dlss-validation.md",
          "markdown",
          "Review checklist for official NVIDIA Unreal plugin readiness.",
          [
            "# NVIDIA Unreal DLSS Validation",
            "",
            "Use this checklist before enabling or packaging NVIDIA DLSS, Streamline, or Reflex in an Unreal project.",
            "",
            "1. Confirm the Unreal Engine version from the .uproject EngineAssociation and the editor build.",
            "2. Match the official NVIDIA plugin package to that Unreal version.",
            "3. Verify plugin descriptors are present and project/plugin enablement is explicit.",
            "4. Check Config/*.ini rendering and packaging settings.",
            "5. Validate editor startup logs and packaged-build logs separately.",
            "6. Do not copy or redistribute NVIDIA binaries until license and production-library checks are complete.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Optionally add tools/nvidia/validate-unreal-dlss-plugin.ps1 to CI as a read-only preflight.",
        "After approval, make config changes as a separate diff from any plugin binary placement."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Run the validation script from the Unreal project root.",
        "Review every warning before enabling plugin settings or packaging."
      ]),
      rollback_plan: rollbackPlan("Remove the validation helper and revert any later .uproject or Config/*.ini changes separately."),
      sources: sourceRefs(["nvidia-dlss", "streamline-releases"])
    }),
    "cmake-sdk-wiring": () => ({
      summary: "Create CMake SDK wiring scaffolds for user-provided NVIDIA SDK paths without vendoring SDK binaries.",
      files: [
        scaffoldFile(
          "cmake/NvidiaRtxSdkOptions.cmake",
          "cmake",
          "Defines opt-in cache variables and interface targets for user-provided NVIDIA SDK roots.",
          cmakeSdkOptions()
        ),
        scaffoldFile(
          "docs/nvidia/cmake-sdk-wiring.md",
          "markdown",
          "Documents how to wire SDK roots safely and reviewably.",
          [
            "# NVIDIA RTX SDK CMake Wiring",
            "",
            "This scaffold is intentionally opt-in. It does not download SDKs or copy redistributable binaries.",
            "",
            "Recommended flow:",
            "",
            "1. Set NVIDIA_RTX_ENABLE_STREAMLINE=ON only after selecting the Streamline route.",
            "2. Set NVIDIA_STREAMLINE_SDK_ROOT to a user-provided local SDK checkout or install path.",
            "3. Link the generated interface target only from the renderer module that owns the integration.",
            "4. Keep runtime DLL/shared-library placement in a separate reviewed patch.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Include cmake/NvidiaRtxSdkOptions.cmake from the top-level CMakeLists.txt.",
        "Link nvidia_streamline_sdk from the narrow renderer target only after SDK path validation passes."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Configure CMake with NVIDIA_RTX_ENABLE_STREAMLINE=OFF to confirm the scaffold is inert.",
        "Configure with NVIDIA_RTX_ENABLE_STREAMLINE=ON and a valid SDK root to confirm include path detection."
      ]),
      rollback_plan: rollbackPlan("Remove the CMake include line and generated cmake/NvidiaRtxSdkOptions.cmake file."),
      sources: sourceRefs(["nvidia-streamline-page", "streamline-releases", "streamline-programming-guide"])
    }),
    "streamline-init-scaffold": () => ({
      summary: "Create a narrow C++ Streamline integration shell for initialization, shutdown, capability gating, and future resource tagging.",
      files: [
        scaffoldFile("src/nvidia/StreamlineIntegration.h", "cpp", "Header-only contract for future Streamline integration.", streamlineHeader()),
        scaffoldFile("src/nvidia/StreamlineIntegration.cpp", "cpp", "Compile-safe Streamline integration shell with SDK call placeholders.", streamlineCpp()),
        scaffoldFile(
          "docs/nvidia/streamline-integration-notes.md",
          "markdown",
          "Notes for completing Streamline initialization against local SDK headers.",
          [
            "# Streamline Integration Notes",
            "",
            "This scaffold deliberately avoids guessing version-specific SDK calls.",
            "",
            "Before replacing placeholders with real Streamline calls:",
            "",
            "1. Resolve local Streamline headers and docs.",
            "2. Confirm graphics API, device lifetime, swapchain/present path, and render graph ownership.",
            "3. Query feature requirements before exposing UI.",
            "4. Add resource tagging only after motion vectors, depth, jitter, exposure, camera state, frame index, and reset flags are mapped.",
            "5. Keep Frame Generation HUD-less/UI buffers and Reflex validation as separate reviewed steps.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Add src/nvidia/StreamlineIntegration.cpp to the renderer target.",
        "Call initialize after graphics device creation and shutdown before device destruction.",
        "Wire capability results into settings UI without exposing unsupported features."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Build with the scaffold but without NVIDIA_STREAMLINE_ENABLED first.",
        "After real SDK calls are added, validate feature support queries before any DLSS UI is enabled."
      ]),
      rollback_plan: rollbackPlan("Remove StreamlineIntegration files and the renderer target reference, leaving the original render path untouched."),
      sources: sourceRefs(["nvidia-dlss", "nvidia-streamline-page", "streamline-programming-guide", "streamline-dlssg-guide"])
    }),
    "video-codec-sample-adaptation": () => ({
      summary: "Create a small Video Codec SDK adapter shell for NVENC/NVDEC planning without assuming codec support.",
      files: [
        scaffoldFile("src/nvidia_video/NvidiaVideoCodecAdapter.h", "cpp", "Adapter interface for encode/decode capability checks and sample adaptation.", videoCodecHeader()),
        scaffoldFile("src/nvidia_video/NvidiaVideoCodecAdapter.cpp", "cpp", "Compile-safe adapter shell for future Video Codec SDK or FFmpeg/GStreamer wiring.", videoCodecCpp()),
        scaffoldFile(
          "docs/nvidia/video-codec-adaptation.md",
          "markdown",
          "Checklist for adapting Video Codec SDK samples or framework pipelines.",
          [
            "# NVIDIA Video Codec SDK Adaptation",
            "",
            "Use this scaffold for encode, decode, transcode, capture, streaming, or video dataset ingestion workflows.",
            "",
            "Required checks:",
            "",
            "1. Confirm codec support on the selected GPU.",
            "2. Separate NVENC/NVDEC engine utilization from CUDA or graphics utilization.",
            "3. Validate codec, profile, level, rate control, bit depth, chroma format, and latency.",
            "4. Preserve software fallback until throughput, quality, and A/V sync pass.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Add the adapter to the narrow video pipeline target.",
        "Connect it to existing FFmpeg/GStreamer/Video Codec SDK setup only after capability probing is implemented.",
        "Keep CPU/software fallback configurable."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Run short encode/decode samples with expected codec/profile output.",
        "Collect throughput, latency, quality metrics, dropped frames, and A/V sync drift."
      ]),
      rollback_plan: rollbackPlan("Remove the adapter target references and switch configuration back to the existing software path."),
      sources: sourceRefs(["video-codec-sdk"])
    }),
    "rtx-video-pipeline-skeleton": () => ({
      summary: "Create an RTX Video SDK pipeline shell for media enhancement routing without implementing version-specific SDK calls.",
      files: [
        scaffoldFile("src/nvidia_video/RtxVideoPipeline.h", "cpp", "Pipeline contract for RTX Video Super Resolution, artifact reduction, and SDR-to-HDR routing.", rtxVideoHeader()),
        scaffoldFile("src/nvidia_video/RtxVideoPipeline.cpp", "cpp", "Compile-safe RTX Video pipeline shell with explicit effect selection and validation hooks.", rtxVideoCpp()),
        scaffoldFile(
          "docs/nvidia/rtx-video-pipeline.md",
          "markdown",
          "Checklist for RTX Video SDK media enhancement integration.",
          [
            "# RTX Video SDK Pipeline",
            "",
            "Use RTX Video SDK for media playback and creative-app video enhancement, not DLSS.",
            "",
            "Validate Super Resolution, artifact reduction, and SDR-to-HDR separately.",
            "Confirm input bit depth, color space, source resolution, target resolution, and output display path.",
            "Keep HDR output validation separate from upscaling quality validation.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Attach the pipeline shell at the media frame-processing boundary.",
        "Choose DX11, DX12, Vulkan, or CUDA route only after local SDK docs and project API are confirmed.",
        "Expose effect toggles only after runtime support checks."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Test each RTX Video effect independently on approved clips.",
        "Measure playback latency, throughput, and HDR output behavior."
      ]),
      rollback_plan: rollbackPlan("Disable the RTX Video pipeline selector and route media frames back through the existing playback path."),
      sources: sourceRefs(["rtx-video-sdk"])
    }),
    "nsight-marker-insertion": () => ({
      summary: "Create lightweight marker scopes for Nsight/NVTX-style profiling without changing render behavior.",
      files: [
        scaffoldFile("src/nvidia_diagnostics/NsightMarkerScope.h", "cpp", "RAII marker scope with optional NVTX support when headers are available.", nsightMarkerHeader()),
        scaffoldFile(
          "docs/nvidia/nsight-marker-insertion.md",
          "markdown",
          "Marker placement checklist for render and media pipelines.",
          [
            "# Nsight Marker Insertion",
            "",
            "Insert markers around stable workload regions first: frame begin/end, simulation, culling, shadow pass, lighting, post, UI, encode/decode, and present.",
            "",
            "Markers should make captures easier to read. They must not change frame lifetime, synchronization, or queue ownership.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Include NsightMarkerScope.h in narrow renderer/media modules.",
        "Add scopes around frame regions after profiling goals are defined.",
        "Keep marker insertion separate from functional rendering changes."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Build with marker macros disabled and enabled.",
        "Capture a representative frame or trace and confirm regions are visible and correctly nested."
      ]),
      rollback_plan: rollbackPlan("Remove marker includes/scopes or disable NVIDIA_ENABLE_NVTX without altering render logic."),
      sources: sourceRefs(["nsight-graphics", "nsight-graphics-2025-2"])
    }),
    "reflex-marker-scaffold": () => ({
      summary: "Create a Reflex marker placement scaffold for latency-sensitive render loops without guessing SDK calls.",
      files: [
        scaffoldFile("src/nvidia_latency/ReflexMarkerPlan.h", "cpp", "Frame-stage marker contract for future Reflex or Streamline Reflex calls.", reflexHeader()),
        scaffoldFile("src/nvidia_latency/ReflexMarkerPlan.cpp", "cpp", "Compile-safe Reflex marker shell with explicit stage names and validation hooks.", reflexCpp()),
        scaffoldFile(
          "docs/nvidia/reflex-marker-scaffold.md",
          "markdown",
          "Checklist for Reflex marker placement and latency validation.",
          [
            "# Reflex Marker Scaffold",
            "",
            "Use this scaffold to plan marker placement before wiring real Reflex or Streamline Reflex SDK calls.",
            "",
            "Required stages usually include input sample, simulation start/end, render submit, present, and frame end. Confirm the exact SDK calls from local headers before implementation.",
            ""
          ]
        )
      ],
      host_repo_edits_required: [
        "Place marker calls at real input, simulation, render-submit, present, and frame-end boundaries.",
        "Validate marker placement with representative CPU-bound and GPU-bound scenes.",
        "Keep Reflex wiring separate from DLSS/Frame Generation UI changes."
      ],
      validation_plan: mergePlan(baseValidation, [
        "Measure baseline latency before marker implementation.",
        "Validate latency and frame pacing with and without Frame Generation where applicable."
      ]),
      rollback_plan: rollbackPlan("Disable the Reflex marker adapter and remove stage calls while preserving the original frame loop."),
      sources: sourceRefs(["nvidia-reflex", "nvidia-streamline-page"])
    })
  };

  const factory = table[context.phase3Workflow] || table["streamline-init-scaffold"];
  return { ...common, ...factory() };
}

function scaffoldFile(relativePath, language, purpose, lines) {
  return {
    action: "create",
    relative_path: relativePath,
    language,
    purpose,
    content: Array.isArray(lines) ? `${lines.join("\n")}\n` : String(lines)
  };
}

function writeImplementationFiles(files, context, args) {
  if (args.write_files !== true) return [];
  if (args.approval_token !== "APPROVED_PHASE_3_EDITS") {
    throw new McpError(-32602, "write_files requires approval_token=APPROVED_PHASE_3_EDITS");
  }

  const base = resolvePhase3OutputDir(context, args);
  mkdirSync(base, { recursive: true });
  const written = [];
  for (const file of files || []) {
    if (file.action !== "create" || !file.content) continue;
    const relative = sanitizeRelativeOutputPath(file.relative_path);
    const target = resolve(base, relative);
    if (!isWithinPath(target, base)) throw new McpError(-32602, `Refusing to write outside output directory: ${file.relative_path}`);
    if (existsSync(target)) {
      written.push({ path: target, status: "skipped_existing", reason: "Existing files are never overwritten by this Phase 3 tool." });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    written.push({ path: target, status: "created" });
  }
  return written;
}

function resolvePhase3OutputDir(context, args) {
  if (args.output_dir) return resolveInputPath(args.output_dir);
  if (context.root) return join(context.root, "_nvidia_phase3_scaffolds");
  throw new McpError(-32602, "write_files requires output_dir or project_path");
}

function sanitizeRelativeOutputPath(value) {
  const relative = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!relative || relative.split("/").includes("..") || isAbsolute(relative)) {
    throw new McpError(-32602, `Invalid scaffold relative path: ${value}`);
  }
  return relative;
}

function isWithinPath(child, parent) {
  const resolvedChild = resolve(child).toLowerCase();
  const resolvedParent = resolve(parent).toLowerCase();
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`);
}

function phase3MissingInformation(context, implementation) {
  const missing = phase2MissingInformation(context, { missing_information: [] });
  if (!context.root) missing.push("Project path for repo-specific insertion points.");
  if (!context.sdkRoot && ["cmake-sdk-wiring", "streamline-init-scaffold", "video-codec-sample-adaptation", "rtx-video-pipeline-skeleton"].includes(context.phase3Workflow)) {
    missing.push("User-provided SDK root path for compile-time or runtime wiring.");
  }
  if (implementation.host_repo_edits_required?.length) missing.push("User approval for applying host repo edits after scaffold review.");
  return [...new Set(missing)];
}

function buildEnvironmentReport(options) {
  const processTools = options.includeProcessTools ? probeProcessTools() : null;
  const sdkRoots = options.includeSdkScan ? buildSdkRoots({ include_common_roots: true }) : [];
  const sdkScan = [];
  if (options.includeSdkScan) {
    const seen = new Set();
    for (const root of sdkRoots.slice(0, 12)) {
      if (!root || seen.has(root) || !existsSync(root)) continue;
      seen.add(root);
      sdkScan.push(...scanForSdks(root, 2500));
    }
  }

  const envNames = [
    "CUDA_PATH",
    "CUDA_HOME",
    "NVIDIA_SDK_ROOT",
    "STREAMLINE_SDK",
    "RTX_VIDEO_SDK",
    "VIDEO_CODEC_SDK",
    "PATH"
  ];
  const env = {};
  for (const name of envNames) {
    const value = process.env[name];
    env[name] = value ? (name === "PATH" ? value.split(/[;]/).slice(0, 20) : value) : null;
  }

  const gpuProbe = probeEnvironment();
  return {
    generated_at: new Date().toISOString(),
    local_only: true,
    os: {
      type: os.type(),
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus()?.length || null,
      total_memory_bytes: os.totalmem()
    },
    node: {
      version: process.version,
      executable: process.execPath
    },
    nvidia_gpu_driver: {
      gpu: gpuProbe.gpu,
      nvidia_smi_error: gpuProbe.nvidia_smi_error
    },
    cuda_and_nvidia_environment: env,
    process_tools: processTools,
    sdk_scan: options.includeSdkScan
      ? {
          scanned_roots: sdkRoots.filter(existsSync).slice(0, 12),
          found: dedupeSdkFinds(sdkScan)
        }
      : null,
    project_classification: options.project,
    notes: [
      "Missing NVIDIA GPU, nvidia-smi, SDKs, FFmpeg, or GStreamer is reported as environment state, not failure.",
      "This report does not download SDKs, install tools, upload files, or package NVIDIA binaries."
    ]
  };
}

function probeProcessTools() {
  const ffmpegVersion = probeCommand("ffmpeg", ["-version"], 5000);
  const ffmpegFilters = ffmpegVersion.available ? probeCommand("ffmpeg", ["-hide_banner", "-filters"], 7000) : null;
  const gstLaunch = probeCommand("gst-launch-1.0", ["--version"], 5000);
  const gstInspect = probeCommand("gst-inspect-1.0", ["--version"], 5000);
  const nvidiaSmi = probeCommand("nvidia-smi", ["--version"], 5000);
  return {
    "nvidia-smi": summarizeToolProbe(nvidiaSmi),
    ffmpeg: {
      ...summarizeToolProbe(ffmpegVersion),
      has_libvmaf_filter: Boolean(ffmpegFilters?.available && /libvmaf/i.test(ffmpegFilters.output || "")),
      has_psnr_filter: Boolean(ffmpegFilters?.available && /\bpsnr\b/i.test(ffmpegFilters.output || "")),
      has_ssim_filter: Boolean(ffmpegFilters?.available && /\bssim\b/i.test(ffmpegFilters.output || ""))
    },
    "gst-launch-1.0": summarizeToolProbe(gstLaunch),
    "gst-inspect-1.0": summarizeToolProbe(gstInspect)
  };
}

function probeCommand(command, args = [], timeout = 5000) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    return {
      command,
      args,
      available: !result.error && result.status === 0,
      status: result.status,
      error: result.error ? errorMessage(result.error) : null,
      output
    };
  } catch (error) {
    return { command, args, available: false, status: null, error: errorMessage(error), output: "" };
  }
}

function summarizeToolProbe(probe) {
  if (!probe) return null;
  return {
    available: probe.available,
    status: probe.status,
    error: probe.error,
    summary: firstNonEmptyLine(probe.output)
  };
}

function firstNonEmptyLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function environmentWarnings(report) {
  const warnings = [];
  if (!report.nvidia_gpu_driver.gpu) warnings.push("nvidia-smi did not report an NVIDIA GPU/driver.");
  if (report.process_tools && !report.process_tools.ffmpeg.available) warnings.push("FFmpeg was not found; codec and quality harnesses may be plan-only.");
  if (report.process_tools && !report.process_tools["gst-launch-1.0"].available) warnings.push("GStreamer launcher was not found; GStreamer harnesses may be plan-only.");
  if (report.sdk_scan && !report.sdk_scan.found.length) warnings.push("No NVIDIA SDK files were found in common roots; pass explicit SDK roots when needed.");
  return warnings;
}

function writePhase4Artifacts(files, context, args) {
  if (args.write_artifacts !== true) return [];
  if (args.approval_token !== "APPROVED_PHASE_4_ARTIFACTS") {
    throw new McpError(-32602, "write_artifacts requires approval_token=APPROVED_PHASE_4_ARTIFACTS");
  }
  const base = resolvePhase4OutputDir(context, args);
  mkdirSync(base, { recursive: true });
  const written = [];
  for (const file of files || []) {
    const relative = sanitizeRelativeOutputPath(file.relative_path);
    const target = resolve(base, relative);
    if (!isWithinPath(target, base)) throw new McpError(-32602, `Refusing to write outside output directory: ${file.relative_path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    written.push({ path: target, status: "created_or_replaced" });
  }
  return written;
}

function resolvePhase4OutputDir(context, args) {
  if (args.output_dir) return resolveInputPath(args.output_dir);
  if (context.projectRoot) return join(context.projectRoot, "_nvidia_phase4_validation");
  throw new McpError(-32602, "write_artifacts requires output_dir or project_path");
}

function buildValidationHarness(input) {
  const techId = input.technology?.id || input.technologyInput;
  const requiredTools = requiredToolsForHarness(input.mode, techId, input.workflow);
  const sampleRequired = ["sample-launch-check", "codec-throughput", "quality-compare-plan"].includes(input.mode);
  const blocked = [];
  if (sampleRequired && !input.samplePath) blocked.push("sample_path is required; the plugin will not invent sample media or executable inputs.");
  if (input.samplePath && !existsSync(input.samplePath)) blocked.push(`sample_path does not exist: ${input.samplePath}`);
  if (input.mode === "sample-launch-check" && !input.command) blocked.push("command is required for sample-launch-check.");
  const commandPlan = harnessCommandPlan(input, techId);
  return {
    execution_state: blocked.length ? "blocked_template_only" : "ready_to_run_locally",
    blocked_reasons: blocked,
    command_plan: commandPlan,
    required_tools: requiredTools,
    expected_artifacts: harnessExpectedArtifacts(input.mode, techId),
    pass_fail_criteria: harnessPassFailCriteria(input.mode, techId),
    safety_notes: [
      "Run only on local, license-approved samples and captures.",
      "Do not upload logs, media, captures, crash dumps, or SDK files.",
      "This harness does not download SDKs or install tools."
    ],
    rollback_notes: ["Delete generated validation artifacts if they are no longer needed.", "No repo source cleanup is needed for plan-only harnesses."],
    sources: sourceRefs([...(input.technology?.official_sources || []), "nsight-graphics", "video-codec-sdk", "rtx-video-sdk"])
  };
}

function requiredToolsForHarness(mode, techId, workflow) {
  const tools = [];
  if (mode === "frame-capture-checklist" || /nsight|dlss|streamline|reflex/i.test(`${techId} ${workflow}`)) tools.push("Nsight Graphics or equivalent capture tool");
  if (mode === "codec-throughput" || /codec|nvenc|nvdec|ffmpeg|gstreamer/i.test(`${techId} ${workflow}`)) tools.push("ffmpeg or GStreamer");
  if (mode === "quality-compare-plan") tools.push("ffmpeg for video metrics or project image comparison tool");
  if (/nvidia|dlss|streamline|rtx|codec|reflex|nsight/i.test(`${techId} ${workflow}`)) tools.push("nvidia-smi for GPU/driver reporting when available");
  return [...new Set(tools)];
}

function harnessCommandPlan(input, techId) {
  if (input.mode === "sample-launch-check") {
    return [
      input.command || "<project command> <sample_path>",
      "Capture stdout/stderr and exit code.",
      "Record OS, GPU, driver, SDK/plugin version, and exact sample path."
    ];
  }
  if (input.mode === "frame-capture-checklist") {
    return [
      "Open the representative workload in Nsight Graphics or the selected capture tool.",
      "Capture the exact frame or GPU trace that exercises the NVIDIA feature.",
      "Record driver, GPU, API backend, scene/sample, feature settings, and expected artifact path."
    ];
  }
  if (input.mode === "codec-throughput") {
    const sample = input.samplePath || "<sample_path>";
    return [
      `ffmpeg -hide_banner -benchmark -hwaccel cuda -i "${sample}" -f null -`,
      `ffmpeg -hide_banner -benchmark -i "${sample}" -c:v h264_nvenc -f null -`,
      "Use the command matching the project codec path; do not assume CUDA/NVENC/NVDEC support until logs prove it."
    ];
  }
  if (input.mode === "quality-compare-plan") {
    const sample = input.samplePath || "<reference_path>";
    return [
      `Use nvidia_quality_compare with reference_path="${sample}" and candidate_path="<candidate_path>".`,
      "Start with ffmpeg-psnr-ssim when FFmpeg is available; use ffmpeg-vmaf only when libvmaf is present."
    ];
  }
  return ["No command plan available for this mode."];
}

function harnessExpectedArtifacts(mode, techId) {
  const table = {
    "sample-launch-check": ["stdout/stderr log", "exit code", "environment report", "feature support result"],
    "frame-capture-checklist": ["Nsight capture or GPU trace", "capture notes", "driver/GPU/API metadata", "representative scene/sample name"],
    "codec-throughput": ["throughput log", "codec support notes", "NVENC/NVDEC utilization notes", "A/V sync notes"],
    "quality-compare-plan": ["quality metrics JSON", "comparison command log", "source/candidate metadata"]
  };
  return [...(table[mode] || []), ...expectedArtifacts(techId || "")];
}

function harnessPassFailCriteria(mode, techId) {
  const common = ["No unsupported feature is exposed as enabled.", "No proprietary media, captures, logs, or SDK files are uploaded."];
  const table = {
    "sample-launch-check": ["Command exits successfully or returns a classified failure.", "Logs do not show missing SDK/binary/load failures for the claimed feature."],
    "frame-capture-checklist": ["Capture includes the target frame/workload.", "Resource states, markers, and feature settings are visible enough to debug."],
    "codec-throughput": ["Hardware path is confirmed by logs before claiming acceleration.", "Throughput and A/V sync meet the project's target."],
    "quality-compare-plan": ["Metrics are produced from matching reference/candidate dimensions or the mismatch is reported clearly.", "Metric choice matches the content type and test goal."]
  };
  return [...(table[mode] || []), ...common, ...metricsFor(techId || "").map((metric) => `Record metric: ${metric}`)];
}

function analyzeLogs(paths, technology, limit) {
  const findings = [];
  const unreadable = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      unreadable.push({ path, error: "Path does not exist" });
      continue;
    }
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const files = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(log|txt|out|err)$/i.test(entry.name))
        .map((entry) => join(path, entry.name));
      const nested = analyzeLogs(files, technology, Math.max(1, limit - findings.length));
      findings.push(...nested.findings);
      unreadable.push(...nested.unreadable_paths);
      continue;
    }
    const text = safeRead(path, 2_000_000);
    if (!text) {
      unreadable.push({ path, error: "File could not be read or is empty" });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && findings.length < limit; index++) {
      const matches = matchLogLine(lines[index], technology);
      for (const match of matches) {
        findings.push({
          ...match,
          path,
          line: index + 1,
          text: lines[index].trim()
        });
        if (findings.length >= limit) break;
      }
    }
  }
  return { findings, unreadable_paths: unreadable };
}

function matchLogLine(line, technology) {
  const text = lower(`${technology || ""} ${line}`);
  const patterns = [
    {
      severity: "error",
      pattern: /(failed|error|exception|fatal).*(streamline|dlss|sl\.|nvngx|nvidia)/i,
      category: "streamline_dlss_load",
      likely_cause: "NVIDIA Streamline/DLSS load, initialization, or runtime failure.",
      next_step: "Check SDK version, binary placement, signatures, feature support query, and runtime logs."
    },
    {
      severity: "warning",
      pattern: /((unsupported|not supported|feature.*disabled|requirements.*failed).*(dlss|frame generation|streamline|reflex))|((dlss|frame generation|streamline|reflex).*(unsupported|not supported|disabled|requirements.*failed))/i,
      category: "feature_unsupported",
      likely_cause: "Feature requirement query or runtime compatibility check failed.",
      next_step: "Hide/disable UI for the feature and collect GPU, driver, OS, API, SDK, and settings."
    },
    {
      severity: "error",
      pattern: /(uproject|uplugin|plugin).*(missing|failed|incompatible|not found).*(dlss|streamline|nvidia|reflex)/i,
      category: "unreal_plugin",
      likely_cause: "Unreal plugin descriptor, version, or packaging path problem.",
      next_step: "Validate UE version/plugin package match and packaged-build logs."
    },
    {
      severity: "warning",
      pattern: /(h264_nvenc|hevc_nvenc|av1_nvenc|nvdec|cuvid|cuda).*(not found|unavailable|failed|fallback|software)/i,
      category: "video_codec_acceleration",
      likely_cause: "NVENC/NVDEC path is unavailable or falling back.",
      next_step: "Check GPU codec support, FFmpeg/GStreamer build options, driver, and selected codec/profile."
    },
    {
      severity: "warning",
      pattern: /(ffmpeg|gstreamer|gst).*(hwaccel|nvenc|nvdec|cuda).*(failed|unavailable|fallback|not negotiated)/i,
      category: "framework_hwaccel",
      likely_cause: "Framework hardware acceleration path failed or caps negotiation did not use NVIDIA acceleration.",
      next_step: "Inspect pipeline caps, hwframes context, codec support, and logs with verbose framework output."
    },
    {
      severity: "error",
      pattern: /(gpu crash|tdr|device removed|device lost|aftermath|crash dump|nv-gpudmp)/i,
      category: "nsight_aftermath",
      likely_cause: "GPU crash/hang/TDR or Aftermath capture clue.",
      next_step: "Collect Nsight Graphics/Aftermath artifacts with repro scene, symbols, GPU, driver, and API backend."
    },
    {
      severity: "info",
      pattern: /(streamline|dlss|reflex|nvenc|nvdec|nvidia|nsight).*(loaded|enabled|initialized|available|created)/i,
      category: "nvidia_feature_state",
      likely_cause: "NVIDIA-related feature state was reported.",
      next_step: "Correlate this line with capability checks, validation metrics, and expected runtime settings."
    }
  ];
  return patterns
    .filter((item) => item.pattern.test(line) || (technology && item.pattern.test(text)))
    .map((item) => ({
      severity: item.severity,
      category: item.category,
      likely_cause: item.likely_cause,
      recommended_next_validation_step: item.next_step
    }));
}

function groupFindingsBySeverity(findings) {
  const groups = { error: [], warning: [], info: [] };
  for (const finding of findings) {
    const key = groups[finding.severity] ? finding.severity : "info";
    groups[key].push(finding);
  }
  return groups;
}

function buildQualityCompareResult(referencePath, candidatePath, metricSet) {
  const missing = [];
  const actionable = [];
  if (!existsSync(referencePath)) missing.push(`reference_path does not exist: ${referencePath}`);
  if (!existsSync(candidatePath)) missing.push(`candidate_path does not exist: ${candidatePath}`);
  const ffmpeg = probeProcessTools().ffmpeg;
  const needsFfmpeg = ["video-basic", "ffmpeg-psnr-ssim", "ffmpeg-vmaf"].includes(metricSet);
  if (needsFfmpeg && !ffmpeg.available) missing.push("FFmpeg was not found on PATH.");
  if (metricSet === "ffmpeg-vmaf" && ffmpeg.available && !ffmpeg.has_libvmaf_filter) missing.push("FFmpeg is available but does not advertise the libvmaf filter.");

  const commandPlan = qualityCommandPlan(referencePath, candidatePath, metricSet);
  const parsedMetrics = {};
  if (!missing.length) {
    if (metricSet === "image-basic") {
      parsedMetrics.reference = fileSummary(referencePath);
      parsedMetrics.candidate = fileSummary(candidatePath);
    } else if (metricSet === "video-basic") {
      parsedMetrics.reference = fileSummary(referencePath);
      parsedMetrics.candidate = fileSummary(candidatePath);
      parsedMetrics.ffmpeg_summary = firstNonEmptyLine(probeCommand("ffmpeg", ["-hide_banner", "-i", referencePath], 8000).output);
    } else if (metricSet === "ffmpeg-psnr-ssim") {
      Object.assign(parsedMetrics, runPsnrSsim(referencePath, candidatePath));
    } else if (metricSet === "ffmpeg-vmaf") {
      Object.assign(parsedMetrics, runVmaf(referencePath, candidatePath));
    }
  } else {
    actionable.push(...missing.map((item) => `Resolve requirement: ${item}`));
  }
  return {
    execution_state: missing.length ? "blocked_missing_requirements" : "completed_or_ready",
    command_plan: commandPlan,
    parsed_metrics: parsedMetrics,
    missing_requirements: missing,
    actionable_errors: actionable
  };
}

function qualityCommandPlan(referencePath, candidatePath, metricSet) {
  if (metricSet === "ffmpeg-psnr-ssim") {
    return [
      `ffmpeg -hide_banner -i "${referencePath}" -i "${candidatePath}" -lavfi psnr -f null -`,
      `ffmpeg -hide_banner -i "${referencePath}" -i "${candidatePath}" -lavfi ssim -f null -`
    ];
  }
  if (metricSet === "ffmpeg-vmaf") {
    return [`ffmpeg -hide_banner -i "${referencePath}" -i "${candidatePath}" -lavfi libvmaf -f null -`];
  }
  if (metricSet === "video-basic") {
    return [`ffmpeg -hide_banner -i "${referencePath}"`, `ffmpeg -hide_banner -i "${candidatePath}"`];
  }
  return ["Compare file metadata and project-specific image quality metrics."];
}

function fileSummary(path) {
  const stat = statSync(path);
  return {
    path,
    bytes: stat.size,
    modified_at: stat.mtime.toISOString()
  };
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function releaseDocsStatus(root) {
  const docs = [
    "README.md",
    "SECURITY.md",
    "PRIVACY.md",
    "docs/getting-started.md",
    "docs/examples.md",
    "docs/limitations.md",
    "docs/tool-contracts.md",
    "docs/source-policy.md",
    "docs/security-privacy.md",
    "docs/changelog.md",
    "docs/release-readiness.md"
  ];
  return docs.map((file) => ({
    path: file,
    exists: existsSync(join(root, ...file.split("/")))
  }));
}

function releaseScriptStatus(root) {
  const scripts = [
    "scripts/nvidia-rtx-dlss-mcp.mjs",
    "scripts/tests/test-routing-and-fixtures.ps1",
    "scripts/tests/test-assisted-implementation.ps1",
    "scripts/tests/test-validation-automation.ps1",
    "scripts/tests/test-production-readiness.ps1",
    "scripts/validation/env-report.mjs",
    "scripts/validation/log-analyze.mjs",
    "scripts/validation/quality-compare.mjs",
    "scripts/validation/codec-throughput.mjs"
  ];
  return scripts.map((file) => ({
    path: file,
    exists: existsSync(join(root, ...file.split("/")))
  }));
}

function releaseChecklist({ root, manifest, docs, scripts, registryAudit }) {
  const items = [
    { id: "manifest_present", pass: Boolean(manifest), detail: ".codex-plugin/plugin.json exists and parses" },
    { id: "version_rc", pass: manifest?.version === VERSION, detail: `manifest version matches server ${VERSION}` },
    { id: "no_placeholder_author", pass: manifest?.author?.name && !/local|todo|placeholder/i.test(manifest.author.name), detail: "author metadata is not placeholder text" },
    { id: "docs_complete", pass: docs.every((item) => item.exists), detail: "production docs are present" },
    { id: "tests_complete", pass: scripts.every((item) => item.exists), detail: "production test scripts and validation helpers are present" },
    { id: "registry_ready", pass: !registryAudit || registryAudit.readiness_score >= 85, detail: "registry audit score is release-candidate quality" },
    { id: "no_phase_docs", pass: !["docs/phase-2-plan.md", "docs/phase-3-plan.md", "docs/phase-4-plan.md"].some((file) => existsSync(join(root, ...file.split("/")))), detail: "development phase docs were cleaned from production package" }
  ];
  const passed = items.filter((item) => item.pass).length;
  return {
    score: Math.round((passed / items.length) * 100),
    gate: items.every((item) => item.pass) ? "release_candidate_ready" : "needs_attention",
    items
  };
}

function runPsnrSsim(referencePath, candidatePath) {
  const psnr = runFfmpegMetric(["-hide_banner", "-i", referencePath, "-i", candidatePath, "-lavfi", "psnr", "-f", "null", "-"], 20000);
  const ssim = runFfmpegMetric(["-hide_banner", "-i", referencePath, "-i", candidatePath, "-lavfi", "ssim", "-f", "null", "-"], 20000);
  return {
    psnr: {
      average: parseFloatMatch(psnr.output, /average:([0-9.]+)/i),
      raw_summary: lastMetricLine(psnr.output, /psnr/i),
      status: psnr.status,
      error: psnr.error
    },
    ssim: {
      all: parseFloatMatch(ssim.output, /All:([0-9.]+)/i),
      raw_summary: lastMetricLine(ssim.output, /ssim/i),
      status: ssim.status,
      error: ssim.error
    }
  };
}

function runVmaf(referencePath, candidatePath) {
  const vmaf = runFfmpegMetric(["-hide_banner", "-i", referencePath, "-i", candidatePath, "-lavfi", "libvmaf", "-f", "null", "-"], 30000);
  return {
    vmaf: {
      score: parseFloatMatch(vmaf.output, /VMAF score:\s*([0-9.]+)/i),
      raw_summary: lastMetricLine(vmaf.output, /vmaf/i),
      status: vmaf.status,
      error: vmaf.error
    }
  };
}

function runFfmpegMetric(args, timeout) {
  const result = probeCommand("ffmpeg", args, timeout);
  return {
    status: result.status,
    error: result.error,
    output: result.output
  };
}

function parseFloatMatch(text, regex) {
  const match = String(text || "").match(regex);
  return match ? Number.parseFloat(match[1]) : null;
}

function lastMetricLine(text, regex) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => regex.test(line))
    .pop() || null;
}

function cmakeSdkOptions() {
  return [
    "# NVIDIA RTX SDK option wiring.",
    "# Include this file from the top-level CMakeLists.txt after project().",
    "",
    "option(NVIDIA_RTX_ENABLE_STREAMLINE \"Enable user-provided NVIDIA Streamline SDK integration\" OFF)",
    "set(NVIDIA_STREAMLINE_SDK_ROOT \"\" CACHE PATH \"Path to a user-provided NVIDIA Streamline SDK root\")",
    "set(NVIDIA_STREAMLINE_LIBRARY_DIR \"\" CACHE PATH \"Optional Streamline library directory for the selected platform/config\")",
    "set(NVIDIA_STREAMLINE_RUNTIME_DIR \"\" CACHE PATH \"Optional Streamline runtime binary directory for reviewed packaging steps\")",
    "",
    "function(nvidia_rtx_require_existing_path variable description)",
    "  if(NOT EXISTS \"${${variable}}\")",
    "    message(FATAL_ERROR \"${description} was not found: ${${variable}}\")",
    "  endif()",
    "endfunction()",
    "",
    "if(NVIDIA_RTX_ENABLE_STREAMLINE)",
    "  if(NOT NVIDIA_STREAMLINE_SDK_ROOT)",
    "    message(FATAL_ERROR \"Set NVIDIA_STREAMLINE_SDK_ROOT to a local Streamline SDK path; this project does not download SDKs.\")",
    "  endif()",
    "  nvidia_rtx_require_existing_path(NVIDIA_STREAMLINE_SDK_ROOT \"NVIDIA Streamline SDK root\")",
    "  set(NVIDIA_STREAMLINE_INCLUDE_DIR \"${NVIDIA_STREAMLINE_SDK_ROOT}/include\" CACHE PATH \"NVIDIA Streamline include directory\")",
    "  if(NOT EXISTS \"${NVIDIA_STREAMLINE_INCLUDE_DIR}\")",
    "    message(FATAL_ERROR \"NVIDIA Streamline include directory was not found: ${NVIDIA_STREAMLINE_INCLUDE_DIR}\")",
    "  endif()",
    "  add_library(nvidia_streamline_sdk INTERFACE)",
    "  target_include_directories(nvidia_streamline_sdk INTERFACE",
    "    \"${NVIDIA_STREAMLINE_INCLUDE_DIR}\"",
    "  )",
    "  if(NVIDIA_STREAMLINE_LIBRARY_DIR)",
    "    nvidia_rtx_require_existing_path(NVIDIA_STREAMLINE_LIBRARY_DIR \"NVIDIA Streamline library directory\")",
    "    target_link_directories(nvidia_streamline_sdk INTERFACE",
    "      \"${NVIDIA_STREAMLINE_LIBRARY_DIR}\"",
    "    )",
    "  endif()",
    "  target_compile_definitions(nvidia_streamline_sdk INTERFACE",
    "    NVIDIA_STREAMLINE_ENABLED=1",
    "  )",
    "  if(NVIDIA_STREAMLINE_RUNTIME_DIR)",
    "    nvidia_rtx_require_existing_path(NVIDIA_STREAMLINE_RUNTIME_DIR \"NVIDIA Streamline runtime directory\")",
    "    message(STATUS \"Streamline runtime dir is configured for review only: ${NVIDIA_STREAMLINE_RUNTIME_DIR}\")",
    "  endif()",
    "endif()",
    ""
  ];
}

function streamlineHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "#include <string>",
    "",
    "namespace nvidia_rtx {",
    "",
    "struct StreamlineInitDesc {",
    "  void* nativeDevice = nullptr;",
    "  void* swapchain = nullptr;",
    "  const char* applicationId = nullptr;",
    "};",
    "",
    "struct StreamlineFeatureSupport {",
    "  bool available = false;",
    "  std::string reason;",
    "};",
    "",
    "class StreamlineIntegration {",
    " public:",
    "  bool initialize(const StreamlineInitDesc& desc);",
    "  void shutdown();",
    "  bool isInitialized() const;",
    "  StreamlineFeatureSupport queryDlssSupport() const;",
    "  StreamlineFeatureSupport queryFrameGenerationSupport() const;",
    "",
    " private:",
    "  bool initialized_ = false;",
    "};",
    "",
    "}  // namespace nvidia_rtx",
    ""
  ];
}

function streamlineCpp() {
  return [
    "#include \"StreamlineIntegration.h\"",
    "",
    "namespace nvidia_rtx {",
    "",
    "bool StreamlineIntegration::initialize(const StreamlineInitDesc& desc) {",
    "  if (!desc.nativeDevice || !desc.swapchain) {",
    "    initialized_ = false;",
    "    return false;",
    "  }",
    "#if defined(NVIDIA_STREAMLINE_ENABLED)",
    "  // Insert version-matched Streamline initialization calls from local SDK headers here.",
    "  // Keep feature requirement queries and resource tagging in separate reviewed patches.",
    "#endif",
    "  initialized_ = true;",
    "  return true;",
    "}",
    "",
    "void StreamlineIntegration::shutdown() {",
    "#if defined(NVIDIA_STREAMLINE_ENABLED)",
    "  // Insert version-matched Streamline shutdown calls from local SDK headers here.",
    "#endif",
    "  initialized_ = false;",
    "}",
    "",
    "bool StreamlineIntegration::isInitialized() const { return initialized_; }",
    "",
    "StreamlineFeatureSupport StreamlineIntegration::queryDlssSupport() const {",
    "  if (!initialized_) return {false, \"StreamlineIntegration is not initialized\"};",
    "#if defined(NVIDIA_STREAMLINE_ENABLED)",
    "  // Replace this with SDK feature requirement queries before exposing DLSS UI.",
    "  return {false, \"Wire Streamline DLSS requirement query from local SDK headers\"};",
    "#else",
    "  return {false, \"NVIDIA_STREAMLINE_ENABLED is not defined\"};",
    "#endif",
    "}",
    "",
    "StreamlineFeatureSupport StreamlineIntegration::queryFrameGenerationSupport() const {",
    "  if (!initialized_) return {false, \"StreamlineIntegration is not initialized\"};",
    "#if defined(NVIDIA_STREAMLINE_ENABLED)",
    "  // Replace this with SDK feature requirement queries and Reflex validation.",
    "  return {false, \"Wire Streamline Frame Generation requirement query from local SDK headers\"};",
    "#else",
    "  return {false, \"NVIDIA_STREAMLINE_ENABLED is not defined\"};",
    "#endif",
    "}",
    "",
    "}  // namespace nvidia_rtx",
    ""
  ];
}

function videoCodecHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "#include <string>",
    "",
    "namespace nvidia_video {",
    "",
    "struct CodecRequest {",
    "  std::string codec;",
    "  std::string profile;",
    "  int width = 0;",
    "  int height = 0;",
    "  int fpsNumerator = 0;",
    "  int fpsDenominator = 1;",
    "};",
    "",
    "struct CodecCapability {",
    "  bool supported = false;",
    "  std::string reason;",
    "};",
    "",
    "class NvidiaVideoCodecAdapter {",
    " public:",
    "  CodecCapability queryEncodeSupport(const CodecRequest& request) const;",
    "  CodecCapability queryDecodeSupport(const CodecRequest& request) const;",
    "};",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function videoCodecCpp() {
  return [
    "#include \"NvidiaVideoCodecAdapter.h\"",
    "",
    "namespace nvidia_video {",
    "",
    "CodecCapability NvidiaVideoCodecAdapter::queryEncodeSupport(const CodecRequest& request) const {",
    "  if (request.codec.empty() || request.width <= 0 || request.height <= 0) {",
    "    return {false, \"codec, width, and height are required\"};",
    "  }",
    "  // Insert Video Codec SDK, FFmpeg, or GStreamer capability query here.",
    "  return {false, \"Wire NVENC capability query before enabling encode\"};",
    "}",
    "",
    "CodecCapability NvidiaVideoCodecAdapter::queryDecodeSupport(const CodecRequest& request) const {",
    "  if (request.codec.empty() || request.width <= 0 || request.height <= 0) {",
    "    return {false, \"codec, width, and height are required\"};",
    "  }",
    "  // Insert Video Codec SDK, FFmpeg, or GStreamer capability query here.",
    "  return {false, \"Wire NVDEC capability query before enabling decode\"};",
    "}",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function rtxVideoHeader() {
  return [
    "#pragma once",
    "",
    "#include <string>",
    "",
    "namespace nvidia_video {",
    "",
    "enum class RtxVideoEffect {",
    "  SuperResolution,",
    "  ArtifactReduction,",
    "  SdrToHdr",
    "};",
    "",
    "struct RtxVideoFrameDesc {",
    "  int width = 0;",
    "  int height = 0;",
    "  int bitDepth = 8;",
    "  std::string colorSpace;",
    "};",
    "",
    "struct RtxVideoSupport {",
    "  bool supported = false;",
    "  std::string reason;",
    "};",
    "",
    "class RtxVideoPipeline {",
    " public:",
    "  RtxVideoSupport querySupport(RtxVideoEffect effect, const RtxVideoFrameDesc& input) const;",
    "};",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function rtxVideoCpp() {
  return [
    "#include \"RtxVideoPipeline.h\"",
    "",
    "namespace nvidia_video {",
    "",
    "RtxVideoSupport RtxVideoPipeline::querySupport(RtxVideoEffect effect, const RtxVideoFrameDesc& input) const {",
    "  if (input.width <= 0 || input.height <= 0) return {false, \"valid frame dimensions are required\"};",
    "  if (input.bitDepth != 8 && input.bitDepth != 10) return {false, \"validate bit depth support against the local RTX Video SDK\"};",
    "  switch (effect) {",
    "    case RtxVideoEffect::SuperResolution:",
    "      return {false, \"wire RTX Video Super Resolution support query from local SDK docs\"};",
    "    case RtxVideoEffect::ArtifactReduction:",
    "      return {false, \"wire RTX Video artifact reduction support query from local SDK docs\"};",
    "    case RtxVideoEffect::SdrToHdr:",
    "      return {false, \"wire SDR-to-HDR support and display path validation from local SDK docs\"};",
    "  }",
    "  return {false, \"unknown RTX Video effect\"};",
    "}",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function nsightMarkerHeader() {
  return [
    "#pragma once",
    "",
    "#if defined(NVIDIA_ENABLE_NVTX)",
    "#  if __has_include(<nvtx3/nvToolsExt.h>)",
    "#    include <nvtx3/nvToolsExt.h>",
    "#    define NVIDIA_RTX_HAS_NVTX 1",
    "#  elif __has_include(<nvToolsExt.h>)",
    "#    include <nvToolsExt.h>",
    "#    define NVIDIA_RTX_HAS_NVTX 1",
    "#  endif",
    "#endif",
    "",
    "namespace nvidia_diagnostics {",
    "",
    "class NsightMarkerScope {",
    " public:",
    "  explicit NsightMarkerScope(const char* name) {",
    "#if defined(NVIDIA_RTX_HAS_NVTX)",
    "    nvtxRangePushA(name);",
    "#else",
    "    (void)name;",
    "#endif",
    "  }",
    "",
    "  ~NsightMarkerScope() {",
    "#if defined(NVIDIA_RTX_HAS_NVTX)",
    "    nvtxRangePop();",
    "#endif",
    "  }",
    "",
    "  NsightMarkerScope(const NsightMarkerScope&) = delete;",
    "  NsightMarkerScope& operator=(const NsightMarkerScope&) = delete;",
    "};",
    "",
    "}  // namespace nvidia_diagnostics",
    ""
  ];
}

function reflexHeader() {
  return [
    "#pragma once",
    "",
    "#include <string>",
    "",
    "namespace nvidia_latency {",
    "",
    "enum class ReflexFrameStage {",
    "  InputSample,",
    "  SimulationStart,",
    "  SimulationEnd,",
    "  RenderSubmit,",
    "  PresentStart,",
    "  FrameEnd",
    "};",
    "",
    "const char* toString(ReflexFrameStage stage);",
    "",
    "class ReflexMarkerPlan {",
    " public:",
    "  void mark(ReflexFrameStage stage);",
    "};",
    "",
    "}  // namespace nvidia_latency",
    ""
  ];
}

function reflexCpp() {
  return [
    "#include \"ReflexMarkerPlan.h\"",
    "",
    "namespace nvidia_latency {",
    "",
    "const char* toString(ReflexFrameStage stage) {",
    "  switch (stage) {",
    "    case ReflexFrameStage::InputSample: return \"InputSample\";",
    "    case ReflexFrameStage::SimulationStart: return \"SimulationStart\";",
    "    case ReflexFrameStage::SimulationEnd: return \"SimulationEnd\";",
    "    case ReflexFrameStage::RenderSubmit: return \"RenderSubmit\";",
    "    case ReflexFrameStage::PresentStart: return \"PresentStart\";",
    "    case ReflexFrameStage::FrameEnd: return \"FrameEnd\";",
    "  }",
    "  return \"Unknown\";",
    "}",
    "",
    "void ReflexMarkerPlan::mark(ReflexFrameStage stage) {",
    "  (void)stage;",
    "  // Insert version-matched Reflex or Streamline Reflex marker calls from local SDK headers here.",
    "}",
    "",
    "}  // namespace nvidia_latency",
    ""
  ];
}

function unrealValidationScript() {
  return [
    "param(",
    "  [string]$ProjectRoot = (Get-Location).Path",
    ")",
    "",
    "$ErrorActionPreference = 'Stop'",
    "$uproject = Get-ChildItem -LiteralPath $ProjectRoot -Filter '*.uproject' -File | Select-Object -First 1",
    "if (!$uproject) { throw \"No .uproject file found in $ProjectRoot\" }",
    "$json = Get-Content -LiteralPath $uproject.FullName -Raw | ConvertFrom-Json",
    "$plugins = @($json.Plugins | Where-Object { $_.Name -match 'DLSS|Streamline|NVIDIA|Reflex' })",
    "$configFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'Config') -Filter '*.ini' -File -ErrorAction SilentlyContinue",
    "$configHits = @()",
    "foreach ($file in $configFiles) {",
    "  $hits = Select-String -LiteralPath $file.FullName -Pattern 'DLSS|Streamline|Reflex|NVIDIA' -SimpleMatch:$false -ErrorAction SilentlyContinue",
    "  foreach ($hit in $hits) { $configHits += [pscustomobject]@{ file = $file.FullName; line = $hit.LineNumber; text = $hit.Line.Trim() } }",
    "}",
    "",
    "[pscustomobject]@{",
    "  project = $uproject.FullName",
    "  engineAssociation = $json.EngineAssociation",
    "  nvidiaPluginEntries = $plugins",
    "  nvidiaConfigHits = $configHits",
    "  notes = @(",
    "    'Match the NVIDIA plugin package to the detected Unreal Engine version.',",
    "    'Validate editor and packaged-build logs separately.',",
    "    'Do not copy NVIDIA binaries until license and production-library checks are complete.'",
    "  )",
    "} | ConvertTo-Json -Depth 12",
    ""
  ];
}

function requiredResourcesFor(technologyId) {
  const table = {
    "dlss-streamline": [
      "SDK version and feature DLLs",
      "GPU/driver/OS/API feature requirement query result",
      "color buffers, depth, motion vectors, jitter, exposure, camera matrices/state, frame index, reset flags",
      "HUD-less and UI buffers for Frame Generation where required",
      "swapchain/present path and resource lifetime model",
      "Reflex integration route for latency-sensitive and Frame Generation workflows"
    ],
    "unreal-dlss-plugin": [
      "UE version",
      "official NVIDIA plugin package matched to UE version",
      ".uproject/.uplugin configuration",
      "project settings, console variables, runtime logs, packaged build layout"
    ],
    "unity-hdrp-dlss": [
      "Unity version",
      "HDRP package version and render pipeline asset",
      "camera/dynamic resolution settings",
      "Reflex measurement route where latency matters"
    ],
    "optical-flow-fruc": [
      "Optical Flow SDK / NvOFFRUC version and license-approved local SDK path",
      "native/backend boundary for YouTube/browser playback",
      "two consecutive decoded frames in ARGB or NV12-compatible surfaces",
      "timing/cadence plan for 60 fps input to 120 fps output",
      "GPU, driver, CUDA/toolchain, DirectX/CUDA path, and OS support check"
    ],
    "rtx-video-sdk": [
      "Windows/API route: DX11, DX12, Vulkan, or CUDA",
      "video frame format, bit depth, color space, source resolution, target resolution",
      "effect choice: Super Resolution, Artifact Reduction, SDR-to-HDR",
      "display/output path for HDR validation"
    ],
    "video-codec-sdk": [
      "GPU codec support matrix result",
      "codec, profile, level, rate control, bit depth, chroma format",
      "decode/encode framework: Video Codec SDK, FFmpeg, GStreamer, DirectX Video, Vulkan Video, PyNvVideoCodec",
      "memory path and zero-copy requirements"
    ],
    reflex: [
      "pipeline stage boundaries",
      "marker placement plan",
      "latency measurement target",
      "Frame Generation relationship if applicable"
    ],
    "nsight-aftermath": [
      "exact repro scene or workload",
      "API backend and shader symbols",
      "capture/trace/crash dump mode",
      "expected artifact storage location"
    ],
    "rtx-kit": [
      "selected RTX Kit component",
      "renderer/API/GPU/driver requirements",
      "asset/material/geometry data",
      "quality and performance baseline"
    ],
    "web-boundary": [
      "pure browser versus Electron/native/server deployment model",
      "WebGPU/WebCodecs capability target",
      "native companion IPC/frame sharing plan when NVIDIA SDKs are required",
      "latency and security boundary"
    ]
  };
  return table[technologyId] || [];
}

function integrationSteps(technologyId, goal, depth) {
  const common = [
    "Classify the project and content pipeline before choosing an SDK.",
    "Resolve local SDK docs/headers first, then official NVIDIA docs for the detected version.",
    "Run a compatibility report before implementation.",
    "Create a patch plan and validation plan before any code edits."
  ];
  const table = {
    "dlss-streamline": [
      "Inventory renderer API, swapchain/present path, render graph, frame resource lifetimes, and existing NVIDIA dependencies.",
      "Locate or acquire Streamline SDK through official sources with user approval.",
      "Validate feature requirements through SDK state queries for DLSS, Frame Generation, Ray Reconstruction, Reflex, and selected features.",
      "Plan resource tagging for required inputs: color, depth, motion vectors, exposure, jitter, camera state, frame index, and reset flags.",
      "Plan Frame Generation UI/HUD-less buffers and present-time data if FG/MFG/DMFG is in scope.",
      "Plan signature verification and production binary packaging.",
      "Plan Nsight and Streamline debug visualization validation."
    ],
    "unreal-dlss-plugin": [
      "Detect UE version from project files and engine association.",
      "Select the official NVIDIA DLSS Unreal plugin package for that UE version.",
      "Inspect plugin placement, .uplugin state, project settings, console variables, and packaging config.",
      "Plan editor and packaged-build validation with runtime logs and feature availability checks."
    ],
    "unity-hdrp-dlss": [
      "Detect Unity version, HDRP package, render pipeline asset, and camera settings.",
      "Confirm HDRP/native DLSS route before considering custom SRP/native plugin work.",
      "Plan DLSS/Reflex settings validation and runtime feature gating.",
      "Treat URP/custom SRP as advanced and require render pipeline inspection."
    ],
    "optical-flow-fruc": [
      "Keep the browser/YouTube page separate from the NVIDIA native/backend frame interpolation layer.",
      "Decode or capture frames through a legal, user-approved path; do not bypass DRM or platform restrictions.",
      "Feed consecutive ARGB/NV12-compatible frames into NvOFFRUC or an Optical Flow SDK FRUC integration.",
      "Interleave interpolated frames between original frames to target 120 fps from 60 fps input.",
      "Validate A/V sync, latency, buffering, artifacting, and frame pacing before considering live playback."
    ],
    "rtx-video-sdk": [
      "Classify frame acquisition, color format, bit depth, color space, timing, and output display path.",
      "Choose Super Resolution, Artifact Reduction, SDR-to-HDR, or a composed effect path.",
      "Validate API route: DX11, DX12, Vulkan, or CUDA.",
      "Plan real-time playback latency, throughput, and quality comparisons."
    ],
    "video-codec-sdk": [
      "Classify encode/decode/transcode/capture/streaming framework and codec targets.",
      "Check GPU codec support matrix for NVENC/NVDEC feature support.",
      "Choose low-level Video Codec SDK, FFmpeg/GStreamer acceleration, DirectX/Vulkan Video, or PyNvVideoCodec based on the repo.",
      "Plan rate-control, profile, bit-depth, chroma, memory path, and throughput validation."
    ],
    reflex: [
      "Identify CPU/GPU pipeline boundaries and latency-sensitive interactions.",
      "Plan Reflex integration through Streamline or Reflex SDK.",
      "Add measurement marker plan before code edits.",
      "Validate latency with representative scenes and frame pacing measurements."
    ],
    "nsight-aftermath": [
      "Choose Graphics Capture, GPU Trace, Nsight Systems, or crash dump workflow based on symptom.",
      "Define repro workload, capture timing, symbols, and expected artifacts.",
      "Plan resource, shader, acceleration structure, queue, and timeline inspection."
    ],
    "rtx-kit": [
      "Map the asset/rendering problem to a specific RTX Kit component.",
      "Resolve that component's official docs and repository requirements.",
      "Plan asset conversion, shader/runtime integration, visual quality checks, and Nsight profiling."
    ],
    "web-boundary": [
      "Separate browser-native goals from native NVIDIA SDK requirements.",
      "Choose pure WebGPU/WebCodecs, Electron/native companion, native plugin architecture, or server-side NVIDIA GPU pipeline.",
      "Plan IPC, memory/frame sharing, latency, security, and deployment boundaries."
    ]
  };
  const steps = [...common, ...(table[technologyId] || [])];
  return depth === "brief" ? steps.slice(0, 6) : steps;
}

function validationSteps(technologyId, includeMetrics = true) {
  const tech = findTechnology(technologyId);
  const base = tech?.validation || [];
  const extra = {
    "dlss-streamline": [
      "Confirm all required buffers are valid for the frame being presented.",
      "Check pause/load/menu/resolution-change behavior for Frame Generation.",
      "Confirm generated frames are accounted for correctly in FPS reporting.",
      "Use debug overlays/visualization where available."
    ],
    "optical-flow-fruc": [
      "Test 1080p60 input to 1080p120 output with motion-heavy clips.",
      "Validate interpolated-frame cadence, duplicate-frame rate, A/V sync, and latency.",
      "Compare against source for occlusion artifacts, warping, edge halos, and scene-cut behavior."
    ],
    "rtx-video-sdk": [
      "Test multiple source bitrates and resolutions.",
      "Compare enhanced output against source and reference clips.",
      "Validate HDR metadata/display behavior for SDR-to-HDR."
    ],
    "video-codec-sdk": [
      "Run throughput tests at target resolution/FPS.",
      "Validate quality metrics and A/V sync.",
      "Confirm NVENC/NVDEC utilization separately from CUDA/graphics utilization."
    ],
    "nsight-aftermath": [
      "Save capture/trace/crash dump artifacts with exact repro metadata.",
      "Document driver, GPU, OS, API backend, commit, and scene."
    ]
  };
  const metrics = includeMetrics ? metricsFor(technologyId) : [];
  return [...base, ...(extra[technologyId] || []), ...metrics.map((metric) => `Metric: ${metric}`)];
}

function metricsFor(technologyId) {
  const table = {
    "dlss-streamline": ["render FPS and displayed FPS", "frame pacing", "input latency", "GPU frame time", "image quality artifacts"],
    "optical-flow-fruc": ["input FPS", "output FPS", "interpolated frame latency", "dropped frames", "duplicate frames", "A/V sync drift", "NVOFA/CUDA utilization"],
    "rtx-video-sdk": ["playback FPS", "frame latency", "GPU utilization", "quality comparison", "HDR output correctness"],
    "video-codec-sdk": ["encode/decode FPS", "bitrate", "latency", "PSNR", "SSIM", "VMAF", "A/V sync"],
    reflex: ["click-to-photon latency", "render queue latency", "CPU/GPU bound latency delta"],
    "nsight-aftermath": ["GPU trace timings", "shader hotspots", "crash dump repro stability"],
    "rtx-kit": ["VRAM use", "GPU frame time", "asset quality metric", "visual artifact rate"],
    "web-boundary": ["IPC latency", "copy count", "frame delivery jitter", "browser/native memory pressure"]
  };
  return table[technologyId] || [];
}

function expectedArtifacts(technologyId) {
  const table = {
    "dlss-streamline": ["feature support report", "Streamline logs", "debug screenshots", "Nsight capture", "packaging manifest"],
    "optical-flow-fruc": ["input clip or approved frame source", "120 fps output preview", "cadence/latency log", "artifact screenshots", "A/V sync notes"],
    "rtx-video-sdk": ["input clips", "enhanced output clips", "throughput logs", "HDR validation notes"],
    "video-codec-sdk": ["codec support report", "encoded outputs", "quality metrics", "throughput logs"],
    "nsight-aftermath": ["Nsight capture", "GPU trace", "crash dump", "symbol mapping", "repro notes"],
    "web-boundary": ["architecture diagram", "IPC trace", "latency log", "security boundary notes"]
  };
  return table[technologyId] || ["classification report", "compatibility report", "validation log"];
}

function riskList(technologyId) {
  const table = {
    "dlss-streamline": [
      "Incorrect motion vectors, depth, jitter, exposure, or camera state can cause ghosting or instability.",
      "Frame Generation needs correct present-time buffers and pause/menu/resolution-change handling.",
      "Packaging debug or watermarked libraries can break release readiness.",
      "Skipping feature support queries can expose unsupported UI."
    ],
    "unreal-dlss-plugin": [
      "Wrong plugin version for UE version.",
      "Editor-only success but packaged build failure.",
      "Misconfigured project settings or console variables."
    ],
    "unity-hdrp-dlss": [
      "URP/custom SRP feasibility cannot be assumed.",
      "HDRP package or Unity version mismatch.",
      "Camera/dynamic-resolution settings can block expected behavior."
    ],
    "optical-flow-fruc": [
      "Trying to inject native NVIDIA SDK calls into a pure browser YouTube page.",
      "Bypassing DRM, site restrictions, or platform terms while capturing frames.",
      "Scene cuts, occlusions, subtitles, UI overlays, and fast motion can produce interpolation artifacts.",
      "Frame queues can add latency and break A/V sync in live playback."
    ],
    "rtx-video-sdk": [
      "Using DLSS mental model for decoded video enhancement.",
      "HDR output path mismatch.",
      "10-bit/color-space handling errors.",
      "Playback latency exceeding real-time budget."
    ],
    "video-codec-sdk": [
      "Codec/chroma/bit-depth not supported on target GPU.",
      "Unexpected CPU copies break zero-copy claims.",
      "Rate-control or profile mismatch hurts quality or latency.",
      "Confusing NVENC/NVDEC hardware engines with CUDA workloads."
    ],
    reflex: [
      "Incorrect marker placement can make latency data misleading.",
      "Frame Generation without Reflex validation can harm responsiveness."
    ],
    "nsight-aftermath": [
      "Unstable repro makes captures inconclusive.",
      "Missing symbols or shader mapping slows triage.",
      "Capturing the wrong frame mode misses the failure."
    ],
    "rtx-kit": [
      "Component requirements differ by SDK/repo and must be verified.",
      "Quality/performance tradeoffs are content-dependent.",
      "Neural rendering features may require specific driver/API/GPU support."
    ],
    "web-boundary": [
      "Assuming browser access to native NVIDIA SDKs.",
      "Excessive frame copies across IPC/native boundaries.",
      "Unclear trust boundary for user media or proprietary content."
    ]
  };
  return table[technologyId] || ["Insufficient project inspection can produce unsafe implementation advice."];
}

function searchKnownIssues(query, technology) {
  const text = lower(`${query} ${technology || ""}`);
  const issues = [
    {
      technology_id: "dlss-streamline",
      title: "Validate Streamline DLL signatures and use production builds for shipping",
      source_ids: ["streamline-programming-guide"],
      confidence: "high"
    },
    {
      technology_id: "dlss-streamline",
      title: "Frame Generation must be disabled for pause/loading/menus/resolution transitions and non-gameplay frames",
      source_ids: ["streamline-dlssg-guide"],
      confidence: "high"
    },
    {
      technology_id: "dlss-streamline",
      title: "DLSS/Streamline feature support varies by OS, driver, GPU, API, SDK, and settings; query feature state",
      source_ids: ["streamline-programming-guide", "streamline-dlssg-guide"],
      confidence: "high"
    },
    {
      technology_id: "video-codec-sdk",
      title: "Check codec support matrix before planning NVENC/NVDEC codec, bit depth, chroma, and throughput",
      source_ids: ["video-codec-sdk"],
      confidence: "high"
    },
    {
      technology_id: "optical-flow-fruc",
      title: "Video frame insertion/up-conversion routes to Optical Flow SDK / NvOFFRUC, not DLSS Frame Generation",
      source_ids: ["nvidia-optical-flow-sdk", "nvidia-nvofa-fruc-guide"],
      confidence: "high"
    },
    {
      technology_id: "rtx-video-sdk",
      title: "RTX Video SDK is the media enhancement route; DLSS is not the route for arbitrary decoded video playback",
      source_ids: ["rtx-video-sdk", "nvidia-dlss"],
      confidence: "high"
    },
    {
      technology_id: "web-boundary",
      title: "Pure browser apps cannot be assumed to call native NVIDIA SDK APIs",
      source_ids: ["webgpu-explainer"],
      confidence: "high"
    }
  ];
  return issues
    .filter((issue) => {
      const haystack = lower(`${issue.technology_id} ${issue.title} ${issue.source_ids.join(" ")}`);
      return tokenize(text).some((token) => haystack.includes(token));
    })
    .map((issue) => ({ ...issue, sources: sourceRefs(issue.source_ids) }));
}

function probeEnvironment() {
  const result = {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node_platform: process.platform,
    gpu: null,
    nvidia_smi_error: null
  };
  try {
    const output = execFileSync("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"], {
      encoding: "utf8",
      timeout: 3000
    });
    const first = output.trim().split(/\r?\n/)[0];
    const [name, driver] = first.split(",").map((part) => part.trim());
    result.gpu = { name, driver_version: driver };
  } catch (error) {
    result.nvidia_smi_error = errorMessage(error);
  }
  return result;
}

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load registry at ${REGISTRY_PATH}: ${errorMessage(error)}`);
  }
}

async function fetchText(url) {
  const cacheKey = `fetch:${url}`;
  const hit = getCache(cacheKey);
  if (hit) return hit;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/plain,text/markdown,text/html,application/xhtml+xml"
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  setCache(cacheKey, body);
  return body;
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  cache.set(key, { createdAt: Date.now(), value });
}

function sourceRefs(ids) {
  return (ids || [])
    .map((id) => registry.sources.find((source) => source.id === id))
    .filter(Boolean)
    .map((source) => ({
      source_name: source.name,
      source_url: source.url,
      version: source.version || null,
      verified_date: source.verified_date,
      source_kind: source.kind
    }));
}

function findTechnology(value) {
  const needle = lower(value);
  return registry.technologies.find(
    (tech) =>
      lower(tech.id) === needle ||
      lower(tech.canonical_name) === needle ||
      lower(tech.id).includes(needle) ||
      lower(tech.canonical_name).includes(needle)
  );
}

function isAllowedOfficialUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "developer.nvidia.com" ||
      parsed.hostname === "docs.nvidia.com" ||
      parsed.hostname === "github.com" && parsed.pathname.startsWith("/NVIDIA-RTX/") ||
      parsed.hostname === "raw.githubusercontent.com" && parsed.pathname.startsWith("/NVIDIA-RTX/") ||
      parsed.hostname === "gpuweb.github.io"
    );
  } catch {
    return false;
  }
}

function toFetchUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com" && parsed.pathname.startsWith("/NVIDIA-RTX/") && parsed.pathname.includes("/blob/")) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const [owner, repo, , branch, ...pathParts] = parts;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathParts.join("/")}`;
    }
  } catch {
    return url;
  }
  return url;
}

function htmlToText(value) {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function snippetFor(text, tokens) {
  const normalized = htmlToText(text);
  const lowerText = lower(normalized);
  let index = -1;
  for (const token of tokens) {
    index = lowerText.indexOf(token);
    if (index >= 0) break;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - 240);
  const end = Math.min(normalized.length, index + 520);
  return normalized.slice(start, end);
}

function isInterestingForText(file) {
  return (
    /^(CMakeLists\.txt|Makefile|Dockerfile|Pipfile)$/i.test(file.name) ||
    /\.(json|md|txt|toml|ya?ml|cmake|csproj|vcxproj|sln|uproject|uplugin|cs|cpp|cc|cxx|h|hpp|py|rs|ts|tsx|js|jsx|shader|hlsl|glsl|slang|ini|cfg|xml|props)$/i.test(
      file.name
    )
  );
}

function safeRead(path, maxBytes) {
  try {
    const stat = statSync(path);
    if (stat.size > maxBytes) return readFileSync(path, "utf8").slice(0, maxBytes);
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function tryVersionNear(path) {
  const dir = dirname(path);
  for (const candidate of ["README.md", "version.txt", "VERSION", "changelog.txt"]) {
    const full = join(dir, candidate);
    if (!existsSync(full)) continue;
    const text = safeRead(full, 30000);
    const match = text.match(/\b(?:version|sdk)\s*[:\-]?\s*v?(\d+\.\d+(?:\.\d+)?)/i) || text.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
    if (match) return match[1];
  }
  return null;
}

function readMessage() {
  if (!inputBuffer.length) return null;
  const asText = inputBuffer.toString("utf8");
  if (asText.startsWith("Content-Length:")) {
    const headerEnd = asText.indexOf("\r\n\r\n");
    const altHeaderEnd = asText.indexOf("\n\n");
    const boundary = headerEnd >= 0 ? headerEnd : altHeaderEnd;
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    if (boundary < 0) return null;
    const header = asText.slice(0, boundary);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("Invalid MCP message: missing Content-Length");
    const length = Number(match[1]);
    const bodyStart = Buffer.byteLength(asText.slice(0, boundary + separatorLength), "utf8");
    if (inputBuffer.length < bodyStart + length) return null;
    const body = inputBuffer.slice(bodyStart, bodyStart + length).toString("utf8");
    inputBuffer = inputBuffer.slice(bodyStart + length);
    return JSON.parse(body);
  }

  const newline = asText.indexOf("\n");
  if (newline < 0) return null;
  const line = asText.slice(0, newline).trim();
  inputBuffer = Buffer.from(asText.slice(newline + 1), "utf8");
  return line ? JSON.parse(line) : null;
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

function sendMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function resolveInputPath(value) {
  if (!value) return process.cwd();
  const expanded = String(value).replace(/^~(?=$|[\\/])/, os.homedir());
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function relativePath(root, full) {
  const relative = full.startsWith(root) ? full.slice(root.length).replace(new RegExp(`^\\${sep}`), "") : full;
  return relative || ".";
}

function normalizeStringList(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : String(input).split(/[;,]/);
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function tokenize(input) {
  return lower(input)
    .split(/[^a-z0-9_.:+-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function clampInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function matchesAny(text, needles) {
  return needles.some((needle) => text.includes(lower(needle)));
}

function confidenceFromScore(score) {
  if (score >= 10) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function dedupeRoutes(routes) {
  const seen = new Set();
  const output = [];
  for (const route of routes) {
    if (seen.has(route.technology_id)) continue;
    seen.add(route.technology_id);
    output.push(route);
  }
  return output;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

