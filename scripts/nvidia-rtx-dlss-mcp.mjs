#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { buildHeaderGrounding, inspectNvidiaHeaders } from "./lib/header-inspector.mjs";
import { auditTechnologyRegistry } from "./lib/registry-audit.mjs";
import { toolContractSummaries } from "./lib/tool-contracts.mjs";

const VERSION = "1.0.0-rc.1";
const PROTOCOL_VERSION = "2024-11-05";
const CACHE_TTL_MS = Number(process.env.NVIDIA_RTX_DLSS_CACHE_TTL_MS || 30 * 60 * 1000);
const USER_AGENT = `nvidia-rtx-dlss-codex-plugin/${VERSION}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const REGISTRY_PATH = join(PLUGIN_ROOT, "data", "nvidia-technology-registry.json");
const IMPLEMENTATION_CONTRACTS_PATH = join(PLUGIN_ROOT, "data", "nvidia-implementation-contracts.json");
const registry = loadRegistry();
const implementationContracts = loadImplementationContracts();
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
    name: "nvidia_implementation_contracts",
    description:
      "Evaluate strict pre-implementation contracts for real NVIDIA development targets. Reports satisfied, blocked, or rejected states without editing files.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Repository or project path to inspect." },
        sdk_roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Local SDK/header roots. Missing SDKs are reported as blockers, not tool failures."
        },
        contract_ids: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional contract id(s). Defaults to all implementation contracts."
        },
        include_evidence: { type: "boolean", default: true },
        max_files: { type: "number", default: 8000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "nvidia_implementation_readiness_report",
    description:
      "Combine project classification, SDK/header discovery, implementation contracts, patch planning, validation harness planning, license guard checks, and compile/runtime evidence into one ready/blocked/unsafe/verified implementation-readiness report.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The NVIDIA implementation goal to evaluate." },
        project_path: { type: "string", description: "Repository or project path to inspect." },
        technology: { type: "string", description: "Optional forced NVIDIA technology route." },
        contract_ids: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional implementation contract id(s). If omitted, the report selects the most relevant contract from the route."
        },
        sdk_roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Local SDK/header roots. Missing SDKs are reported as blockers, not tool failures."
        },
        target_workflow: {
          type: "string",
          enum: ["auto", "unreal", "unity-hdrp", "custom-cpp-renderer", "ffmpeg-gstreamer", "python-video", "web-electron"],
          default: "auto"
        },
        action: {
          type: "string",
          description: "Optional action for license/binary boundary checks. Defaults to local report and patch planning."
        },
        files: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional file paths involved in the proposed action for license/binary checks."
        },
        destination: { type: "string", description: "Optional upload/package destination for license/binary checks." },
        patch_approved: { type: "boolean", default: false, description: "Set true only when the user already approved the patch plan." },
        implementation_present: { type: "boolean", default: false, description: "Set true when implementation code already exists and needs validation." },
        validation_required: { type: "boolean", default: false, description: "Force validation_required state when the user wants proof before further edits." },
        validation_mode: {
          type: "string",
          enum: ["sample-launch-check", "frame-capture-checklist", "codec-throughput", "quality-compare-plan"],
          default: "sample-launch-check"
        },
        sample_path: { type: "string" },
        command: { type: "string" },
        compile_evidence_paths: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Existing local compile/build evidence files. Required for implementation_verified."
        },
        runtime_evidence_paths: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Existing local runtime/test evidence files. Required for implementation_verified."
        },
        validation_artifact_paths: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Existing local validation artifact files. Required for implementation_verified."
        },
        include_common_sdk_roots: { type: "boolean", default: false },
        include_evidence: { type: "boolean", default: true },
        max_files: { type: "number", default: 8000 }
      },
      required: ["goal", "project_path"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_unreal_dlss_validator",
    description:
      "Inspect an Unreal project for NVIDIA DLSS/Streamline plugin readiness, engine compatibility, config state, packaging risks, logs, and safe patch planning. Does not download plugins or copy NVIDIA binaries.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Unreal project root containing a .uproject file." },
        include_patch_plan: { type: "boolean", default: true },
        write_files: {
          type: "boolean",
          default: false,
          description: "When false, return planned validation docs/scripts only. When true, create new validation artifacts only after approval_token is supplied."
        },
        output_dir: {
          type: "string",
          description: "Optional output directory for generated validation docs/scripts. Defaults to <project_path>/_nvidia_unreal_dlss_validation when write_files is true."
        },
        approval_token: {
          type: "string",
          description: "Required exact value APPROVED_UNREAL_DLSS_VALIDATION when write_files is true."
        },
        max_files: { type: "number", default: 8000 },
        include_evidence: { type: "boolean", default: true }
      },
      required: ["project_path"],
      additionalProperties: false
    }
  },
  {
    name: "nvidia_unity_hdrp_validator",
    description:
      "Inspect a Unity project for HDRP DLSS readiness, URP/custom SRP routing, project settings, camera/render-pipeline evidence, Reflex readiness, and safe patch planning. Does not fabricate profiler/FPS data.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Unity project root containing ProjectSettings and Packages." },
        include_patch_plan: { type: "boolean", default: true },
        write_files: {
          type: "boolean",
          default: false,
          description: "When false, return planned validation docs/scripts only. When true, create new validation artifacts only after approval_token is supplied."
        },
        output_dir: {
          type: "string",
          description: "Optional output directory for generated validation docs/scripts. Defaults to <project_path>/_nvidia_unity_hdrp_validation when write_files is true."
        },
        approval_token: {
          type: "string",
          description: "Required exact value APPROVED_UNITY_HDRP_VALIDATION when write_files is true."
        },
        max_files: { type: "number", default: 8000 },
        include_evidence: { type: "boolean", default: true }
      },
      required: ["project_path"],
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
        sdk_roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional local SDK/header roots. Without detected headers, API-specific output is marked template-only."
        },
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
        sdk_roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional local SDK/header roots for header-grounded planning notes."
        },
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
            "d3d12-streamline-dlss-sr-kit",
            "d3d12-dxr-raytracing-starter-kit",
            "nrd-denoiser-bridge-kit",
            "video-codec-native-pipeline-kit",
            "video-codec-sample-adaptation",
            "rtx-video-native-pipeline-kit",
            "rtx-video-pipeline-skeleton",
            "nsight-marker-insertion",
            "reflex-marker-scaffold"
          ],
          default: "auto"
        },
        sdk_root: { type: "string", description: "Optional user-provided SDK root path. This tool never downloads SDKs." },
        sdk_roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional local SDK/header roots. Use when multiple SDK roots are involved."
        },
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
    name: "nvidia_sdk_header_grounding",
    description:
      "Return header-grounding evidence for a NVIDIA SDK route: detected root/version, relevant headers, observed symbols, missing required symbols, confidence, and real-API guidance gate.",
    inputSchema: {
      type: "object",
      properties: {
        technology: { type: "string", description: "Technology or workflow, such as dlss-streamline, reflex, nrd, rtx-video-sdk, video-codec-sdk, or streamline-init-scaffold." },
        roots: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Local SDK/header roots to scan. Defaults to current working directory."
        },
        required_symbols: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional required symbols override. Defaults to the selected technology profile."
        },
        max_files: { type: "number", default: 12000 },
        include_snippets: { type: "boolean", default: false }
      },
      required: ["technology"],
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
  nvidia_implementation_contracts: handleImplementationContracts,
  nvidia_implementation_readiness_report: handleImplementationReadinessReport,
  nvidia_unreal_dlss_validator: handleUnrealDlssValidator,
  nvidia_unity_hdrp_validator: handleUnityHdrpValidator,
  nvidia_integration_plan: handleIntegrationPlan,
  nvidia_code_guidance: handleCodeGuidance,
  nvidia_patch_plan: handlePatchPlan,
  nvidia_assisted_implementation: handleAssistedImplementation,
  nvidia_environment_probe: handleEnvironmentProbe,
  nvidia_validation_harness: handleValidationHarness,
  nvidia_log_analyzer: handleLogAnalyzer,
  nvidia_quality_compare: handleQualityCompare,
  nvidia_sdk_header_grounding: handleSdkHeaderGrounding,
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
        implementation_contracts: implementationContracts.contracts.map((item) => item.id),
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

async function handleImplementationContracts(args) {
  const selectedContracts = selectImplementationContracts(args.contract_ids);
  const projectRoot = args.project_path ? resolveInputPath(args.project_path) : null;
  const inventory = projectRoot && existsSync(projectRoot)
    ? inventoryProject(projectRoot, {
        maxFiles: clampInt(args.max_files, 8000, 100, 50000),
        includeEvidence: args.include_evidence !== false
      })
    : null;
  const project = inventory ? classifyInventory(inventory) : null;
  const sdkRoots = implementationSdkRoots(args.sdk_roots, projectRoot);
  const headerReport = sdkRoots.length
    ? inspectNvidiaHeaders({
        roots: sdkRoots,
        max_files: clampInt(args.max_files, 12000, 100, 100000),
        include_snippets: false
      })
    : {
        scanned_roots: [],
        scanned_files: 0,
        findings: [],
        summary: {},
        warnings: ["No SDK roots or project path were available for header inspection."]
      };

  const results = selectedContracts.map((contract) =>
    evaluateImplementationContract(contract, {
      projectRoot,
      inventory,
      project,
      sdkRoots,
      headerReport
    })
  );

  return {
    tool: "nvidia_implementation_contracts",
    phase: "pre-implementation contract gating",
    edit_policy: "No repository files are edited. This tool only evaluates readiness gates before future implementation kits.",
    contract_schema_version: implementationContracts.schema_version,
    project_path: projectRoot,
    project_classification: project || {
      state: "needs_inspection",
      note: "No project_path was provided or the path did not exist."
    },
    sdk_header_scan: {
      scanned_roots: headerReport.scanned_roots,
      scanned_files: headerReport.scanned_files,
      summary: headerReport.summary,
      warnings: headerReport.warnings
    },
    summary: summarizeContractResults(results),
    contracts: results,
    safety_notes: [
      "Satisfied contracts are not approval to edit; they mean the project and SDK evidence are sufficient for a future patch plan.",
      "Patch plan approval, compile/test execution, validation artifacts, and licensing checks remain separate gates.",
      "Missing SDK/header evidence is a blocker state, not a tool failure."
    ]
  };
}

async function handleImplementationReadinessReport(args) {
  const projectRoot = resolveInputPath(args.project_path);
  if (!existsSync(projectRoot)) throw new McpError(-32602, `Project path does not exist: ${projectRoot}`);

  const maxFiles = clampInt(args.max_files, 8000, 100, 50000);
  const inventory = inventoryProject(projectRoot, {
    maxFiles,
    includeEvidence: args.include_evidence !== false
  });
  const project = classifyInventory(inventory);
  const route = args.technology ? routeFromTechnology(args.technology) : routeGoal(args.goal, "", project);
  const primaryRoute = route.recommended[0];
  if (!primaryRoute) throw new McpError(-32602, "No NVIDIA route could be selected from the provided goal.");

  const workflow = normalizePhase2Workflow(args.target_workflow, args.goal, project, primaryRoute);
  const sdkRoots = implementationReadinessSdkRoots(args, projectRoot);
  const sdkScan = buildImplementationReadinessSdkScan(args, sdkRoots, maxFiles);
  const headerInspector = inspectNvidiaHeaders({
    roots: sdkRoots,
    max_files: maxFiles,
    include_snippets: false
  });
  const headerGrounding = buildHeaderGrounding({
    roots: sdkRoots,
    technology: headerTechnologyForWorkflow(workflow, primaryRoute.technology_id),
    max_files: maxFiles,
    include_snippets: false
  });

  const contractIds = implementationReadinessContractIds(args.contract_ids, primaryRoute, workflow, args.goal);
  const selectedContracts = selectImplementationContracts(contractIds);
  const contractResults = selectedContracts.map((contract) =>
    evaluateImplementationContract(contract, {
      projectRoot,
      inventory,
      project,
      sdkRoots,
      headerReport: headerInspector
    })
  );

  const context = buildPhase2Context({
    ...args,
    project_path: projectRoot,
    sdk_roots: sdkRoots,
    target_workflow: workflow,
    include_evidence: args.include_evidence,
    max_files: maxFiles
  });
  const workflowPlan = phase2WorkflowPlan(context);
  const selectedPatchSteps = context.unrealValidation?.safe_patch_plan?.steps || context.unityHdrpValidation?.safe_patch_plan?.steps || workflowPlan.patch_plan;
  const patchPlan = {
    phase: "Phase 2 repo-aware patch planning",
    edit_policy: "Plan only. This report does not modify target files.",
    approval_gate: args.patch_approved
      ? "patch_approved=true was supplied by the caller. Validation is still required before verified implementation claims."
      : "Patch work still requires explicit user approval before edits.",
    files_likely_affected: workflowPlan.likely_files,
    steps: tunePatchPlanForRisk(selectedPatchSteps, "low"),
    risk_analysis: {
      risks: workflowPlan.risks,
      regression_hotspots: workflowPlan.regression_hotspots
    },
    rollback_plan: workflowPlan.rollback_plan
  };

  const validationHarness = buildValidationHarness({
    technology: findTechnology(primaryRoute.technology_id),
    technologyInput: primaryRoute.technology_id,
    workflow,
    projectRoot,
    samplePath: args.sample_path ? resolveInputPath(args.sample_path) : null,
    command: args.command,
    mode: args.validation_mode || "sample-launch-check"
  });
  const licenseGuard = buildLicenseGuardReport({
    action: args.action || "generate local implementation readiness report and patch plan",
    technology: primaryRoute.technology_id,
    files: args.files,
    destination: args.destination
  });
  const verification = evaluateImplementationVerification(args);
  const state = determineImplementationReadinessState({
    project,
    inventory,
    contractResults,
    licenseGuard,
    verification,
    args
  });

  return {
    tool: "nvidia_implementation_readiness_report",
    phase: "single structured implementation-readiness report",
    output_state: state.state,
    state_reason: state.reason,
    state_priority: [
      "unsafe_license_or_binary_boundary",
      "blocked_unsupported_project",
      "blocked_missing_sdk",
      "blocked_missing_renderer_contract",
      "implementation_verified",
      "validation_required",
      "ready_to_patch"
    ],
    edit_policy: "No repository files are edited. This report coordinates existing gates and returns a patch/validation plan only.",
    project_classifier: {
      root: projectRoot,
      scanned_files: inventory.scannedFiles,
      classification: project,
      evidence: args.include_evidence === false ? undefined : inventory.evidence?.slice(0, 50)
    },
    sdk_locator: sdkScan,
    header_inspector: {
      scanned_roots: headerInspector.scanned_roots,
      scanned_files: headerInspector.scanned_files,
      summary: headerInspector.summary,
      warnings: headerInspector.warnings
    },
    header_grounding: headerGrounding,
    implementation_contract_checker: {
      contract_ids: contractIds,
      summary: summarizeContractResults(contractResults),
      contracts: contractResults
    },
    patch_plan: patchPlan,
    validation_harness: {
      mode: args.validation_mode || "sample-launch-check",
      execution_state: validationHarness.execution_state,
      blocked_reasons: validationHarness.blocked_reasons,
      command_plan: validationHarness.command_plan,
      required_tools: validationHarness.required_tools,
      expected_artifacts: validationHarness.expected_artifacts,
      pass_fail_criteria: validationHarness.pass_fail_criteria,
      safety_notes: validationHarness.safety_notes,
      rollback_notes: validationHarness.rollback_notes
    },
    license_guard: licenseGuard,
    verification,
    blockers: state.blockers,
    next_actions: implementationReadinessNextActions(state.state, {
      contractResults,
      validationHarness,
      verification,
      licenseGuard
    }),
    non_claims: [
      "This report does not claim NVIDIA implementation is verified unless compile evidence, runtime evidence, and validation artifacts are all present and pass deterministic checks.",
      "This report does not download SDKs, copy NVIDIA binaries, upload artifacts, or edit project files.",
      "Ready to patch means the repo and local evidence are sufficient for an approved patch attempt; it is not runtime proof."
    ],
    sources: sourceRefs([
      ...(findTechnology(primaryRoute.technology_id)?.official_sources || []),
      ...contractResults.flatMap((contract) => contract.sources?.map((source) => source.id) || [])
    ])
  };
}

async function handleUnrealDlssValidator(args) {
  const projectRoot = resolveInputPath(args.project_path);
  if (!existsSync(projectRoot)) throw new McpError(-32602, `Project path does not exist: ${projectRoot}`);
  const inventory = inventoryProject(projectRoot, {
    maxFiles: clampInt(args.max_files, 8000, 100, 50000),
    includeEvidence: args.include_evidence !== false
  });
  const project = classifyInventory(inventory);
  const validation = buildUnrealDlssValidation(projectRoot, inventory, project, { includePatchPlan: args.include_patch_plan !== false });
  const writtenFiles = writeUnrealValidationArtifacts(validation.artifacts, projectRoot, args);

  return {
    tool: "nvidia_unreal_dlss_validator",
    phase: "first real engine workflow",
    edit_policy:
      "No Unreal project files are modified. This tool only inspects the repo, returns a patch plan, and optionally creates separate validation docs/scripts after explicit approval.",
    artifact_policy:
      args.write_files === true
        ? "write_files was requested and approval_token was accepted before creating validation artifacts."
        : "No files were written. To create validation artifacts, call again with write_files=true and approval_token=APPROVED_UNREAL_DLSS_VALIDATION.",
    classification: project,
    validation_report: validation.validation_report,
    safe_patch_plan: validation.safe_patch_plan,
    candidate_artifacts: validation.artifacts,
    written_files: writtenFiles,
    safety_boundaries: [
      "No Unreal plugin download.",
      "No NVIDIA binary copy.",
      "No .uproject, .uplugin, Config/*.ini, or packaging file writes without a separate explicit implementation approval.",
      "Validation docs/scripts are create-only artifacts and are never overwrites."
    ],
    sources: sourceRefs(["nvidia-dlss", "streamline-releases", "streamline-programming-guide"])
  };
}

async function handleUnityHdrpValidator(args) {
  const projectRoot = resolveInputPath(args.project_path);
  if (!existsSync(projectRoot)) throw new McpError(-32602, `Project path does not exist: ${projectRoot}`);
  const inventory = inventoryProject(projectRoot, {
    maxFiles: clampInt(args.max_files, 8000, 100, 50000),
    includeEvidence: args.include_evidence !== false
  });
  const project = classifyInventory(inventory);
  const validation = buildUnityHdrpValidation(projectRoot, inventory, project, { includePatchPlan: args.include_patch_plan !== false });
  const writtenFiles = writeUnityValidationArtifacts(validation.artifacts, projectRoot, args);

  return {
    tool: "nvidia_unity_hdrp_validator",
    phase: "Unity HDRP DLSS readiness workflow",
    edit_policy:
      "No Unity project files are modified. This tool inspects ProjectSettings, Packages, assets, and scripts, returns a patch plan, and optionally creates separate validation docs/scripts after explicit approval.",
    artifact_policy:
      args.write_files === true
        ? "write_files was requested and approval_token was accepted before creating validation artifacts."
        : "No files were written. To create validation artifacts, call again with write_files=true and approval_token=APPROVED_UNITY_HDRP_VALIDATION.",
    classification: project,
    validation_report: validation.validation_report,
    safe_patch_plan: validation.safe_patch_plan,
    candidate_artifacts: validation.artifacts,
    written_files: writtenFiles,
    safety_boundaries: [
      "No fake FPS, frame-time, or profiler data.",
      "No runtime success claim without a runnable Unity validation path and captured logs/results.",
      "No ProjectSettings, Packages/manifest.json, scene, asset, or script edits without separate explicit implementation approval.",
      "Validation docs/scripts are create-only artifacts and are never overwrites."
    ],
    sources: sourceRefs(["nvidia-dlss", "nvidia-reflex"])
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
  const apiGate = apiGenerationGate(context.headerGrounding, true);

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
    code_output_mode: apiGate.code_output_mode,
    api_generation_gate: apiGate,
    header_grounding: context.headerGrounding,
    unreal_validation_report: context.unrealValidation?.validation_report,
    unity_hdrp_validation_report: context.unityHdrpValidation?.validation_report,
    no_edit_diagnosis: noEditDiagnosis(context, workflow),
    code_guidance: headerGroundedGuidance(workflow.code_guidance, apiGate, context.headerGrounding),
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
  const apiGate = apiGenerationGate(context.headerGrounding, false);
  const selectedPatchPlan = context.unrealValidation?.safe_patch_plan?.steps || context.unityHdrpValidation?.safe_patch_plan?.steps || workflow.patch_plan;

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
    code_output_mode: apiGate.code_output_mode,
    api_generation_gate: apiGate,
    header_grounding: context.headerGrounding,
    unreal_validation_report: context.unrealValidation?.validation_report,
    unity_hdrp_validation_report: context.unityHdrpValidation?.validation_report,
    no_edit_diagnosis: noEditDiagnosis(context, workflow),
    files_likely_affected: workflow.likely_files,
    patch_plan: tunePatchPlanForRisk(selectedPatchPlan, riskTolerance),
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
    code_output_mode: implementation.code_output_mode,
    api_generation_gate: implementation.api_generation_gate,
    header_grounding: implementation.header_grounding,
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

async function handleSdkHeaderGrounding(args) {
  const roots = normalizeStringList(args.roots).map(resolveInputPath);
  const result = buildHeaderGrounding({
    roots: roots.length ? roots : [process.cwd()],
    technology: args.technology,
    required_symbols: normalizeStringList(args.required_symbols),
    max_files: args.max_files,
    include_snippets: args.include_snippets === true
  });
  return {
    tool: "nvidia_sdk_header_grounding",
    phase: "header-grounded generation",
    source_policy: "Real SDK API guidance is allowed only when required symbols are observed in local headers.",
    api_generation_gate: apiGenerationGate(result, true),
    ...result,
    sources: sourceRefs(["streamline-programming-guide", "streamline-dlssg-guide", "video-codec-sdk", "rtx-video-sdk", "nvidia-reflex", "rtx-kit"])
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
  return {
    tool: "nvidia_license_guard",
    ...buildLicenseGuardReport(args)
  };
}

function buildLicenseGuardReport(args) {
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

function implementationReadinessSdkRoots(args, projectRoot) {
  const roots = new Set();
  for (const value of normalizeStringList(args.sdk_roots)) roots.add(resolveInputPath(value));
  if (projectRoot) roots.add(projectRoot);
  return [...roots].filter((root) => root && existsSync(root));
}

function buildImplementationReadinessSdkScan(args, sdkRoots, maxFiles) {
  const roots = new Set(sdkRoots);
  if (args.include_common_sdk_roots === true) {
    for (const root of buildSdkRoots({ roots: [], include_common_roots: true })) {
      if (root) roots.add(root);
    }
  }

  const scanned = [];
  const found = [];
  for (const root of [...roots]) {
    if (!root || !existsSync(root)) continue;
    scanned.push(root);
    found.push(...scanForSdks(root, maxFiles));
  }
  return {
    tool: "nvidia_sdk_locator",
    scanned_roots: [...new Set(scanned)],
    found: dedupeSdkFinds(found),
    include_common_sdk_roots: args.include_common_sdk_roots === true,
    missing_is_not_failure: true,
    notes: [
      "SDK discovery is local-only.",
      "Missing SDK/header evidence becomes a report state, not a tool crash.",
      "Pass sdk_roots when NVIDIA SDKs are installed outside the project."
    ]
  };
}

function implementationReadinessContractIds(input, primaryRoute, workflow, goal) {
  const explicit = normalizeStringList(input);
  if (explicit.length) return explicit;
  const text = lower(`${goal}\n${workflow}\n${primaryRoute?.technology_id || ""}`);
  const technologyId = primaryRoute?.technology_id;
  if (technologyId === "video-codec-sdk" || matchesAny(text, ["nvenc", "nvdec", "ffmpeg", "gstreamer", "pynvvideocodec"])) return ["video-codec-nvenc-nvdec-pipeline"];
  if (technologyId === "rtx-video-sdk" || matchesAny(text, ["rtx video", "video enhancement", "super resolution", "sdr-to-hdr"])) return ["rtx-video-enhancement-pipeline"];
  if (technologyId === "rtx-kit" && matchesAny(text, ["nrd", "denoiser", "reblur", "relax", "sigma"])) return ["nrd-denoiser-readiness"];
  if (technologyId === "rtx-kit" || matchesAny(text, ["dxr", "ray tracing", "ray-traced", "shadows", "reflections"])) return ["d3d12-dxr-raytracing-base"];
  if (technologyId === "dlss-streamline" && matchesAny(text, ["frame generation", "multi frame", "mfg", "fg"])) return ["streamline-dlss-fg-mfg-readiness"];
  if (technologyId === "dlss-streamline" || workflow === "custom-cpp-renderer") return ["streamline-dlss-sr-dlaa"];
  return implementationContracts.contracts.map((contract) => contract.id);
}

function determineImplementationReadinessState({ project, inventory, contractResults, licenseGuard, verification, args }) {
  const blockers = [];
  const unsafe = licenseGuardHasUnsafeBoundary(licenseGuard);
  if (unsafe) {
    blockers.push(...licenseGuard.decisions.filter((decision) => decision.decision !== "plan_only_ok").map((decision) => decision.reason));
    return {
      state: "unsafe_license_or_binary_boundary",
      reason: "The proposed action crosses a download, upload, packaging, redistribution, binary, or destination boundary that needs explicit license/safety approval.",
      blockers: [...new Set(blockers)]
    };
  }

  const unsupported = contractResults.some((contract) => contract.state === "rejected_unsupported_project") || isBrowserOnlyProject(project, inventory);
  if (unsupported) {
    blockers.push(...contractResults.flatMap((contract) => contract.state === "rejected_unsupported_project" ? contract.blockers : []));
    if (isBrowserOnlyProject(project, inventory)) blockers.push("Pure browser/browser-video project cannot use native NVIDIA SDKs directly.");
    return {
      state: "blocked_unsupported_project",
      reason: "The inspected project is not a supported native/engine/media route for the requested NVIDIA implementation target.",
      blockers: [...new Set(blockers)]
    };
  }

  if (contractResults.some((contract) => contract.state === "blocked_missing_sdk")) {
    blockers.push(...contractResults.flatMap((contract) => contract.state === "blocked_missing_sdk" ? contract.blockers : []));
    return {
      state: "blocked_missing_sdk",
      reason: "The project may be structurally compatible, but required local NVIDIA SDK/header evidence is missing.",
      blockers: [...new Set(blockers)]
    };
  }

  const missingRendererContract = !contractResults.length || contractResults.some((contract) =>
    ["blocked_missing_project_contract", "needs_project_inspection"].includes(contract.state)
  );
  if (missingRendererContract) {
    blockers.push(...contractResults.flatMap((contract) => ["blocked_missing_project_contract", "needs_project_inspection"].includes(contract.state) ? contract.blockers : []));
    if (!contractResults.length) blockers.push("No implementation contract was selected or evaluated.");
    return {
      state: "blocked_missing_renderer_contract",
      reason: "Required project/API/input/build evidence is missing for real NVIDIA implementation work.",
      blockers: [...new Set(blockers)]
    };
  }

  if (verification.implementation_verified) {
    return {
      state: "implementation_verified",
      reason: "Compile evidence, runtime evidence, and validation artifact evidence were all provided and passed deterministic evidence checks.",
      blockers: []
    };
  }

  if (args.patch_approved === true || args.implementation_present === true || args.validation_required === true || verification.any_evidence_supplied) {
    blockers.push(...verification.missing_or_failed_evidence);
    return {
      state: "validation_required",
      reason: "The project is structurally ready, but implementation readiness cannot be verified until compile/runtime validation artifacts are produced.",
      blockers: [...new Set(blockers)]
    };
  }

  return {
    state: "ready_to_patch",
    reason: "Project, SDK/header, contract, patch-plan, and license-boundary gates are sufficient to ask for explicit patch approval.",
    blockers: []
  };
}

function licenseGuardHasUnsafeBoundary(licenseGuard) {
  return (licenseGuard.decisions || []).some((decision) =>
    ["ask_user_first", "license_review_required", "explicit_destination_required"].includes(decision.decision)
  );
}

function evaluateImplementationVerification(args) {
  const compile = evaluateEvidenceGroup("compile", args.compile_evidence_paths, /build succeeded|compile success|compilation succeeded|0 errors|tests passed|passed|success/i);
  const runtime = evaluateEvidenceGroup("runtime", args.runtime_evidence_paths, /runtime validation passed|sample launch passed|feature support passed|tests passed|passed|success/i);
  const validation = evaluateEvidenceGroup("validation", args.validation_artifact_paths, /validation passed|validation artifact|psnr|ssim|vmaf|nsight|throughput|capture|passed|success/i);
  const groups = [compile, runtime, validation];
  const missingOrFailed = groups.flatMap((group) => group.status === "pass" ? [] : group.messages);
  return {
    implementation_verified: groups.every((group) => group.status === "pass"),
    any_evidence_supplied: groups.some((group) => group.paths.length > 0),
    compile_evidence: compile,
    runtime_evidence: runtime,
    validation_artifacts: validation,
    missing_or_failed_evidence: missingOrFailed,
    proof_rule: "implementation_verified requires at least one existing compile evidence file, one existing runtime evidence file, and one existing validation artifact file with deterministic success markers."
  };
}

function evaluateEvidenceGroup(kind, input, successPattern) {
  const paths = normalizeStringList(input).map(resolveInputPath);
  if (!paths.length) {
    return {
      kind,
      status: "missing",
      paths: [],
      messages: [`Missing ${kind} evidence path.`]
    };
  }
  const evidence = paths.map((path) => {
    if (!existsSync(path)) {
      return { path, exists: false, matched_success_marker: false, message: `${kind} evidence file does not exist: ${path}` };
    }
    const text = safeRead(path, 200000);
    return {
      path,
      exists: true,
      bytes_read: text.length,
      matched_success_marker: successPattern.test(text),
      message: successPattern.test(text) ? `${kind} evidence passed deterministic marker check.` : `${kind} evidence exists but no success marker was found.`
    };
  });
  const failed = evidence.filter((item) => !item.exists || !item.matched_success_marker);
  return {
    kind,
    status: failed.length ? "fail" : "pass",
    paths,
    evidence,
    messages: failed.map((item) => item.message)
  };
}

function implementationReadinessNextActions(state, context) {
  const actions = {
    ready_to_patch: [
      "Ask the user to approve the patch plan before generating or editing implementation files.",
      "Keep SDK paths user-provided and license-approved.",
      "Prepare compile and runtime validation commands before merging changes."
    ],
    blocked_missing_sdk: [
      "Ask the user for the local NVIDIA SDK/header root that matches the selected technology.",
      "Re-run the report with sdk_roots set to the local SDK path.",
      "Do not generate real SDK API calls until header grounding passes."
    ],
    blocked_missing_renderer_contract: [
      "Inspect or add the missing renderer/media contract inputs before implementation.",
      "Re-run implementation contracts after the repo exposes required resources, API route, build path, and validation hooks.",
      "Keep output template-only until the contract passes."
    ],
    blocked_unsupported_project: [
      "Choose a supported native, engine, media, Electron/native-helper, or server-side route.",
      "Do not claim browser-only access to native NVIDIA SDKs.",
      "Re-run the report after the architecture boundary is explicit."
    ],
    unsafe_license_or_binary_boundary: [
      "Stop before downloading, copying, packaging, redistributing, or uploading NVIDIA/user artifacts.",
      "Get explicit user approval and review NVIDIA SDK/license terms for the exact files and destination.",
      "Prefer local inspection and user-provided SDK paths."
    ],
    validation_required: [
      "Run the compile/build command from the contract or project build system.",
      "Run the validation harness with a real command/sample path.",
      "Attach compile evidence, runtime evidence, and validation artifact paths before asking for verified status."
    ],
    implementation_verified: [
      "Keep the compile/runtime/validation artifacts with the change record.",
      "Review remaining license/package boundaries before release.",
      "Do not generalize verification beyond the tested GPU, driver, SDK, sample, and project configuration."
    ]
  };
  return actions[state] || [
    "Inspect report blockers and re-run after missing evidence is supplied."
  ];
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
      add("content_path", "NVENC encode path", file, snippetFor(text, tokenize("nvenc encode codec pixel format bit depth")));
    }
    if (/cuvid|nvcuvid|NVDEC|CUVID/i.test(text)) {
      existingNvidia.add("NVDEC");
      bump("video_pipeline", 6);
      contentPaths.add("video_encode_decode");
      add("content_path", "NVDEC decode path", file, snippetFor(text, tokenize("nvdec cuvid decode codec pixel format bit depth")));
    }
    if (/PyNvVideoCodec|pynvvideocodec/i.test(text)) {
      existingNvidia.add("PyNvVideoCodec");
      bump("python_video", 7);
      contentPaths.add("video_encode_decode");
      add("content_path", "PyNvVideoCodec path", file, snippetFor(text, tokenize("PyNvVideoCodec encode decode gpu frames")));
    }
    if (/RTXVideo|RTX Video|rtxvsr|VSR|video super resolution|ArtifactReduction|artifact reduction|SdrToHdr|SDR-to-HDR/i.test(text) || /RTXVideo|rtx.*video/i.test(rel)) {
      existingNvidia.add("RTX Video SDK");
      bump("video_pipeline", 7);
      contentPaths.add("media_playback");
      add("content_path", "RTX Video/media enhancement", file, snippetFor(text, tokenize("RTXVideo video frame super resolution artifact reduction SDR HDR")));
    }
    if (/media player|playback enhancement|decoded frame|video frame|frame surface|output surface|display path/i.test(text)) {
      bump("video_pipeline", 4);
      contentPaths.add("media_playback");
      add("content_path", "Media playback frame path", file, snippetFor(text, tokenize("media player decoded frame video frame output surface display path")));
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
      add("content_path", "FFmpeg/libav codec pipeline", file, snippetFor(text, tokenize("ffmpeg libav codec nvenc nvdec hwaccel")));
    }
    if (/gstreamer|gst_element|gst-launch|nvh264enc|nvh265enc|nvav1enc|nvh264dec|nvh265dec/i.test(text)) {
      bump("gstreamer", 5);
      contentPaths.add("video_encode_decode");
      add("content_path", "GStreamer codec pipeline", file, snippetFor(text, tokenize("gstreamer gst nvenc nvdec caps memory")));
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

function selectImplementationContracts(input) {
  const requested = normalizeStringList(input);
  if (!requested.length) return implementationContracts.contracts;
  const selected = [];
  for (const id of requested) {
    const contract = findImplementationContract(id);
    if (!contract) throw new McpError(-32602, `Unknown implementation contract: ${id}`);
    selected.push(contract);
  }
  return selected;
}

function findImplementationContract(value) {
  const needle = lower(value);
  return implementationContracts.contracts.find(
    (contract) =>
      lower(contract.id) === needle ||
      lower(contract.name) === needle ||
      lower(contract.id).includes(needle) ||
      lower(contract.name).includes(needle)
  );
}

function implementationSdkRoots(input, projectRoot) {
  const roots = new Set();
  for (const value of normalizeStringList(input)) {
    if (value) roots.add(resolveInputPath(value));
  }
  if (projectRoot) roots.add(projectRoot);
  return [...roots].filter((root) => root && existsSync(root));
}

function evaluateImplementationContract(contract, context) {
  const checks = {
    project_type: checkProjectTypes(contract, context.project),
    unsupported_project: checkUnsupportedProject(contract, context.project, context.inventory),
    graphics_api: checkGraphicsApis(contract, context.project),
    content_path: checkContentPaths(contract, context.project),
    header_evidence: checkHeaderEvidence(contract, context.headerReport, context.inventory),
    input_resources: checkInputResources(contract, context.inventory),
    build_system: checkBuildSystem(contract, context.project),
    build_capabilities: checkBuildCapabilities(contract, context.inventory),
    runtime_validation: checkRuntimeValidation(contract),
    source_evidence: checkContractSources(contract)
  };

  const blockers = [];
  const rejected = checks.unsupported_project.status === "fail";
  if (!context.project) blockers.push("Project inspection is required.");
  if (rejected) blockers.push(...checks.unsupported_project.missing);
  if (checks.header_evidence.status === "fail") blockers.push(...checks.header_evidence.missing);
  for (const key of ["project_type", "graphics_api", "content_path", "input_resources", "build_system", "build_capabilities", "source_evidence"]) {
    const check = checks[key];
    if (check?.status === "fail") blockers.push(...(check.missing || []));
  }

  const missingSdk = checks.header_evidence.status === "fail";
  const missingProjectContract = ["project_type", "graphics_api", "content_path", "input_resources", "build_system", "build_capabilities", "source_evidence"].some(
    (key) => checks[key]?.status === "fail"
  );
  const state = !context.project
    ? "needs_project_inspection"
    : rejected
      ? "rejected_unsupported_project"
      : missingSdk
        ? "blocked_missing_sdk"
        : missingProjectContract
          ? "blocked_missing_project_contract"
          : "satisfied";

  const compileCommand = compileCommandForContract(contract, context.project);
  return {
    contract_id: contract.id,
    name: contract.name,
    technology_id: contract.technology_id,
    support_level: contract.support_level,
    state,
    state_reason: contractStateReason(state),
    gates: [
      gate("local_sdk_header_detected", checks.header_evidence.status, checks.header_evidence.summary),
      gate("source_backed_docs_available", checks.source_evidence.status, checks.source_evidence.summary),
      gate("repo_contract_satisfied", missingProjectContract || rejected || !context.project ? "fail" : "pass", "Project type, API/content path, inputs, and build-system capabilities meet this contract."),
      gate("patch_plan_approved", "required_before_edits", "A satisfied contract only permits a future patch plan; edits still require explicit approval."),
      gate("compile_test_command_available", compileCommand ? "pass" : "fail", compileCommand || "No compile/test command could be planned from the observed build system."),
      gate("validation_artifact_produced", "required_before_claiming_ready", "A local validation artifact must be produced before implementation readiness is claimed.")
    ],
    checks,
    compile_test_command: compileCommand,
    required_runtime_validation: contract.required_runtime_validation || [],
    blockers: [...new Set(blockers)],
    unsafe_assumptions: contract.unsafe_assumptions || [],
    implementation_boundaries: [
      "No generated renderer edits from this contract layer.",
      "No NVIDIA SDK download or binary copy.",
      "No feature UI exposure before runtime support checks.",
      "No implementation-ready claim without compile/runtime validation artifacts."
    ],
    sources: sourceRefs(contract.source_ids)
  };
}

function contractStateReason(state) {
  const table = {
    satisfied: "All contract checks passed. Patch planning can proceed, but implementation edits still require approval and validation.",
    blocked_missing_sdk: "Project evidence may be present, but required local SDK/header evidence was not found.",
    blocked_missing_project_contract: "Local SDK/header evidence may be present, but the repo does not satisfy all project/API/input/build contract requirements.",
    rejected_unsupported_project: "The project matched an unsupported project type for this native NVIDIA implementation target.",
    needs_project_inspection: "No inspectable project path was available."
  };
  return table[state] || state;
}

function gate(name, status, detail) {
  return { name, status, detail };
}

function checkProjectTypes(contract, project) {
  if (!project) return failCheck(["Project path was not inspected."]);
  const types = projectTypes(project);
  const required = contract.required_project_types_any || [];
  if (!required.length) return passCheck("No project-type requirement.");
  const matched = required.filter((item) => types.has(lower(item)));
  return matched.length
    ? passCheck(`Matched project type(s): ${matched.join(", ")}`, matched)
    : failCheck([`Required project type not found. Need one of: ${required.join(", ")}`], { observed_project_types: [...types] });
}

function checkUnsupportedProject(contract, project, inventory) {
  if (!project) return passCheck("No project classification available for unsupported-route check.");
  const types = projectTypes(project);
  const rejected = contract.rejected_project_types_any || [];
  const matched = rejected.filter((item) => types.has(lower(item)));
  if (matched.length) return failCheck([`Unsupported project type matched: ${matched.join(", ")}`], { observed_project_types: [...types] });
  if (isBrowserOnlyProject(project, inventory)) return failCheck(["Pure browser/browser-video project cannot use native NVIDIA SDKs directly."]);
  return passCheck("No unsupported project type matched.");
}

function isBrowserOnlyProject(project, inventory) {
  const types = projectTypes(project);
  const platforms = (project?.target_platforms || []).map(lower);
  const hasBrowserSignal = types.has("browser_extension") || types.has("browser_webgpu") || types.has("browser_video") || platforms.includes("browser");
  if (!hasBrowserSignal) return false;
  const text = inventoryText(inventory);
  return !/(electron|native messaging|native_messaging|native helper|desktop_web_hybrid|ipc|preload)/i.test(text);
}

function checkGraphicsApis(contract, project) {
  const required = contract.required_graphics_apis_any || [];
  if (!required.length) return passCheck("No graphics API requirement.");
  if (!project) return failCheck([`Graphics/API requirement cannot be checked without project inspection: ${required.join(", ")}`]);
  const observed = new Set((project.graphics_apis || []).map(lower));
  const languages = new Set((project.languages || []).map(lower));
  if (languages.has("cuda")) observed.add("cuda");
  const matched = required.filter((item) => observed.has(lower(item)));
  return matched.length
    ? passCheck(`Matched API(s): ${matched.join(", ")}`, matched)
    : failCheck([`Required graphics/media API not found. Need one of: ${required.join(", ")}`], { observed_apis: [...observed] });
}

function checkContentPaths(contract, project) {
  const required = contract.required_content_paths_any || [];
  if (!required.length) return passCheck("No content-path requirement.");
  if (!project) return failCheck([`Content-path requirement cannot be checked without project inspection: ${required.join(", ")}`]);
  const observed = new Set((project.content_paths || []).map(lower));
  const matched = required.filter((item) => observed.has(lower(item)));
  return matched.length
    ? passCheck(`Matched content path(s): ${matched.join(", ")}`, matched)
    : failCheck([`Required content path not found. Need one of: ${required.join(", ")}`], { observed_content_paths: [...observed] });
}

function checkHeaderEvidence(contract, headerReport, inventory) {
  const required = contract.required_header_evidence || [];
  const projectHeaderRequirements = contract.required_project_header_evidence || [];
  const missing = [];
  const evidence = [];

  for (const requirement of required) {
    const matched = headerRequirementMatches(requirement, headerReport);
    if (matched.ok) {
      evidence.push(matched.evidence);
    } else {
      missing.push(matched.reason);
    }
  }

  const text = inventoryText(inventory);
  for (const requirement of projectHeaderRequirements) {
    const matched = (requirement.tokens_any || []).filter((token) => text.includes(lower(token)));
    if (matched.length) {
      evidence.push({ description: requirement.description, matched_tokens: matched });
    } else {
      missing.push(`Missing project/header evidence: ${requirement.description || requirement.tokens_any?.join(", ")}`);
    }
  }

  if (!required.length && !projectHeaderRequirements.length) return passCheck("No local header requirement.");
  return missing.length ? failCheck(missing, { evidence }) : passCheck("Required local/project header evidence found.", evidence);
}

function headerRequirementMatches(requirement, headerReport) {
  const findings = (headerReport.findings || []).filter((finding) => lower(finding.technology_id) === lower(requirement.technology_id));
  if (!findings.length) {
    return { ok: false, reason: `Missing local SDK/header evidence for ${requirement.technology_id}.` };
  }

  const headers = findings.map((finding) => lower(finding.relative_path || finding.path || ""));
  const symbols = findings.flatMap((finding) => finding.symbols || []);
  const haystack = lower(`${headers.join(" ")} ${symbols.join(" ")}`);
  const headerMatched = !(requirement.headers_any || []).length || requirement.headers_any.some((header) => headers.some((value) => value.endsWith(lower(header)) || value.includes(lower(header))));
  const symbolMatched = !(requirement.symbols_any || []).length || requirement.symbols_any.some((symbol) => haystack.includes(lower(symbol)));

  if (!headerMatched) return { ok: false, reason: `Missing required header for ${requirement.technology_id}: ${requirement.headers_any.join(" or ")}` };
  if (!symbolMatched) return { ok: false, reason: `Missing required symbol evidence for ${requirement.technology_id}: ${requirement.symbols_any.join(" or ")}` };
  return {
    ok: true,
    evidence: {
      technology_id: requirement.technology_id,
      matched_headers: findings.map((finding) => finding.relative_path || finding.path).slice(0, 12),
      sample_symbols: symbols.slice(0, 20)
    }
  };
}

function checkInputResources(contract, inventory) {
  const resources = contract.required_input_resources || [];
  if (!resources.length) return passCheck("No input resource requirement.");
  if (!inventory) return failCheck(["Input resources cannot be checked without project inspection."]);
  const text = inventoryText(inventory);
  const missing = [];
  const matchedResources = [];
  for (const resource of resources) {
    const matched = (resource.tokens_any || []).filter((token) => text.includes(lower(token)));
    if (matched.length) {
      matchedResources.push({ id: resource.id, matched_tokens: matched });
    } else {
      missing.push(`Missing required input resource: ${resource.id} (${resource.description})`);
    }
  }
  return missing.length ? failCheck(missing, { matched_resources: matchedResources }) : passCheck("All required input resources were observed.", matchedResources);
}

function checkBuildSystem(contract, project) {
  const required = contract.required_build_systems_any || [];
  if (!required.length) return passCheck("No build-system requirement.");
  if (!project) return failCheck([`Build-system requirement cannot be checked without project inspection: ${required.join(", ")}`]);
  const observed = new Set((project.build_systems || []).map(lower));
  const matched = required.filter((item) => observed.has(lower(item)));
  return matched.length
    ? passCheck(`Matched build system(s): ${matched.join(", ")}`, matched)
    : failCheck([`Required build system not found. Need one of: ${required.join(", ")}`], { observed_build_systems: [...observed] });
}

function checkBuildCapabilities(contract, inventory) {
  const capabilities = contract.required_build_system_capabilities || [];
  if (!capabilities.length) return passCheck("No build capability requirement.");
  if (!inventory) return failCheck(["Build capabilities cannot be checked without project inspection."]);
  const text = inventoryText(inventory);
  const missing = [];
  const matchedCapabilities = [];
  for (const capability of capabilities) {
    const matched = (capability.tokens_any || []).filter((token) => text.includes(lower(token)));
    if (matched.length) {
      matchedCapabilities.push({ id: capability.id, matched_tokens: matched });
    } else {
      missing.push(`Missing build capability: ${capability.id} (${capability.description})`);
    }
  }
  return missing.length ? failCheck(missing, { matched_capabilities: matchedCapabilities }) : passCheck("Required build-system capabilities were observed.", matchedCapabilities);
}

function checkRuntimeValidation(contract) {
  const items = contract.required_runtime_validation || [];
  return items.length ? passCheck("Runtime validation requirements are defined.", items) : failCheck(["No runtime validation requirements defined for this contract."]);
}

function checkContractSources(contract) {
  const refs = sourceRefs(contract.source_ids);
  return refs.length ? passCheck("Official source references are available.", refs) : failCheck(["Contract has no resolvable official source references."]);
}

function passCheck(summary, evidence = []) {
  return { status: "pass", summary, evidence, missing: [] };
}

function failCheck(missing, evidence = {}) {
  return { status: "fail", summary: missing[0] || "Check failed.", missing, evidence };
}

function projectTypes(project) {
  const types = new Set();
  if (project?.primary_type) types.add(lower(project.primary_type));
  for (const item of project?.project_types || []) types.add(lower(item.name));
  return types;
}

function inventoryText(inventory) {
  if (!inventory) return "";
  return lower([
    ...inventory.files.map((file) => file.relative),
    ...inventory.contentIndex.map((file) => `${file.relative}\n${file.text}`)
  ].join("\n"));
}

function compileCommandForContract(contract, project) {
  const systems = new Set((project?.build_systems || []).map(lower));
  if (systems.has("cmake")) return "cmake -S <project_path> -B <build_dir> && cmake --build <build_dir>";
  if (systems.has("msbuild/visual studio")) return "msbuild <solution-or-project>.sln /m";
  if (systems.has("unreal build tool")) return "Run Unreal Build Tool for the project target, then validate editor and packaged logs.";
  if (systems.has("python")) return "python -m pytest or project-specific Python validation harness";
  if (systems.has("npm")) return "npm test or project-specific native-helper validation harness";
  if (contract.id === "video-codec-nvenc-nvdec-pipeline") return "ffmpeg/gstreamer throughput harness after local tools and sample media are supplied";
  return null;
}

function summarizeContractResults(results) {
  const counts = {};
  for (const result of results) counts[result.state] = (counts[result.state] || 0) + 1;
  return {
    total: results.length,
    by_state: counts,
    ready_for_patch_planning: results.filter((item) => item.state === "satisfied").map((item) => item.contract_id),
    blocked: results.filter((item) => item.state !== "satisfied").map((item) => ({ contract_id: item.contract_id, state: item.state, blockers: item.blockers }))
  };
}

const UNREAL_DLSS_SUPPORTED_ENGINE_VERSIONS = ["5.4", "5.5", "5.6", "5.7"];

function buildUnrealDlssValidation(projectRoot, inventory, project, options = {}) {
  const uproject = findUnrealProjectDescriptor(inventory);
  const pluginDescriptors = findUnrealNvidiaPluginDescriptors(inventory);
  const pluginEntries = findUnrealNvidiaProjectPluginEntries(uproject.json);
  const configStatus = unrealConfigStatus(inventory);
  const logs = unrealLogsToInspect(projectRoot, inventory, uproject);
  const engineCompatibility = unrealEngineCompatibility(uproject, pluginDescriptors);
  const pluginStatus = unrealPluginStatus(pluginDescriptors, pluginEntries);
  const packaging = unrealPackagingStatus(inventory, pluginStatus, configStatus, logs, engineCompatibility);
  const blockers = unrealValidationBlockers(uproject, pluginStatus, engineCompatibility);
  const warnings = unrealValidationWarnings(configStatus, packaging, logs, pluginStatus);
  const state = unrealValidationState(uproject, pluginStatus, engineCompatibility, configStatus);

  const validationReport = {
    state,
    project_root: projectRoot,
    uproject: uproject.path
      ? {
          path: uproject.path,
          relative_path: uproject.relative_path,
          engine_association: uproject.engine_association,
          project_name: uproject.project_name
        }
      : null,
    engine_compatibility: engineCompatibility,
    plugin_status: pluginStatus,
    config_status: configStatus,
    packaging_risks: packaging,
    logs_to_inspect: logs,
    blockers,
    warnings,
    observed_project_type: project?.primary_type || "unknown",
    source_evidence: sourceRefs(["nvidia-dlss", "streamline-releases"])
  };
  const safePatchPlan = options.includePatchPlan === false ? null : unrealSafePatchPlan(validationReport);
  return {
    validation_report: validationReport,
    safe_patch_plan: safePatchPlan,
    artifacts: unrealValidationArtifacts(validationReport, safePatchPlan)
  };
}

function findUnrealProjectDescriptor(inventory) {
  const file = inventory.files.find((item) => /\.uproject$/i.test(item.name));
  if (!file) {
    return {
      path: null,
      relative_path: null,
      project_name: null,
      json: null,
      engine_association: null
    };
  }
  const json = safeJson(file.full);
  return {
    path: file.full,
    relative_path: file.relative,
    project_name: file.name.replace(/\.uproject$/i, ""),
    json,
    engine_association: json?.EngineAssociation || json?.EngineVersion || null
  };
}

function findUnrealNvidiaPluginDescriptors(inventory) {
  return inventory.files
    .filter((file) => /\.uplugin$/i.test(file.name))
    .map((file) => {
      const json = safeJson(file.full);
      const descriptorText = lower(`${file.relative} ${file.name} ${json?.FriendlyName || ""} ${json?.Description || ""}`);
      const nvidiaRelevant = /nvidia|dlss|streamline|reflex|ngx|nis/.test(descriptorText);
      return {
        path: file.full,
        relative_path: file.relative,
        name: file.name.replace(/\.uplugin$/i, ""),
        friendly_name: json?.FriendlyName || null,
        version_name: json?.VersionName || null,
        version: json?.Version || null,
        engine_version: json?.EngineVersion || null,
        installed: nvidiaRelevant,
        descriptor_parse_state: json ? "parsed" : "unreadable_or_invalid_json"
      };
    })
    .filter((item) => item.installed);
}

function findUnrealNvidiaProjectPluginEntries(projectJson) {
  return normalizeArray(projectJson?.Plugins)
    .filter((entry) => /nvidia|dlss|streamline|reflex|ngx|nis/i.test(`${entry?.Name || ""} ${entry?.MarketplaceURL || ""}`))
    .map((entry) => ({
      name: entry.Name || null,
      enabled: entry.Enabled === true,
      marketplace_url_present: Boolean(entry.MarketplaceURL),
      raw: entry
    }));
}

function unrealPluginStatus(pluginDescriptors, pluginEntries) {
  const installed = pluginDescriptors.length > 0;
  const enabledEntries = pluginEntries.filter((entry) => entry.enabled);
  const disabledEntries = pluginEntries.filter((entry) => entry.enabled === false);
  const referencedNames = new Set(pluginEntries.map((entry) => lower(entry.name)));
  const unreferencedDescriptors = pluginDescriptors.filter((descriptor) => !referencedNames.has(lower(descriptor.name)));
  const state = !installed
    ? "plugin_missing"
    : !pluginEntries.length
      ? "plugin_installed_project_reference_missing"
      : disabledEntries.length && !enabledEntries.length
        ? "plugin_referenced_but_disabled"
        : "plugin_installed_and_referenced";
  return {
    state,
    installed,
    plugin_descriptors: pluginDescriptors,
    project_plugin_entries: pluginEntries,
    enabled_entries: enabledEntries,
    disabled_entries: disabledEntries,
    unreferenced_descriptors: unreferencedDescriptors,
    missing: installed ? [] : ["No NVIDIA/DLSS/Streamline/Reflex .uplugin descriptor was found under the project."]
  };
}

function unrealEngineCompatibility(uproject, pluginDescriptors) {
  const normalized = normalizeUnrealEngineVersion(uproject.engine_association);
  const descriptorVersions = pluginDescriptors.map((descriptor) => normalizeUnrealEngineVersion(descriptor.engine_version)).filter(Boolean);
  const descriptorMismatch = descriptorVersions.some((version) => normalized && version !== normalized);
  const knownSupported = normalized && UNREAL_DLSS_SUPPORTED_ENGINE_VERSIONS.includes(normalized);
  const state = !normalized
    ? "unknown"
    : descriptorMismatch
      ? "plugin_engine_version_mismatch"
      : knownSupported
        ? "known_supported"
        : "not_in_current_supported_list";
  return {
    state,
    engine_version: uproject.engine_association || null,
    normalized_engine_version: normalized,
    supported_engine_versions_from_registry: UNREAL_DLSS_SUPPORTED_ENGINE_VERSIONS,
    plugin_descriptor_engine_versions: descriptorVersions,
    evidence_source: "NVIDIA DLSS Developer Page registry entry verified 2026-04-30",
    assumptions: [
      "Compatibility is version-list based; local official plugin release notes should be checked before implementation.",
      "Custom Unreal engine forks require separate inspection."
    ]
  };
}

function unrealConfigStatus(inventory) {
  const configFiles = inventory.files.filter((file) => /^Config[\\/].*\.ini$/i.test(file.relative));
  const hits = [];
  for (const file of inventory.contentIndex) {
    if (!/^Config[\\/].*\.ini$/i.test(file.relative)) continue;
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/dlss|streamline|nvidia|reflex|ngx|r\.ng[xl]|r\.dlss|r\.streamline/i.test(line)) {
        hits.push({ file: file.full, relative_path: file.relative, line: index + 1, text: line.trim() });
      }
    });
  }
  return {
    state: hits.length ? "config_present" : "config_missing",
    config_files: configFiles.map((file) => ({ path: file.full, relative_path: file.relative })),
    nvidia_config_hits: hits.slice(0, 80),
    suggestions: [
      "Keep any NVIDIA plugin settings in Config/*.ini as a small, reviewable diff.",
      "Use the official plugin documentation for exact setting names; do not invent console variables.",
      "Validate editor and packaged builds separately after config changes."
    ]
  };
}

function unrealPackagingStatus(inventory, pluginStatus, configStatus, logs, engineCompatibility) {
  const hints = [];
  const binaryCandidates = [];
  for (const file of inventory.files) {
    const rel = file.relative.replaceAll("\\", "/");
    if (/Config\/DefaultGame\.ini$/i.test(rel) || /ProjectPackagingSettings|Packaging|Shipping|StagedBuilds|WindowsNoEditor|Target\.cs$/i.test(rel)) {
      hints.push({ path: file.full, relative_path: file.relative, reason: "packaging-related file/path" });
    }
    if (/(sl\.interposer|sl\.dlss|sl\.dlss_g|nvngx_dlss|streamline|reflex).*\.(dll|so|dylib)$/i.test(file.name)) {
      binaryCandidates.push({ path: file.full, relative_path: file.relative });
    }
  }
  for (const file of inventory.contentIndex) {
    if (/ProjectPackagingSettings|ForDistribution|BuildConfiguration|StagingDirectory|DirectoriesToAlwaysStage/i.test(file.text)) {
      hints.push({ path: file.full, relative_path: file.relative, reason: "packaging setting text" });
    }
  }

  const risks = [];
  if (!pluginStatus.installed) risks.push("Plugin missing; packaged-build state cannot be validated.");
  if (pluginStatus.state === "plugin_installed_project_reference_missing") risks.push("Plugin folder exists but .uproject reference is missing; packaged builds may not load it.");
  if (pluginStatus.state === "plugin_referenced_but_disabled") risks.push("NVIDIA plugin entries are present but disabled.");
  if (engineCompatibility.state.includes("mismatch") || engineCompatibility.state === "not_in_current_supported_list") risks.push("Engine version compatibility is not known-supported by the current registry baseline.");
  if (configStatus.state === "config_missing") risks.push("No NVIDIA/DLSS/Streamline config entries were observed.");
  if (!hints.length) risks.push("No packaged-build settings or staged-build hints were observed.");
  if (!logs.existing_logs.length) risks.push("No existing Unreal logs were found; editor and packaged-build logs still need inspection.");
  if (pluginStatus.installed && !binaryCandidates.length) risks.push("No NVIDIA runtime binary candidates were observed; do not copy binaries without license and production-library review.");

  return {
    state: risks.length ? "risks_present" : "no_immediate_packaging_risks_observed",
    hints: dedupeByPathReason(hints).slice(0, 50),
    binary_candidates: binaryCandidates.slice(0, 50),
    risks: [...new Set(risks)]
  };
}

function unrealLogsToInspect(projectRoot, inventory, uproject) {
  const existingLogs = inventory.files
    .filter((file) => /(^|[\\/])Saved[\\/]Logs[\\/].*\.log$/i.test(file.relative) || /\.log$/i.test(file.name) && /unreal|dlss|streamline|nvidia|reflex/i.test(file.relative))
    .map((file) => ({ path: file.full, relative_path: file.relative }));
  const projectName = uproject.project_name || "<ProjectName>";
  return {
    existing_logs: existingLogs,
    expected_logs: [
      join(projectRoot, "Saved", "Logs", `${projectName}.log`),
      join(projectRoot, "Saved", "Logs"),
      "Packaged build Saved/Logs directory for the target platform",
      "AutomationTool/UnrealBuildTool package logs from the build machine"
    ],
    inspect_for: [
      "NVIDIA/DLSS/Streamline plugin load lines",
      "plugin missing, incompatible, or disabled messages",
      "feature support and runtime availability messages",
      "packaged-build staging or binary load failures"
    ]
  };
}

function unrealValidationBlockers(uproject, pluginStatus, engineCompatibility) {
  const blockers = [];
  if (!uproject.path) blockers.push("No .uproject file was found.");
  if (!pluginStatus.installed) blockers.push("NVIDIA DLSS/Streamline Unreal plugin is not installed in the project.");
  if (pluginStatus.state === "plugin_referenced_but_disabled") blockers.push("NVIDIA plugin entries are disabled in .uproject.");
  if (engineCompatibility.state === "plugin_engine_version_mismatch" || engineCompatibility.state === "not_in_current_supported_list") {
    blockers.push("Engine version compatibility is blocked or unknown until the matching official NVIDIA plugin package is confirmed.");
  }
  return blockers;
}

function unrealValidationWarnings(configStatus, packaging, logs, pluginStatus) {
  const warnings = [];
  if (pluginStatus.state === "plugin_installed_project_reference_missing") warnings.push("Plugin files are present but .uproject does not reference them.");
  if (configStatus.state === "config_missing") warnings.push("No NVIDIA config entries were observed.");
  warnings.push(...packaging.risks);
  if (!logs.existing_logs.length) warnings.push("Logs are not present yet; run editor and packaged-build validation before claiming readiness.");
  return [...new Set(warnings)];
}

function unrealValidationState(uproject, pluginStatus, engineCompatibility, configStatus) {
  if (!uproject.path) return "not_unreal_project";
  if (engineCompatibility.state === "plugin_engine_version_mismatch" || engineCompatibility.state === "not_in_current_supported_list") return "engine_version_mismatch";
  if (!pluginStatus.installed) return "plugin_missing";
  if (pluginStatus.state !== "plugin_installed_and_referenced") return pluginStatus.state;
  if (configStatus.state === "config_missing") return "plugin_present_config_missing";
  return "plugin_present_configured";
}

function unrealSafePatchPlan(report) {
  const steps = [
    patchStep("Preserve current Unreal project state", [report.uproject?.relative_path || "*.uproject", "Config/*.ini"], "Record the current .uproject plugin entries, Config/*.ini state, and log baseline before any later edits.", ["Plan only; do not edit files from validation output."])
  ];
  if (report.plugin_status.state === "plugin_missing") {
    steps.push(
      patchStep("Block plugin enablement until official plugin is supplied", ["Plugins/**"], "Ask the user to provide/install the official NVIDIA Unreal plugin that matches the detected UE version. This plugin will not download it.", ["No downloads.", "No NVIDIA binary copying.", "Do not add fake .uproject plugin references."])
    );
  } else if (report.plugin_status.state === "plugin_installed_project_reference_missing") {
    steps.push(
      patchStep("Plan .uproject plugin references", [report.uproject?.relative_path || "*.uproject"], `Add explicit plugin entries for observed descriptors: ${report.plugin_status.plugin_descriptors.map((item) => item.name).join(", ")}.`, ["Patch plan only; use a separate approved edit.", "Keep JSON formatting stable.", "Do not move plugin files or binaries."])
    );
  } else if (report.plugin_status.state === "plugin_referenced_but_disabled") {
    steps.push(
      patchStep("Plan enabling existing plugin references", [report.uproject?.relative_path || "*.uproject"], "Flip only the existing NVIDIA plugin entries from Enabled=false to Enabled=true after user approval.", ["Do not add unrelated plugins.", "Keep this as a single reviewable project descriptor diff."])
    );
  }
  if (report.config_status.state === "config_missing") {
    steps.push(
      patchStep("Plan config suggestions", ["Config/DefaultEngine.ini", "Config/DefaultGame.ini"], "Add only source-verified NVIDIA plugin settings after the exact installed plugin documentation is inspected.", ["Do not invent console variables.", "Config changes must be separately validated in editor and packaged build."])
    );
  } else {
    steps.push(
      patchStep("Review existing NVIDIA config", report.config_status.config_files.map((file) => file.relative_path), "Verify observed NVIDIA/DLSS/Streamline config entries match the installed plugin docs and target packaging mode.", ["Do not normalize or rewrite unrelated .ini sections."])
    );
  }
  steps.push(
    patchStep("Add validation docs/scripts", ["tools/nvidia/validate-unreal-dlss-project.ps1", "docs/nvidia/unreal-dlss-validation-report.md"], "Create read-only validation artifacts that inspect plugin/config/log state without modifying Unreal project files.", ["Writes require approval_token=APPROVED_UNREAL_DLSS_VALIDATION.", "Artifacts are create-only and never overwrite existing files."]),
    patchStep("Validate editor and packaged logs", ["Saved/Logs", "packaged build logs"], "Run editor startup and packaged-build validation, then inspect logs for plugin load, compatibility, and binary staging messages.", ["No readiness claim without logs."])
  );
  return {
    state: "plan_only_requires_approval",
    writes_require_approval: true,
    approval_token_for_artifacts: "APPROVED_UNREAL_DLSS_VALIDATION",
    steps
  };
}

function unrealValidationArtifacts(report, safePatchPlan) {
  return [
    scaffoldFile(
      "tools/nvidia/validate-unreal-dlss-project.ps1",
      "powershell",
      "Read-only Unreal DLSS/Streamline plugin validation helper.",
      unrealDlssProjectValidationScript()
    ),
    scaffoldFile(
      "docs/nvidia/unreal-dlss-validation-report.md",
      "markdown",
      "Generated validation report template for Unreal DLSS plugin readiness.",
      unrealDlssValidationMarkdown(report, safePatchPlan)
    )
  ];
}

function writeUnrealValidationArtifacts(artifacts, projectRoot, args) {
  if (args.write_files !== true) return [];
  if (args.approval_token !== "APPROVED_UNREAL_DLSS_VALIDATION") {
    throw new McpError(-32602, "write_files requires approval_token=APPROVED_UNREAL_DLSS_VALIDATION");
  }
  const base = args.output_dir ? resolveInputPath(args.output_dir) : join(projectRoot, "_nvidia_unreal_dlss_validation");
  mkdirSync(base, { recursive: true });
  const written = [];
  for (const artifact of artifacts || []) {
    const relative = sanitizeRelativeOutputPath(artifact.relative_path);
    const target = resolve(base, relative);
    if (!isWithinPath(target, base)) throw new McpError(-32602, `Refusing to write outside output directory: ${artifact.relative_path}`);
    if (existsSync(target)) {
      written.push({ path: target, status: "skipped_existing", reason: "Existing validation artifacts are never overwritten." });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.content, "utf8");
    written.push({ path: target, status: "created" });
  }
  return written;
}

function normalizeUnrealEngineVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function dedupeByPathReason(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = `${item.relative_path || item.path}:${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

const UNITY_HDRP_MIN_DLSS_VERSION = { major: 2021, minor: 2, label: "2021.2" };

function buildUnityHdrpValidation(projectRoot, inventory, project, options = {}) {
  const unityVersion = findUnityVersion(inventory);
  const packages = findUnityPackages(inventory);
  const renderPipeline = findUnityRenderPipelineEvidence(inventory);
  const nvidiaSettings = findUnityNvidiaSettings(inventory);
  const reflexReadiness = findUnityReflexReadiness(inventory, nvidiaSettings);
  const route = classifyUnityDlssRoute(unityVersion, packages, renderPipeline);
  const blockers = unityValidationBlockers(route, unityVersion, packages, renderPipeline);
  const warnings = unityValidationWarnings(route, renderPipeline, nvidiaSettings, reflexReadiness);
  const validationReport = {
    state: route.state,
    route,
    project_root: projectRoot,
    unity_version: unityVersion,
    package_status: packages,
    render_pipeline_hints: renderPipeline,
    nvidia_dlss_settings: nvidiaSettings,
    reflex_readiness: reflexReadiness,
    project_settings_to_inspect: unityProjectSettingsToInspect(projectRoot, inventory),
    camera_and_render_pipeline_requirements: unityCameraRenderPipelineRequirements(route),
    blockers,
    warnings,
    no_fake_metrics_policy: [
      "No FPS, frame-time, latency, or profiler result is reported unless it comes from a runnable Unity validation path.",
      "Static readiness is not runtime success."
    ],
    observed_project_type: project?.primary_type || "unknown",
    source_evidence: sourceRefs(["nvidia-dlss", "nvidia-reflex"])
  };
  const safePatchPlan = options.includePatchPlan === false ? null : unitySafePatchPlan(validationReport);
  return {
    validation_report: validationReport,
    safe_patch_plan: safePatchPlan,
    artifacts: unityValidationArtifacts(validationReport, safePatchPlan)
  };
}

function findUnityVersion(inventory) {
  const versionFile = inventory.contentIndex.find((file) => /ProjectSettings[\\/]ProjectVersion\.txt$/i.test(file.relative));
  const text = versionFile?.text || "";
  const match = text.match(/m_EditorVersion:\s*([^\r\n]+)/i);
  const raw = match?.[1]?.trim() || null;
  const parsed = parseUnityVersion(raw);
  return {
    state: raw ? "detected" : "missing",
    file: versionFile ? { path: versionFile.full, relative_path: versionFile.relative } : null,
    raw,
    major: parsed?.major || null,
    minor: parsed?.minor || null,
    patch: parsed?.patch || null,
    normalized: parsed ? `${parsed.major}.${parsed.minor}` : null
  };
}

function parseUnityVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function findUnityPackages(inventory) {
  const manifestFile = inventory.files.find((file) => /Packages[\\/]manifest\.json$/i.test(file.relative));
  const manifest = manifestFile ? safeJson(manifestFile.full) : null;
  const dependencies = manifest?.dependencies || {};
  const hdrpVersion = dependencies["com.unity.render-pipelines.high-definition"] || null;
  const urpVersion = dependencies["com.unity.render-pipelines.universal"] || null;
  const coreVersion = dependencies["com.unity.render-pipelines.core"] || null;
  return {
    manifest: manifestFile ? { path: manifestFile.full, relative_path: manifestFile.relative, parse_state: manifest ? "parsed" : "unreadable_or_invalid_json" } : null,
    hdrp: {
      present: Boolean(hdrpVersion),
      package: "com.unity.render-pipelines.high-definition",
      version: hdrpVersion
    },
    urp: {
      present: Boolean(urpVersion),
      package: "com.unity.render-pipelines.universal",
      version: urpVersion
    },
    core: {
      present: Boolean(coreVersion),
      package: "com.unity.render-pipelines.core",
      version: coreVersion
    }
  };
}

function findUnityRenderPipelineEvidence(inventory) {
  const hints = [];
  const pipelineFiles = [];
  const cameraHints = [];
  for (const file of inventory.contentIndex) {
    const rel = file.relative.replaceAll("\\", "/");
    const isUnitySurface = /^(ProjectSettings|Assets)\//i.test(rel);
    if (!isUnitySurface) continue;
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (/HDRenderPipeline|HighDefinitionRenderPipeline|HDRP|m_RenderPipeline|RenderPipelineAsset|GraphicsSettings|QualitySettings|DynamicResolution/i.test(trimmed)) {
        hints.push({ file: file.full, relative_path: file.relative, line: index + 1, text: trimmed });
      }
      if (/Camera|HDAdditionalCameraData|allowDynamicResolution|deepLearning|DLSS|antiAliasing/i.test(trimmed)) {
        cameraHints.push({ file: file.full, relative_path: file.relative, line: index + 1, text: trimmed });
      }
    });
  }
  for (const file of inventory.files) {
    if (/HDRenderPipeline|HighDefinition|HDRP|RenderPipeline|GraphicsSettings|QualitySettings/i.test(file.relative)) {
      pipelineFiles.push({ path: file.full, relative_path: file.relative });
    }
  }
  return {
    state: hints.length || pipelineFiles.length ? "render_pipeline_hints_present" : "render_pipeline_hints_missing",
    hints: hints.slice(0, 80),
    pipeline_files: pipelineFiles.slice(0, 50),
    camera_hints: cameraHints.slice(0, 80)
  };
}

function findUnityNvidiaSettings(inventory) {
  const hits = [];
  for (const file of inventory.contentIndex) {
    const rel = file.relative.replaceAll("\\", "/");
    if (!/^(ProjectSettings|Assets|Packages)\//i.test(rel)) continue;
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (/NVIDIA|DLSS|DeepLearningSuperSampling|Reflex|low latency|frame generation/i.test(trimmed)) {
        hits.push({ file: file.full, relative_path: file.relative, line: index + 1, text: trimmed });
      }
    });
  }
  return {
    state: hits.length ? "settings_or_code_hints_present" : "settings_not_observed",
    hits: hits.slice(0, 80),
    caveat: "Static text hits are not proof that DLSS or Reflex works at runtime."
  };
}

function findUnityReflexReadiness(inventory, nvidiaSettings) {
  const markers = [];
  for (const file of inventory.contentIndex) {
    const rel = file.relative.replaceAll("\\", "/");
    if (!/^(Assets|Packages|ProjectSettings)\//i.test(rel)) continue;
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (/Reflex|latency|low latency|marker|input sample|simulation|render submit|present/i.test(trimmed)) {
        markers.push({ file: file.full, relative_path: file.relative, line: index + 1, text: trimmed });
      }
    });
  }
  return {
    state: markers.length || /reflex/i.test(JSON.stringify(nvidiaSettings.hits || [])) ? "reflex_hints_present" : "needs_intent_and_marker_inspection",
    markers: markers.slice(0, 80),
    requirements: [
      "Only plan Reflex if latency is a user goal or Frame Generation/latency-sensitive interaction is in scope.",
      "Do not claim latency improvement without measured Unity/runtime validation artifacts.",
      "Identify input, simulation, render, present, and frame-end boundaries before marker work."
    ]
  };
}

function classifyUnityDlssRoute(unityVersion, packages, renderPipeline) {
  const versionSupported = unityVersion.major !== null && unityVersionAtLeast(unityVersion, UNITY_HDRP_MIN_DLSS_VERSION);
  if (packages.hdrp.present && versionSupported) {
    return {
      state: "unity_hdrp_supported_route",
      recommended_route: "Unity HDRP DLSS readiness",
      reason: "HDRP package is present and Unity version is at or above the plugin baseline for HDRP DLSS routing."
    };
  }
  if (packages.hdrp.present && unityVersion.state === "missing") {
    return {
      state: "unsupported_unknown_route",
      recommended_route: "blocked_until_unity_version_is_observed",
      reason: "HDRP is present, but ProjectSettings/ProjectVersion.txt or m_EditorVersion was not observed."
    };
  }
  if (packages.hdrp.present && !versionSupported) {
    return {
      state: "version_mismatch",
      recommended_route: "blocked_until_unity_hdrp_version_review",
      reason: `HDRP is present, but Unity ${unityVersion.raw || "unknown"} is below the ${UNITY_HDRP_MIN_DLSS_VERSION.label}+ baseline used by this plugin.`
    };
  }
  if (packages.urp.present || /universal/i.test(JSON.stringify(renderPipeline))) {
    return {
      state: "urp_custom_srp_advanced_route",
      recommended_route: "advanced_custom_srp_inspection",
      reason: "URP/custom SRP is not the first-class HDRP DLSS route; feasibility requires render-pipeline and native-plugin inspection."
    };
  }
  return {
    state: "unsupported_unknown_route",
    recommended_route: "inspect_project_before_dlss_claims",
    reason: "HDRP was not detected, so this plugin cannot classify the project as ready for Unity HDRP DLSS planning."
  };
}

function unityVersionAtLeast(unityVersion, minimum) {
  if (unityVersion.major === null || unityVersion.minor === null) return false;
  if (unityVersion.major > minimum.major) return true;
  if (unityVersion.major < minimum.major) return false;
  return unityVersion.minor >= minimum.minor;
}

function unityValidationBlockers(route, unityVersion, packages, renderPipeline) {
  const blockers = [];
  if (unityVersion.state === "missing") blockers.push("ProjectSettings/ProjectVersion.txt or m_EditorVersion was not found.");
  if (route.state === "version_mismatch") blockers.push(`Unity version is below the ${UNITY_HDRP_MIN_DLSS_VERSION.label}+ HDRP DLSS baseline used by this plugin.`);
  if (route.state === "unsupported_unknown_route") blockers.push("HDRP package was not detected in Packages/manifest.json.");
  if (route.state === "urp_custom_srp_advanced_route") blockers.push("URP/custom SRP route requires advanced render-pipeline inspection before DLSS feasibility claims.");
  if (packages.hdrp.present && renderPipeline.state === "render_pipeline_hints_missing") blockers.push("HDRP package is present, but render pipeline asset/settings evidence was not observed.");
  return blockers;
}

function unityValidationWarnings(route, renderPipeline, nvidiaSettings, reflexReadiness) {
  const warnings = [];
  if (renderPipeline.state === "render_pipeline_hints_missing") warnings.push("Render pipeline asset/settings hints were not observed.");
  if (!renderPipeline.camera_hints.length) warnings.push("Camera/HDRP camera settings were not observed.");
  if (nvidiaSettings.state === "settings_not_observed") warnings.push("No NVIDIA/DLSS settings or code hints were observed.");
  if (reflexReadiness.state === "needs_intent_and_marker_inspection") warnings.push("Reflex readiness requires user intent and marker-boundary inspection.");
  if (route.state !== "unity_hdrp_supported_route") warnings.push(route.reason);
  warnings.push("No FPS, profiler, or runtime success data is produced by static validation.");
  return [...new Set(warnings)];
}

function unityProjectSettingsToInspect(projectRoot, inventory) {
  const expected = [
    "ProjectSettings/ProjectVersion.txt",
    "Packages/manifest.json",
    "ProjectSettings/GraphicsSettings.asset",
    "ProjectSettings/QualitySettings.asset",
    "Assets/**/*.asset",
    "Assets/**/*.unity",
    "Assets/**/*.cs"
  ];
  return expected.map((pattern) => {
    const direct = pattern.includes("*") ? null : join(projectRoot, ...pattern.split("/"));
    const exists = direct ? existsSync(direct) : inventory.files.some((file) => wildcardUnityPatternMatch(file.relative, pattern));
    return { pattern, exists };
  });
}

function wildcardUnityPatternMatch(relative, pattern) {
  const rel = relative.replaceAll("\\", "/");
  if (pattern === "Assets/**/*.asset") return /^Assets\/.*\.asset$/i.test(rel);
  if (pattern === "Assets/**/*.unity") return /^Assets\/.*\.unity$/i.test(rel);
  if (pattern === "Assets/**/*.cs") return /^Assets\/.*\.cs$/i.test(rel);
  return false;
}

function unityCameraRenderPipelineRequirements(route) {
  return [
    "Confirm the active render pipeline asset is HDRP for every target quality level.",
    "Inspect HDRP asset and camera settings for DLSS/dynamic-resolution prerequisites using Unity/NVIDIA docs for the detected versions.",
    "Select representative scenes and cameras for validation; static inspection is not enough.",
    "If route is URP/custom SRP, stop before claiming DLSS support and inspect the custom render pipeline/native plugin path.",
    "For Reflex, identify latency-sensitive interactions and marker boundaries before adding any integration."
  ].map((item) => ({
    requirement: item,
    applies: route.state === "unity_hdrp_supported_route" || /URP|custom|Reflex|route/i.test(item)
  }));
}

function unitySafePatchPlan(report) {
  const steps = [
    patchStep("Preserve current Unity project state", ["ProjectSettings/ProjectVersion.txt", "Packages/manifest.json", "ProjectSettings/*.asset"], "Record Unity version, packages, render pipeline assets, quality settings, scenes, and current NVIDIA/DLSS hints before later edits.", ["Plan only; do not edit Unity serialized files from validation output."]),
    patchStep("Inspect HDRP package and render pipeline asset", ["Packages/manifest.json", "ProjectSettings/GraphicsSettings.asset", "ProjectSettings/QualitySettings.asset", "Assets/**/*.asset"], "Verify HDRP is active in project and quality settings for target scenes.", ["Do not mutate serialized assets until the exact asset references are reviewed."])
  ];
  if (report.route.state === "unity_hdrp_supported_route") {
    steps.push(
      patchStep("Plan HDRP DLSS readiness checks", ["HDRP asset", "camera settings", "dynamic resolution settings", "representative scenes"], "Define non-mutating checks for HDRP DLSS prerequisites, camera settings, dynamic resolution, and target scene coverage.", ["No runtime success claim until Unity validation can run."])
    );
  } else if (report.route.state === "urp_custom_srp_advanced_route") {
    steps.push(
      patchStep("Block first-class HDRP patching", ["Packages/manifest.json", "Assets/**/*.asset", "Assets/**/*.cs"], "Route to advanced URP/custom SRP feasibility inspection instead of HDRP DLSS config edits.", ["Do not claim native HDRP DLSS support for URP/custom SRP."])
    );
  } else {
    steps.push(
      patchStep("Block DLSS readiness claim", ["Packages/manifest.json", "ProjectSettings/ProjectVersion.txt"], "Resolve Unity/HDRP version or missing HDRP package before DLSS-specific patch planning.", ["Do not add fake NVIDIA settings."])
    );
  }
  steps.push(
    patchStep("Plan Reflex readiness only when relevant", ["Assets/**/*.cs", "camera/controller scripts", "input/render loop boundaries"], "If latency matters, identify input, simulation, render, present, and frame-end boundaries for future Reflex validation.", ["No latency or FPS claims without measured artifacts."]),
    patchStep("Add validation docs/scripts", ["tools/nvidia/validate-unity-hdrp-dlss-project.ps1", "docs/nvidia/unity-hdrp-dlss-validation-report.md"], "Create read-only validation artifacts that inspect Unity version, HDRP package, render pipeline hints, NVIDIA settings, and logs.", ["Writes require approval_token=APPROVED_UNITY_HDRP_VALIDATION.", "Artifacts are create-only and never overwrite existing files."])
  );
  return {
    state: "plan_only_requires_approval",
    writes_require_approval: true,
    approval_token_for_artifacts: "APPROVED_UNITY_HDRP_VALIDATION",
    steps
  };
}

function unityValidationArtifacts(report, safePatchPlan) {
  return [
    scaffoldFile(
      "tools/nvidia/validate-unity-hdrp-dlss-project.ps1",
      "powershell",
      "Read-only Unity HDRP DLSS readiness validation helper.",
      unityHdrpValidationScript()
    ),
    scaffoldFile(
      "docs/nvidia/unity-hdrp-dlss-validation-report.md",
      "markdown",
      "Generated validation report template for Unity HDRP DLSS readiness.",
      unityHdrpValidationMarkdown(report, safePatchPlan)
    )
  ];
}

function writeUnityValidationArtifacts(artifacts, projectRoot, args) {
  if (args.write_files !== true) return [];
  if (args.approval_token !== "APPROVED_UNITY_HDRP_VALIDATION") {
    throw new McpError(-32602, "write_files requires approval_token=APPROVED_UNITY_HDRP_VALIDATION");
  }
  const base = args.output_dir ? resolveInputPath(args.output_dir) : join(projectRoot, "_nvidia_unity_hdrp_validation");
  mkdirSync(base, { recursive: true });
  const written = [];
  for (const artifact of artifacts || []) {
    const relative = sanitizeRelativeOutputPath(artifact.relative_path);
    const target = resolve(base, relative);
    if (!isWithinPath(target, base)) throw new McpError(-32602, `Refusing to write outside output directory: ${artifact.relative_path}`);
    if (existsSync(target)) {
      written.push({ path: target, status: "skipped_existing", reason: "Existing validation artifacts are never overwritten." });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.content, "utf8");
    written.push({ path: target, status: "created" });
  }
  return written;
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
  const sdkRoots = headerGroundingRoots(args, root);
  const headerGrounding = buildContextHeaderGrounding({
    technologyId: primaryRoute.technology_id,
    workflow,
    roots: sdkRoots,
    maxFiles: args.max_files
  });
  const unrealValidation = workflow === "unreal" && root
    ? buildUnrealDlssValidation(root, inventory, project, { includePatchPlan: true })
    : null;
  const unityHdrpValidation = workflow === "unity-hdrp" && root
    ? buildUnityHdrpValidation(root, inventory, project, { includePatchPlan: true })
    : null;

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
    workflow,
    sdkRoots,
    headerGrounding,
    unrealValidation,
    unityHdrpValidation
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

function headerGroundingRoots(args, projectRoot) {
  const roots = new Set();
  for (const value of normalizeStringList(args.sdk_roots)) roots.add(resolveInputPath(value));
  if (args.sdk_root) roots.add(resolveInputPath(args.sdk_root));
  if (projectRoot) roots.add(projectRoot);
  return [...roots].filter((root) => root && existsSync(root));
}

function buildContextHeaderGrounding({ technologyId, workflow, roots, maxFiles }) {
  const technology = headerTechnologyForWorkflow(workflow, technologyId);
  return buildHeaderGrounding({
    roots: roots?.length ? roots : [],
    technology,
    max_files: maxFiles || 12000,
    include_snippets: false
  });
}

function headerTechnologyForWorkflow(workflow, technologyId) {
  if (technologyId === "rtx-video-sdk") return "rtx-video-sdk";
  if (technologyId === "video-codec-sdk") return "video-codec-sdk";
  if (technologyId === "reflex") return "reflex";
  if (technologyId === "rtx-kit") return "nrd";
  if (workflow === "ffmpeg-gstreamer" || workflow === "python-video") return "video-codec-sdk";
  if (workflow === "custom-cpp-renderer") return "dlss-streamline";
  return technologyId || workflow || "dlss-streamline";
}

function headerTechnologyForPhase3Workflow(workflow, technologyId) {
  const map = {
    "streamline-init-scaffold": "dlss-streamline",
    "d3d12-streamline-dlss-sr-kit": "dlss-streamline",
    "d3d12-dxr-raytracing-starter-kit": "rtx-kit",
    "nrd-denoiser-bridge-kit": "nrd",
    "cmake-sdk-wiring": "dlss-streamline",
    "video-codec-native-pipeline-kit": "video-codec-sdk",
    "video-codec-sample-adaptation": "video-codec-sdk",
    "rtx-video-native-pipeline-kit": "rtx-video-sdk",
    "rtx-video-pipeline-skeleton": "rtx-video-sdk",
    "reflex-marker-scaffold": "reflex",
    "nsight-marker-insertion": "dlss-streamline",
    "unreal-plugin-config-validation": technologyId || "dlss-streamline"
  };
  return map[workflow] || technologyId || "dlss-streamline";
}

function apiGenerationGate(headerGrounding, requiresHeaderGrounding) {
  if (!requiresHeaderGrounding) {
    return {
      status: "plan_only",
      code_output_mode: "plan_only_no_sdk_calls",
      reason: "This output is planning-only and does not generate SDK API calls."
    };
  }
  if (headerGrounding?.can_generate_real_api_guidance) {
    return {
      status: "header_grounded",
      code_output_mode: "header_grounded_observed_symbols_only",
      reason: "Required local header symbols were observed. Real API guidance may reference observed symbols only.",
      observed_symbol_sample: (headerGrounding.relevant_symbols || []).slice(0, 20)
    };
  }
  if (headerGrounding?.relevant_headers?.length) {
    return {
      status: "blocked_missing_symbols",
      code_output_mode: "template_only_no_real_sdk_calls",
      reason: `Relevant headers were found, but required symbols are missing: ${(headerGrounding.missing_required_symbols || []).join(", ") || "unknown"}.`,
      missing_required_symbols: headerGrounding.missing_required_symbols || []
    };
  }
  return {
    status: "template_only_no_headers",
    code_output_mode: "template_only_no_real_sdk_calls",
    reason: "No relevant local SDK headers were detected. Output must stay pseudocode/template only."
  };
}

function headerGroundedGuidance(items, apiGate, headerGrounding) {
  const prefix =
    apiGate.status === "header_grounded"
      ? [`Header-grounded: real SDK API guidance is limited to observed symbols such as ${(headerGrounding.relevant_symbols || []).slice(0, 8).join(", ") || "none"}.`]
      : [`Template-only: ${apiGate.reason} Do not name or call SDK functions until local headers satisfy the grounding gate.`];
  return [...prefix, ...(items || [])];
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
  if (context.headerGrounding && !context.headerGrounding.can_generate_real_api_guidance) {
    const missingSymbols = context.headerGrounding.missing_required_symbols || [];
    missing.push(
      missingSymbols.length
        ? `Local SDK headers for ${context.headerGrounding.technology} are missing required symbols: ${missingSymbols.join(", ")}.`
        : `Local SDK headers for ${context.headerGrounding.technology} were not detected; code output remains template-only.`
    );
  }
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
    sdk_roots: normalizeStringList(args.sdk_roots).length ? args.sdk_roots : args.sdk_root,
    target_workflow: phase2WorkflowForPhase3(args.workflow),
    max_files: args.max_files,
    include_evidence: args.include_evidence
  });
  const phase3Workflow = normalizePhase3Workflow(args.workflow, args.goal, context.project, context.primaryRoute);
  const phase3HeaderGrounding = buildContextHeaderGrounding({
    technologyId: context.technologyId,
    workflow: headerTechnologyForPhase3Workflow(phase3Workflow, context.technologyId),
    roots: headerGroundingRoots(args, context.root),
    maxFiles: args.max_files
  });
  return {
    ...context,
    phase3Workflow,
    headerGrounding: phase3HeaderGrounding,
    sdkRoot: args.sdk_root ? resolveInputPath(args.sdk_root) : null
  };
}

function phase2WorkflowForPhase3(workflow) {
  const map = {
    "unreal-plugin-config-validation": "unreal",
    "cmake-sdk-wiring": "custom-cpp-renderer",
    "streamline-init-scaffold": "custom-cpp-renderer",
    "d3d12-streamline-dlss-sr-kit": "custom-cpp-renderer",
    "d3d12-dxr-raytracing-starter-kit": "custom-cpp-renderer",
    "nrd-denoiser-bridge-kit": "custom-cpp-renderer",
    "video-codec-native-pipeline-kit": "ffmpeg-gstreamer",
    "video-codec-sample-adaptation": "ffmpeg-gstreamer",
    "rtx-video-native-pipeline-kit": "ffmpeg-gstreamer",
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
    "d3d12-streamline-dlss-sr-kit",
    "d3d12-dxr-raytracing-starter-kit",
    "nrd-denoiser-bridge-kit",
    "video-codec-native-pipeline-kit",
    "video-codec-sample-adaptation",
    "rtx-video-native-pipeline-kit",
    "rtx-video-pipeline-skeleton",
    "nsight-marker-insertion",
    "reflex-marker-scaffold"
  ]);
  if (allowed.has(explicit)) return explicit;

  const text = lower(`${goal}\n${primaryRoute?.technology_id || ""}\n${JSON.stringify(project || {})}`);
  if (matchesAny(text, ["unreal", ".uproject", "ue5", "ue 5"])) return "unreal-plugin-config-validation";
  if (matchesAny(text, ["cmake", "include path", "lib path", "library path", "sdk wiring", "build setup"])) return "cmake-sdk-wiring";
  if (matchesAny(text, ["dlss sr", "dlss super resolution", "d3d12 streamline dlss", "dlaa", "super resolution kit"])) return "d3d12-streamline-dlss-sr-kit";
  if (matchesAny(text, ["nrd", "denoiser", "denois", "reblur", "relax", "sigma"])) return "nrd-denoiser-bridge-kit";
  if (matchesAny(text, ["dxr", "ray tracing", "raytracing", "ray-traced", "ray traced", "tlas", "blas", "shader binding table", "sbt"])) return "d3d12-dxr-raytracing-starter-kit";
  if (matchesAny(text, ["rtx video", "rtx video sdk", "video enhancement", "native media", "media player", "super resolution", "artifact reduction", "sdr-to-hdr", "sdr to hdr"])) return "rtx-video-native-pipeline-kit";
  if (matchesAny(text, ["video codec", "nvenc", "nvdec", "ffmpeg", "gstreamer", "pynvvideocodec", "transcode", "decode", "encode"])) return "video-codec-native-pipeline-kit";
  if (matchesAny(text, ["nsight", "gpu marker", "debug marker", "profile marker", "capture marker"])) return "nsight-marker-insertion";
  if (matchesAny(text, ["reflex", "latency", "click-to-photon", "input lag"])) return "reflex-marker-scaffold";
  if (matchesAny(text, ["streamline", "dlss", "renderer", "d3d12"])) return "d3d12-streamline-dlss-sr-kit";
  if (matchesAny(text, ["frame generation", "ray reconstruction", "vulkan"])) return "streamline-init-scaffold";

  if (primaryRoute?.technology_id === "unreal-dlss-plugin") return "unreal-plugin-config-validation";
  if (primaryRoute?.technology_id === "rtx-video-sdk") return "rtx-video-native-pipeline-kit";
  if (primaryRoute?.technology_id === "video-codec-sdk") return "video-codec-native-pipeline-kit";
  if (primaryRoute?.technology_id === "reflex") return "reflex-marker-scaffold";
  if (primaryRoute?.technology_id === "nsight-aftermath") return "nsight-marker-insertion";
  if (primaryRoute?.technology_id === "rtx-kit" && matchesAny(text, ["nrd", "denoiser", "denois", "reblur", "relax", "sigma"])) return "nrd-denoiser-bridge-kit";
  if (primaryRoute?.technology_id === "rtx-kit" && matchesAny(text, ["dxr", "ray tracing", "raytracing"])) return "d3d12-dxr-raytracing-starter-kit";
  return "streamline-init-scaffold";
}

function phase3ImplementationPackage(context, args) {
  const baseValidation = validationSteps(context.technologyId, true);
  const apiGate = apiGenerationGate(context.headerGrounding, true);
  const common = {
    write_mode: args.write_files === true ? "approved_create_new_scaffold_files" : "preview_only",
    generated_files_are_create_only: true,
    existing_repo_edits_are_described_not_applied: true,
    approval_token_required_for_writes: "APPROVED_PHASE_3_EDITS",
    code_output_mode: apiGate.code_output_mode,
    api_generation_gate: apiGate,
    header_grounding: context.headerGrounding,
    header_grounding_policy:
      apiGate.status === "header_grounded"
        ? "Real SDK API guidance may reference observed local header symbols only."
        : "Generated files are pseudocode/template scaffolds only and must not contain real SDK calls."
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
    "d3d12-streamline-dlss-sr-kit": () => d3d12StreamlineDlssSrKit(context, apiGate, baseValidation),
    "d3d12-dxr-raytracing-starter-kit": () => d3d12DxrRayTracingStarterKit(context, baseValidation),
    "nrd-denoiser-bridge-kit": () => nrdDenoiserBridgeKit(context, apiGate, baseValidation),
    "video-codec-native-pipeline-kit": () => videoCodecNativePipelineKit(context, apiGate, baseValidation),
    "video-codec-sample-adaptation": () => videoCodecNativePipelineKit(context, apiGate, baseValidation),
    "rtx-video-native-pipeline-kit": () => rtxVideoNativePipelineKit(context, apiGate, baseValidation),
    "rtx-video-pipeline-skeleton": () => rtxVideoNativePipelineKit(context, apiGate, baseValidation),
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

function d3d12StreamlineDlssSrKit(context, apiGate, baseValidation) {
  const readiness = d3d12StreamlineReadiness(context, apiGate);
  const validationHarness = d3d12StreamlineValidationHarness(readiness);
  return {
    summary: "Create a gated D3D12 Streamline DLSS Super Resolution / DLAA adapter kit with header-grounded API probes, build wiring, host-resource TODO boundaries, and validation harness guidance.",
    implementation_readiness: readiness,
    build_system_detection: readiness.build_system_detection,
    validation_harness: validationHarness,
    files: [
      scaffoldFile(
        "src/nvidia/streamline/DlssTypes.h",
        "cpp",
        "Thin value types for DLSS SR/DLAA quality settings, feature support, and per-frame host renderer inputs.",
        d3d12DlssTypesHeader()
      ),
      scaffoldFile(
        "src/nvidia/streamline/NvidiaStreamlineBridge.h",
        "cpp",
        "D3D12 Streamline bridge interface for DLSS SR/DLAA support checks and per-frame evaluation boundaries.",
        d3d12StreamlineBridgeHeader()
      ),
      scaffoldFile(
        "src/nvidia/streamline/NvidiaStreamlineBridge.cpp",
        "cpp",
        "Header-grounded D3D12 Streamline bridge implementation shell. Real SDK symbol probes are emitted only when local headers pass the grounding gate.",
        d3d12StreamlineBridgeCpp(apiGate, readiness)
      ),
      scaffoldFile(
        "cmake/NvidiaStreamlineDlss.cmake",
        "cmake",
        "CMake wiring for user-provided Streamline SDK include/lib paths.",
        d3d12StreamlineCmakeWiring()
      ),
      scaffoldFile(
        "build/NvidiaStreamlineDlss.props",
        "xml",
        "MSBuild property sheet for user-provided Streamline SDK include/lib paths.",
        d3d12StreamlineMsbuildProps()
      ),
      scaffoldFile(
        "docs/nvidia/d3d12-streamline-dlss-sr-dlaa-kit.md",
        "markdown",
        "Validation and integration checklist for the D3D12 Streamline DLSS SR/DLAA kit.",
        d3d12StreamlineKitNotes(readiness, validationHarness)
      )
    ],
    host_repo_edits_required: [
      "Add the generated NvidiaStreamlineBridge.cpp and DlssTypes.h files to the narrow D3D12 renderer target after review.",
      "Wire the generated CMake include or MSBuild props into the renderer build only after setting a local, license-approved Streamline SDK root.",
      "Map host renderer resources explicitly: color, depth, motion vectors, jitter, exposure, reset, command list, and command queue.",
      "Call runtime feature-support queries before exposing DLSS SR or DLAA UI.",
      "Keep runtime DLL/shared-library placement and redistribution checks in a separate license-reviewed patch."
    ],
    validation_plan: mergePlan(baseValidation, [
      "Configure and compile the bridge with the generated CMake or MSBuild wiring.",
      "Verify the compile-time Streamline symbol probes against the selected local SDK headers.",
      "Run a runtime support query before enabling DLSS SR or DLAA.",
      "Capture Streamline logs from the configured app-local log directory.",
      "Capture a representative D3D12 frame in Nsight Graphics after resource boundaries are mapped."
    ]),
    rollback_plan: rollbackPlan("Remove the generated src/nvidia/streamline files, remove the CMake include or MSBuild props import, and leave the existing renderer path untouched."),
    sources: sourceRefs(["nvidia-dlss", "nvidia-streamline-page", "streamline-programming-guide", "streamline-releases", "nsight-graphics"])
  };
}

function d3d12StreamlineReadiness(context, apiGate) {
  const project = context.project || {};
  const graphicsApis = project.graphics_apis || [];
  const languages = project.languages || [];
  const buildSystems = project.build_systems || [];
  const isD3d12 = graphicsApis.includes("D3D12");
  const isCpp = languages.some((language) => /C\/C\+\+|C\+\+|C\/C/i.test(language));
  const buildSystemDetection = {
    cmake: buildSystems.includes("CMake"),
    msbuild: buildSystems.includes("MSBuild/Visual Studio"),
    detected: buildSystems.filter((item) => /CMake|MSBuild|Visual Studio/i.test(item)),
    state: buildSystems.some((item) => /CMake|MSBuild|Visual Studio/i.test(item)) ? "supported_build_system_detected" : "build_system_unknown"
  };
  const headers = context.headerGrounding || {};
  const hasStreamlineHeaders = Boolean(headers.relevant_headers?.length);
  const blockers = [];
  if (!context.root) blockers.push("project_path is required to detect a custom D3D12 C++ renderer.");
  if (!isCpp) blockers.push("C/C++ renderer source was not detected.");
  if (!isD3d12) blockers.push("D3D12 evidence was not detected.");
  if (!hasStreamlineHeaders) blockers.push("Local or project-vendored Streamline SDK headers were not detected.");
  if (hasStreamlineHeaders && !headers.can_generate_real_api_guidance) {
    blockers.push(`Streamline headers were detected but required symbols are missing: ${(headers.missing_required_symbols || []).join(", ") || "unknown"}.`);
  }

  let state = "header_grounded_adapter_ready";
  if (!context.root || !isCpp || !isD3d12) state = "rejected_not_custom_d3d12_renderer";
  else if (!hasStreamlineHeaders) state = "blocked_missing_streamline_sdk";
  else if (!headers.can_generate_real_api_guidance) state = "limited_missing_required_symbols";
  else if (buildSystemDetection.state === "build_system_unknown") state = "header_grounded_build_system_unknown";

  return {
    state,
    real_api_implementation_allowed: state === "header_grounded_adapter_ready" || state === "header_grounded_build_system_unknown",
    project_root: context.root,
    custom_renderer_detection: {
      d3d12_detected: isD3d12,
      cpp_detected: isCpp,
      graphics_apis: graphicsApis,
      languages,
      relevant_files: selectRelevantFiles(context.inventory, "custom-cpp-renderer").slice(0, 20)
    },
    build_system_detection: buildSystemDetection,
    streamline_sdk_requirement: {
      state: hasStreamlineHeaders ? "sdk_headers_detected" : "sdk_path_required",
      detected_sdk_root: headers.detected_sdk_root || null,
      detected_version: headers.detected_version || null,
      required_symbols: headers.required_symbols || [],
      missing_required_symbols: headers.missing_required_symbols || [],
      confidence_level: headers.confidence_level || "none"
    },
    host_resource_todo_boundaries: [
      "color",
      "depth",
      "motion vectors",
      "jitter",
      "exposure",
      "reset",
      "command list",
      "command queue"
    ],
    blockers,
    unsafe_assumptions_rejected: [
      "No DLSS SR/DLAA runtime support is claimed from static headers alone.",
      "No Streamline SDK function signature is guessed.",
      "No Frame Generation or Multi Frame Generation path is generated in this kit.",
      "No NVIDIA binaries are copied, packaged, downloaded, or redistributed."
    ]
  };
}

function d3d12StreamlineValidationHarness(readiness) {
  const sdkRoot = readiness.streamline_sdk_requirement.detected_sdk_root || "<STREAMLINE_SDK_ROOT>";
  return {
    compile_commands: [
      `cmake -S . -B build -DNVIDIA_STREAMLINE_SDK_ROOT="${sdkRoot}" -DNVIDIA_STREAMLINE_ENABLE_REAL_API=ON`,
      "cmake --build build --config RelWithDebInfo",
      `msbuild <YourRenderer>.sln /p:NvidiaStreamlineSdkRoot="${sdkRoot}" /p:NvidiaStreamlineEnableRealApi=true /p:Configuration=RelWithDebInfo`
    ],
    runtime_support_query_checklist: [
      "Start with DLSS SR/DLAA disabled in UI/config.",
      "Initialize the bridge only after the D3D12 device and command queue are valid.",
      "Check the selected GPU, driver, OS, graphics API, Streamline SDK version, and feature requirement result before exposing DLSS SR or DLAA.",
      "Reject runtime enablement if color, depth, motion vectors, jitter, exposure, reset, command list, or command queue mapping is incomplete.",
      "Record the exact SDK root, header version clues, executable build config, GPU, driver, and D3D12 backend."
    ],
    streamline_log_path: {
      configured_app_log_directory: "logs/nvidia/streamline/",
      note: "Use the bridge InitDesc logDirectory as the app-owned Streamline log/capture location. Do not assume a global default log path."
    },
    nsight_capture_checklist: [
      "Capture a representative gameplay/render frame after DLSS SR/DLAA resource boundaries are mapped.",
      "Verify color, depth, motion vector, jitter, exposure, reset, command list, and command queue timing in the frame/capture notes.",
      "Confirm the upscaler pass is placed after opaque rendering and before post/UI composition according to the host renderer design.",
      "Save the Nsight capture path and exact scene/repro steps as local artifacts only."
    ]
  };
}

function d3d12DxrRayTracingStarterKit(context, baseValidation) {
  const readiness = d3d12DxrReadiness(context);
  const validationChecklist = d3d12DxrValidationChecklist(readiness);
  return {
    summary: "Create a gated D3D12 DXR starter kit for basic ray-traced shadows/reflections planning, adapter scaffolds, HLSL templates, and validation checklists.",
    implementation_readiness: readiness,
    contract_checks: readiness.contract_checks,
    build_system_detection: readiness.build_system_detection,
    validation_checklist: validationChecklist,
    files: [
      scaffoldFile("src/nvidia/dxr/RtxRayTracingContext.h", "cpp", "D3D12 DXR feature-query and context contract.", rtxRayTracingContextHeader()),
      scaffoldFile("src/nvidia/dxr/RtxRayTracingContext.cpp", "cpp", "D3D12 DXR context shell with feature query and fallback gates.", rtxRayTracingContextCpp()),
      scaffoldFile("src/nvidia/dxr/AccelerationStructureBuilder.h", "cpp", "BLAS/TLAS build contract for host mesh and instance data.", accelerationStructureBuilderHeader()),
      scaffoldFile("src/nvidia/dxr/AccelerationStructureBuilder.cpp", "cpp", "Acceleration structure builder shell with explicit host data TODOs.", accelerationStructureBuilderCpp()),
      scaffoldFile("src/nvidia/dxr/ShaderBindingTableBuilder.h", "cpp", "Shader Binding Table layout contract for raygen, miss, and hit groups.", shaderBindingTableBuilderHeader()),
      scaffoldFile("src/nvidia/dxr/ShaderBindingTableBuilder.cpp", "cpp", "Shader Binding Table builder shell with record-size validation.", shaderBindingTableBuilderCpp()),
      scaffoldFile("src/nvidia/dxr/RayTracingPass.h", "cpp", "Basic ray-traced shadows/reflections pass contract.", rayTracingPassHeader()),
      scaffoldFile("src/nvidia/dxr/RayTracingPass.cpp", "cpp", "RayTracingPass shell with feature, TLAS, shader, and fallback gates.", rayTracingPassCpp()),
      scaffoldFile("shaders/nvidia/dxr/RayTracingCommon.hlsl", "hlsl", "Shared DXR payload, attributes, constants, and resources.", rayTracingCommonHlsl()),
      scaffoldFile("shaders/nvidia/dxr/RayTracingRaygen.hlsl", "hlsl", "Ray generation shader template for first visible ray pass.", rayTracingRaygenHlsl()),
      scaffoldFile("shaders/nvidia/dxr/RayTracingMiss.hlsl", "hlsl", "Miss shader template for fallback sky/visibility behavior.", rayTracingMissHlsl()),
      scaffoldFile("shaders/nvidia/dxr/RayTracingClosestHit.hlsl", "hlsl", "Closest-hit shader template for material/G-buffer-aware hit shading.", rayTracingClosestHitHlsl()),
      scaffoldFile("cmake/NvidiaDxrRayTracing.cmake", "cmake", "CMake wiring for the DXR starter adapter and HLSL shader templates.", d3d12DxrCmakeWiring()),
      scaffoldFile("docs/nvidia/d3d12-dxr-raytracing-starter-kit.md", "markdown", "Validation checklist and integration boundaries for the D3D12 DXR starter kit.", d3d12DxrStarterKitNotes(readiness, validationChecklist))
    ],
    host_repo_edits_required: [
      "Add the generated src/nvidia/dxr C++ files to the D3D12 renderer target only after reviewing the patch plan.",
      "Add the generated HLSL files to the existing shader compilation pipeline or DXC build step.",
      "Map host mesh, instance, material, G-buffer, render graph, and fallback resources explicitly before enabling the pass.",
      "Insert RayTracingPass at a reviewed render graph point for basic shadows/reflections only.",
      "Keep RTXDI, NRD, and full path tracing as separate future implementation kits."
    ],
    validation_plan: mergePlan(baseValidation, validationChecklist.required_steps),
    rollback_plan: rollbackPlan("Remove the generated src/nvidia/dxr files, shader templates, and CMake include/import. Leave the original raster render path untouched."),
    sources: sourceRefs(["rtx-kit", "nsight-graphics", "nsight-graphics-2025-2"])
  };
}

function d3d12DxrReadiness(context) {
  const project = context.project || {};
  const graphicsApis = project.graphics_apis || [];
  const languages = project.languages || [];
  const buildSystems = project.build_systems || [];
  const isD3d12 = graphicsApis.includes("D3D12");
  const isCpp = languages.some((language) => /C\/C\+\+|C\+\+|C\/C/i.test(language));
  const buildSystemDetection = {
    cmake: buildSystems.includes("CMake"),
    msbuild: buildSystems.includes("MSBuild/Visual Studio"),
    detected: buildSystems.filter((item) => /CMake|MSBuild|Visual Studio/i.test(item)),
    state: buildSystems.some((item) => /CMake|MSBuild|Visual Studio/i.test(item)) ? "supported_build_system_detected" : "build_system_unknown"
  };
  const checks = {
    d3d12_device_feature_level: dxrEvidenceCheck(context.inventory, "d3d12_device_feature_level", "D3D12 feature-level or ray tracing feature-tier query path.", ["D3D_FEATURE_LEVEL_12_1", "D3D_FEATURE_LEVEL_12_2", "D3D12_FEATURE_D3D12_OPTIONS5", "D3D12_RAYTRACING_TIER", "raytracing feature tier", "ray tracing feature tier"]),
    dxr_capable_api_usage: dxrEvidenceCheck(context.inventory, "dxr_capable_api_usage", "DXR-capable D3D12 API usage.", ["ID3D12Device5", "D3D12_RAYTRACING", "DispatchRays", "TraceRay", "D3D12_DISPATCH_RAYS_DESC", "D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC"]),
    shader_compilation_path: dxrEvidenceCheck(context.inventory, "shader_compilation_path", "HLSL/DXIL/DXC shader compilation path.", ["hlsl", "dxil", "dxc", "shader compiler", "RayTracing.hlsl"]),
    mesh_instance_data_access: dxrEvidenceCheck(context.inventory, "mesh_instance_data_access", "Mesh and instance data for BLAS/TLAS.", ["mesh", "instance", "vertex buffer", "index buffer", "mesh instance data"]),
    render_graph_insertion_point: dxrEvidenceCheck(context.inventory, "render_graph_insertion_point", "Render graph or pass insertion point.", ["render graph", "render pass", "ray tracing pass"]),
    gbuffer_material_data_access: dxrEvidenceCheck(context.inventory, "gbuffer_material_data_access", "G-buffer and material data for hit shading/composition.", ["gbuffer", "g-buffer", "material", "albedo", "roughness", "normal buffer"]),
    fallback_path: dxrEvidenceCheck(context.inventory, "fallback_path", "Raster or non-ray-tracing fallback path.", ["fallback", "raster", "disable ray tracing"])
  };
  const failedChecks = Object.values(checks).filter((check) => check.status !== "pass");
  const blockers = [];
  if (!context.root) blockers.push("project_path is required to detect a custom D3D12 DXR renderer.");
  if (!isCpp) blockers.push("C/C++ renderer source was not detected.");
  if (!isD3d12) blockers.push("D3D12 evidence was not detected.");
  if (buildSystemDetection.state === "build_system_unknown") blockers.push("CMake or MSBuild build-system evidence was not detected.");
  blockers.push(...failedChecks.map((check) => check.blocker));

  let state = "dxr_starter_kit_ready";
  if (!context.root || !isCpp || !isD3d12) state = "rejected_not_custom_d3d12_renderer";
  else if (failedChecks.length || buildSystemDetection.state === "build_system_unknown") state = "blocked_missing_dxr_readiness";

  return {
    state,
    starter_kit_generation_allowed: state === "dxr_starter_kit_ready",
    project_root: context.root,
    custom_renderer_detection: {
      d3d12_detected: isD3d12,
      cpp_detected: isCpp,
      graphics_apis: graphicsApis,
      languages,
      relevant_files: selectRelevantFiles(context.inventory, "custom-cpp-renderer").slice(0, 24)
    },
    build_system_detection: buildSystemDetection,
    contract_checks: checks,
    blockers: [...new Set(blockers.filter(Boolean))],
    scoped_features: [
      "basic ray-traced shadows",
      "basic ray-traced reflections",
      "first visible ray pass",
      "fallback-preserving render graph insertion"
    ],
    explicitly_out_of_scope: [
      "RTXDI full integration",
      "NRD full integration",
      "full path tracer",
      "renderer-wide material-system rewrite",
      "automatic render graph edits without approval"
    ],
    unsafe_assumptions_rejected: [
      "No runtime ray tracing support is claimed from static source evidence alone.",
      "No acceleration-structure ownership is assumed without mesh and instance data access.",
      "No invasive host renderer edits are performed by this kit.",
      "No RTXDI, NRD, or full path-tracing implementation is generated."
    ]
  };
}

function dxrEvidenceCheck(inventory, id, description, tokens) {
  const text = inventoryText(inventory);
  const matched = tokens.filter((token) => text.includes(lower(token)));
  return {
    id,
    description,
    status: matched.length ? "pass" : "fail",
    matched_tokens: matched,
    required_tokens_any: tokens,
    blocker: matched.length ? null : `Missing DXR readiness evidence: ${description}`
  };
}

function d3d12DxrValidationChecklist(readiness) {
  return {
    required_steps: [
      "Run a D3D12 feature query for ray tracing support before enabling the mode.",
      "Build BLAS/TLAS for a representative scene and record success/failure.",
      "Compile raygen, miss, and closest-hit shaders through the project shader compiler path.",
      "Render a first visible ray-traced shadows/reflections pass with a fallback toggle.",
      "Capture the pass in Nsight Graphics and verify acceleration structure, SBT, DispatchRays, and output resources.",
      "Validate the raster fallback remains available and selected when DXR support is missing."
    ],
    feature_query: ["D3D12 feature level", "D3D12 ray tracing tier", "device/interface used for DispatchRays"],
    tlas_blas_build: ["BLAS inputs from vertex/index buffers", "TLAS instance data", "scratch/result buffer lifetime", "barrier/synchronization plan"],
    shader_compile: ["DXC/HLSL path", "DXIL library", "raygen/miss/closest-hit exports", "root signature association"],
    first_ray_pass_visible: ["known scene", "known light/reflection target", "debug output texture", "fallback toggle"],
    nsight_capture: ["capture path", "scene/repro", "DispatchRays event", "acceleration structures", "shader binding table"],
    fallback_path: ["disable ray tracing setting", "raster shadow/reflection fallback", "unsupported GPU behavior"]
  };
}

function nrdDenoiserBridgeKit(context, apiGate, baseValidation) {
  const readiness = nrdDenoiserReadiness(context, apiGate);
  const validationChecklist = nrdValidationChecklist(readiness);
  return {
    summary: "Create a gated NRD denoiser bridge for noisy ray-traced diffuse/specular/shadow signals with explicit guide-buffer contracts, SDK/header gating, and ReBLUR/ReLAX/SIGMA validation checklists.",
    implementation_readiness: readiness,
    contract_checks: readiness.contract_checks,
    build_system_detection: readiness.build_system_detection,
    validation_checklist: validationChecklist,
    files: [
      scaffoldFile("src/nvidia/nrd/NrdFrameInputs.h", "cpp", "NRD signal enum, frame-input contract, guide-buffer contract, and validation result types.", nrdFrameInputsHeader()),
      scaffoldFile("src/nvidia/nrd/NrdDenoiserBridge.h", "cpp", "NRD bridge interface for selecting denoiser methods and validating per-frame inputs.", nrdDenoiserBridgeHeader()),
      scaffoldFile("src/nvidia/nrd/NrdDenoiserBridge.cpp", "cpp", "NRD bridge shell with SDK include gate, input validation, and no guessed NRD API calls.", nrdDenoiserBridgeCpp(apiGate, readiness)),
      scaffoldFile("cmake/NvidiaNrdDenoiser.cmake", "cmake", "CMake wiring for a user-provided NRD SDK include root and the generated bridge.", nrdCmakeWiring()),
      scaffoldFile("docs/nvidia/nrd-denoiser-bridge-kit.md", "markdown", "Validation checklist and integration boundaries for ReBLUR/ReLAX/SIGMA readiness.", nrdDenoiserBridgeNotes(readiness, validationChecklist))
    ],
    host_repo_edits_required: [
      "Add the generated src/nvidia/nrd bridge files to the narrow ray tracing renderer target only after review.",
      "Wire the generated CMake include only after setting a local, license-approved NRD SDK root or leaving template mode explicit.",
      "Map host renderer resources explicitly: noisy diffuse/specular/shadow signal, normals, roughness, viewZ/depth, motion vectors, camera matrices, render resolution, and temporal reset.",
      "Select ReBLUR, ReLAX, SIGMA, or a project-specific mode based on the actual noisy signal type and local NRD SDK documentation.",
      "Keep ray tracing pass generation, NRD denoising bridge wiring, and quality validation as separate reviewable changes."
    ],
    validation_plan: mergePlan(baseValidation, validationChecklist.required_steps),
    rollback_plan: rollbackPlan("Remove the generated src/nvidia/nrd files and CMake include/import. Leave the original noisy ray-traced or raster fallback path untouched."),
    sources: sourceRefs(["rtx-kit", "nsight-graphics", "nsight-graphics-2025-2"])
  };
}

function nrdDenoiserReadiness(context, apiGate) {
  const project = context.project || {};
  const graphicsApis = project.graphics_apis || [];
  const languages = project.languages || [];
  const buildSystems = project.build_systems || [];
  const isRealtimeCpp = languages.some((language) => /C\/C\+\+|C\+\+|C\/C/i.test(language));
  const hasSupportedApi = graphicsApis.includes("D3D12") || graphicsApis.includes("Vulkan");
  const buildSystemDetection = {
    cmake: buildSystems.includes("CMake"),
    msbuild: buildSystems.includes("MSBuild/Visual Studio"),
    detected: buildSystems.filter((item) => /CMake|MSBuild|Visual Studio/i.test(item)),
    state: buildSystems.some((item) => /CMake|MSBuild|Visual Studio/i.test(item)) ? "supported_build_system_detected" : "build_system_unknown"
  };
  const headers = context.headerGrounding || {};
  const hasNrdHeaders = Boolean(headers.relevant_headers?.length);
  const checks = {
    noisy_signals: nrdEvidenceCheck(context.inventory, "noisy_signals", "Noisy diffuse, specular, shadow, occlusion, or ray-traced radiance signal.", ["noisy diffuse", "noisy specular", "shadow signal", "occlusion signal", "ray traced radiance", "ray-traced radiance"]),
    normals: nrdEvidenceCheck(context.inventory, "normals", "Surface normal buffer.", ["normal buffer", "normals", "normal"]),
    roughness: nrdEvidenceCheck(context.inventory, "roughness", "Surface roughness or material roughness buffer.", ["roughness", "normal roughness", "material roughness"]),
    viewz_depth: nrdEvidenceCheck(context.inventory, "viewz_depth", "ViewZ or depth input.", ["viewz", "view z", "depth buffer", "linear depth", "depth"]),
    motion_vectors: nrdEvidenceCheck(context.inventory, "motion_vectors", "Motion vectors for temporal denoising.", ["motion vector", "motion vectors", "velocity buffer"]),
    camera_matrices: nrdEvidenceCheck(context.inventory, "camera_matrices", "Current and previous camera matrices.", ["camera matrix", "camera matrices", "previous view", "previous projection", "view projection"]),
    render_resolution: nrdEvidenceCheck(context.inventory, "render_resolution", "Render resolution for NRD dispatch sizing and history management.", ["render resolution", "resolution", "viewport", "width", "height"]),
    temporal_reset_state: nrdEvidenceCheck(context.inventory, "temporal_reset_state", "Temporal reset state for camera cuts, history invalidation, and resolution changes.", ["temporal reset", "reset", "camera cut", "history invalidation", "resolution change"])
  };
  const failedChecks = Object.values(checks).filter((check) => check.status !== "pass");
  const blockers = [];
  if (!context.root) blockers.push("project_path is required to detect a custom renderer that can host NRD.");
  if (!isRealtimeCpp) blockers.push("C/C++ renderer source was not detected.");
  if (!hasSupportedApi) blockers.push("D3D12 or Vulkan renderer evidence was not detected.");
  if (buildSystemDetection.state === "build_system_unknown") blockers.push("CMake or MSBuild build-system evidence was not detected.");
  blockers.push(...failedChecks.map((check) => check.blocker));
  if (!hasNrdHeaders) blockers.push("Local or project-vendored NRD SDK headers were not detected; bridge output is official-source-backed template mode only.");
  if (hasNrdHeaders && !headers.can_generate_real_api_guidance) {
    blockers.push(`NRD headers were detected but required symbols are missing: ${(headers.missing_required_symbols || []).join(", ") || "unknown"}.`);
  }

  let state = "nrd_bridge_ready";
  if (!context.root || !isRealtimeCpp || !hasSupportedApi) state = "rejected_not_custom_realtime_renderer";
  else if (failedChecks.length) state = "blocked_missing_nrd_frame_inputs";
  else if (!hasNrdHeaders) state = "blocked_missing_nrd_sdk_template_only";
  else if (!headers.can_generate_real_api_guidance) state = "limited_missing_nrd_symbols_template_only";
  else if (buildSystemDetection.state === "build_system_unknown") state = "header_grounded_build_system_unknown";

  return {
    state,
    bridge_generation_allowed: state !== "rejected_not_custom_realtime_renderer" && state !== "blocked_missing_nrd_frame_inputs",
    real_nrd_api_calls_allowed: state === "nrd_bridge_ready" || state === "header_grounded_build_system_unknown",
    denoising_working_claim_allowed: false,
    denoising_working_claim_blocker: "This kit only proves bridge/readiness scaffolding. Denoising can be claimed only after project buffers are mapped, the bridge compiles against local NRD headers, and runtime validation artifacts exist.",
    bridge_generation_mode:
      hasNrdHeaders && headers.can_generate_real_api_guidance
        ? "header_grounded_bridge_adapters"
        : "official_source_backed_template_only_no_sdk_calls",
    project_root: context.root,
    custom_renderer_detection: {
      supported_api_detected: hasSupportedApi,
      cpp_detected: isRealtimeCpp,
      graphics_apis: graphicsApis,
      languages,
      relevant_files: selectRelevantFiles(context.inventory, "custom-cpp-renderer").slice(0, 24)
    },
    build_system_detection: buildSystemDetection,
    nrd_sdk_requirement: {
      state: hasNrdHeaders ? "sdk_headers_detected" : "sdk_path_required_or_template_only",
      detected_sdk_root: headers.detected_sdk_root || null,
      detected_version: headers.detected_version || null,
      required_symbols: headers.required_symbols || [],
      missing_required_symbols: headers.missing_required_symbols || [],
      relevant_headers: headers.relevant_headers || [],
      confidence_level: headers.confidence_level || "none",
      api_generation_gate_status: apiGate.status
    },
    contract_checks: checks,
    required_frame_inputs: [
      "noisy diffuse/specular/shadow signal",
      "normals",
      "roughness",
      "viewZ/depth",
      "motion vectors",
      "camera matrices",
      "render resolution",
      "temporal reset state"
    ],
    blockers: [...new Set(blockers.filter(Boolean))],
    unsafe_assumptions_rejected: [
      "No denoising success is claimed from static source evidence.",
      "No NRD SDK function signature is guessed.",
      "No bridge output claims to work without noisy signals and guide buffers.",
      "No temporal denoiser is enabled without motion vectors and reset behavior.",
      "No RTXDI, full NRD integration, or full path tracing implementation is generated."
    ]
  };
}

function nrdEvidenceCheck(inventory, id, description, tokens) {
  const text = inventoryText(inventory);
  const matched = tokens.filter((token) => text.includes(lower(token)));
  return {
    id,
    description,
    status: matched.length ? "pass" : "fail",
    matched_tokens: matched,
    required_tokens_any: tokens,
    blocker: matched.length ? null : `Missing NRD readiness evidence: ${description}`
  };
}

function nrdValidationChecklist(readiness) {
  return {
    required_steps: [
      "Classify the noisy signal before selecting ReBLUR, ReLAX, SIGMA, or a project-specific denoiser path.",
      "Validate normals, roughness, viewZ/depth, motion vectors, camera matrices, render resolution, and temporal reset are available for every denoised frame.",
      "Compile the bridge against the local NRD SDK headers or keep the bridge in explicit template-only mode.",
      "Run a first before/after denoising capture only after the noisy signal and guide buffers are mapped.",
      "Test temporal reset behavior for camera cuts, disocclusion-heavy scenes, resolution changes, and history invalidation.",
      "Capture the denoising pass in Nsight Graphics and preserve the non-denoised fallback path."
    ],
    reblur_readiness: [
      "Noisy diffuse or specular lighting signal is identified.",
      "Normal, roughness, viewZ/depth, motion vectors, camera matrices, render resolution, and reset state are mapped.",
      "History reset is triggered for camera cuts and resolution changes."
    ],
    relax_readiness: [
      "Noisy diffuse/specular signal is identified and separated from UI/post effects.",
      "Temporal guide buffers and camera state are available before denoiser evaluation.",
      "Before/after quality capture is planned with stable scene/repro steps."
    ],
    sigma_readiness: [
      "Noisy shadow signal or visibility signal is identified.",
      "Depth/viewZ, normals, motion vectors, render resolution, and reset state are mapped.",
      "Fallback shadow path remains available when NRD or required buffers are unavailable."
    ],
    artifacts_required_before_claiming_working: [
      "Compile log for the bridge against the selected local SDK/header mode.",
      "Frame capture showing noisy input, guide buffers, denoised output, and fallback toggle.",
      "Local notes with GPU, driver, SDK/header root, render resolution, and scene/repro."
    ]
  };
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
  if (context.phase3Workflow === "d3d12-streamline-dlss-sr-kit" && !context.headerGrounding?.detected_sdk_root) {
    missing.push("Local Streamline SDK root or project-vendored Streamline headers for DLSS SR/DLAA implementation.");
  }
  if (context.phase3Workflow === "nrd-denoiser-bridge-kit" && !context.headerGrounding?.detected_sdk_root) {
    missing.push("Local NRD SDK root or project-vendored NRD headers for header-grounded denoiser bridge work; otherwise output stays official-source-backed template-only.");
  }
  if (["rtx-video-native-pipeline-kit", "rtx-video-pipeline-skeleton"].includes(context.phase3Workflow) && !context.headerGrounding?.detected_sdk_root) {
    missing.push("Local RTX Video SDK root or project-vendored RTX Video headers for real native media enhancement; otherwise output stays template-only.");
  }
  if (["video-codec-native-pipeline-kit", "video-codec-sample-adaptation"].includes(context.phase3Workflow) && !context.headerGrounding?.detected_sdk_root) {
    missing.push("Local Video Codec SDK root or project-vendored nvEncodeAPI/nvcuvid headers for real NVENC/NVDEC adapter work; FFmpeg/GStreamer/PyNvVideoCodec command plans remain plan-only.");
  }
  if (!context.sdkRoot && !context.sdkRoots?.length && ["cmake-sdk-wiring", "streamline-init-scaffold", "d3d12-streamline-dlss-sr-kit", "nrd-denoiser-bridge-kit", "video-codec-native-pipeline-kit", "video-codec-sample-adaptation", "rtx-video-native-pipeline-kit", "rtx-video-pipeline-skeleton"].includes(context.phase3Workflow)) {
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
    "scripts/tests/test-skill-usability.ps1",
    "scripts/tests/test-assisted-implementation.ps1",
    "scripts/tests/test-validation-automation.ps1",
    "scripts/tests/test-implementation-contracts.ps1",
    "scripts/tests/test-implementation-readiness-report.ps1",
    "scripts/tests/test-header-grounded-generation.ps1",
    "scripts/tests/test-unreal-dlss-validation.ps1",
    "scripts/tests/test-unity-hdrp-validation.ps1",
    "scripts/tests/test-d3d12-streamline-dlss-kit.ps1",
    "scripts/tests/test-d3d12-dxr-raytracing-kit.ps1",
    "scripts/tests/test-nrd-denoiser-bridge-kit.ps1",
    "scripts/tests/test-rtx-video-native-pipeline-kit.ps1",
    "scripts/tests/test-video-codec-native-pipeline-kit.ps1",
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

function d3d12DlssTypesHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "struct ID3D12CommandQueue;",
    "struct ID3D12GraphicsCommandList;",
    "struct ID3D12Resource;",
    "",
    "namespace nvidia::streamline {",
    "",
    "enum class DlssQualityMode : std::uint32_t {",
    "  NativeDlaa = 0,",
    "  Quality = 1,",
    "  Balanced = 2,",
    "  Performance = 3,",
    "  UltraPerformance = 4,",
    "  Auto = 5",
    "};",
    "",
    "struct DlssQualitySettings {",
    "  DlssQualityMode mode = DlssQualityMode::Quality;",
    "  std::uint32_t inputWidth = 0;",
    "  std::uint32_t inputHeight = 0;",
    "  std::uint32_t outputWidth = 0;",
    "  std::uint32_t outputHeight = 0;",
    "  float sharpness = 0.0f;",
    "  bool dlaa = false;",
    "};",
    "",
    "struct DlssFeatureSupport {",
    "  bool streamlineHeadersDetected = false;",
    "  bool dlssFeatureConstantObserved = false;",
    "  bool apiSymbolsCompileProbed = false;",
    "  bool runtimeSupported = false;",
    "  const char* reason = \"Runtime support has not been queried.\";",
    "};",
    "",
    "struct DlssFrameInputs {",
    "  ID3D12Resource* color = nullptr;",
    "  ID3D12Resource* depth = nullptr;",
    "  ID3D12Resource* motionVectors = nullptr;",
    "  ID3D12Resource* exposure = nullptr;",
    "  ID3D12GraphicsCommandList* commandList = nullptr;",
    "  ID3D12CommandQueue* commandQueue = nullptr;",
    "  std::uint32_t inputWidth = 0;",
    "  std::uint32_t inputHeight = 0;",
    "  std::uint32_t outputWidth = 0;",
    "  std::uint32_t outputHeight = 0;",
    "  std::uint32_t frameIndex = 0;",
    "  float jitterOffsetX = 0.0f;",
    "  float jitterOffsetY = 0.0f;",
    "  bool resetAccumulation = false;",
    "",
    "  bool HasRequiredResourcesForSr() const {",
    "    return color && depth && motionVectors && commandList && commandQueue && inputWidth > 0 && inputHeight > 0 && outputWidth > 0 && outputHeight > 0;",
    "  }",
    "};",
    "",
    "}  // namespace nvidia::streamline",
    ""
  ];
}

function d3d12StreamlineBridgeHeader() {
  return [
    "#pragma once",
    "",
    "#include \"DlssTypes.h\"",
    "",
    "struct ID3D12Device;",
    "",
    "namespace nvidia::streamline {",
    "",
    "class NvidiaStreamlineBridge final {",
    " public:",
    "  struct InitDesc {",
    "    ID3D12Device* device = nullptr;",
    "    ID3D12CommandQueue* commandQueue = nullptr;",
    "    const char* streamlineSdkRoot = nullptr;",
    "    const char* logDirectory = \"logs/nvidia/streamline\";",
    "  };",
    "",
    "  bool Initialize(const InitDesc& desc);",
    "  void Shutdown();",
    "",
    "  DlssFeatureSupport QueryDlssSupport() const;",
    "  DlssQualitySettings BuildQualitySettings(DlssQualityMode mode, std::uint32_t inputWidth, std::uint32_t inputHeight, std::uint32_t outputWidth, std::uint32_t outputHeight) const;",
    "  bool EvaluateSuperResolution(const DlssFrameInputs& inputs, const DlssQualitySettings& settings);",
    "",
    "  bool HostDeviceReady() const { return hostDeviceReady_; }",
    "  const char* LastError() const { return lastError_; }",
    "",
    " private:",
    "  InitDesc desc_{};",
    "  bool hostDeviceReady_ = false;",
    "  bool runtimeSupportQueried_ = false;",
    "  bool dlssRuntimeSupported_ = false;",
    "  const char* lastError_ = \"Not initialized.\";",
    "};",
    "",
    "}  // namespace nvidia::streamline",
    ""
  ];
}

function d3d12StreamlineBridgeCpp(apiGate, readiness) {
  const headerGrounded = apiGate.status === "header_grounded";
  const compileProbeLines = headerGrounded
    ? [
        "#if defined(NVIDIA_STREAMLINE_BRIDGE_ENABLE_REAL_API) && NVIDIA_STREAMLINE_BRIDGE_ENABLE_REAL_API",
        "#if __has_include(<sl.h>)",
        "#include <sl.h>",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_H 1",
        "#else",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_H 0",
        "#endif",
        "#if __has_include(<sl_dlss.h>)",
        "#include <sl_dlss.h>",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_DLSS_H 1",
        "#else",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_DLSS_H 0",
        "#endif",
        "#else",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_H 0",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_DLSS_H 0",
        "#endif",
        "",
        "namespace {",
        "#if NVIDIA_STREAMLINE_BRIDGE_HAS_SL_H",
        "using SlInitCompileProbe = decltype(&slInit);",
        "using SlShutdownCompileProbe = decltype(&slShutdown);",
        "#endif",
        "#if NVIDIA_STREAMLINE_BRIDGE_HAS_SL_DLSS_H",
        "using SlDlssOptimalSettingsCompileProbe = decltype(&slDLSSGetOptimalSettings);",
        "#endif",
        "}  // namespace",
        ""
      ]
    : [
        "// Streamline API compile probes are omitted because local headers did not satisfy the grounding gate.",
        "// Provide a local Streamline SDK root with sl.h, sl_dlss.h, slInit, slShutdown, SL_FEATURE_DLSS, and slDLSSGetOptimalSettings before enabling real API code.",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_H 0",
        "#define NVIDIA_STREAMLINE_BRIDGE_HAS_SL_DLSS_H 0",
        ""
      ];
  const supportReason = headerGrounded
    ? "Runtime feature support query is still required before enabling DLSS SR/DLAA."
    : `Header grounding blocked real API output: ${apiGate.reason}`;
  return [
    "#include \"NvidiaStreamlineBridge.h\"",
    "",
    ...compileProbeLines,
    "namespace nvidia::streamline {",
    "",
    "bool NvidiaStreamlineBridge::Initialize(const InitDesc& desc) {",
    "  desc_ = desc;",
    "  hostDeviceReady_ = desc.device != nullptr && desc.commandQueue != nullptr;",
    "  runtimeSupportQueried_ = false;",
    "  dlssRuntimeSupported_ = false;",
    "  if (!hostDeviceReady_) {",
    "    lastError_ = \"D3D12 device and command queue are required before Streamline initialization.\";",
    "    return false;",
    "  }",
    "  if (!desc.streamlineSdkRoot || !desc.streamlineSdkRoot[0]) {",
    "    lastError_ = \"streamlineSdkRoot must point to a local, license-approved Streamline SDK path.\";",
    "    return false;",
    "  }",
    "  // TODO(host): call the version-matched Streamline initialization entry point from local headers after signature review.",
    "  // TODO(host): configure logging to desc.logDirectory and preserve logs as local validation artifacts.",
    "  lastError_ = \"Initialized host-side bridge. Streamline runtime calls are not wired yet.\";",
    "  return true;",
    "}",
    "",
    "void NvidiaStreamlineBridge::Shutdown() {",
    "  // TODO(host): call the version-matched Streamline shutdown entry point after real initialization is wired.",
    "  hostDeviceReady_ = false;",
    "  runtimeSupportQueried_ = false;",
    "  dlssRuntimeSupported_ = false;",
    "  lastError_ = \"Shutdown complete.\";",
    "}",
    "",
    "DlssFeatureSupport NvidiaStreamlineBridge::QueryDlssSupport() const {",
    "  DlssFeatureSupport support{};",
    `  support.streamlineHeadersDetected = ${headerGrounded ? "true" : "false"};`,
    "#if defined(SL_FEATURE_DLSS)",
    "  support.dlssFeatureConstantObserved = true;",
    "#endif",
    `  support.apiSymbolsCompileProbed = ${headerGrounded ? "true" : "false"};`,
    "  support.runtimeSupported = false;",
    `  support.reason = \"${escapeCppString(supportReason)}\";`,
    "  return support;",
    "}",
    "",
    "DlssQualitySettings NvidiaStreamlineBridge::BuildQualitySettings(DlssQualityMode mode, std::uint32_t inputWidth, std::uint32_t inputHeight, std::uint32_t outputWidth, std::uint32_t outputHeight) const {",
    "  DlssQualitySettings settings{};",
    "  settings.mode = mode;",
    "  settings.inputWidth = inputWidth;",
    "  settings.inputHeight = inputHeight;",
    "  settings.outputWidth = outputWidth;",
    "  settings.outputHeight = outputHeight;",
    "  settings.dlaa = mode == DlssQualityMode::NativeDlaa;",
    "  return settings;",
    "}",
    "",
    "bool NvidiaStreamlineBridge::EvaluateSuperResolution(const DlssFrameInputs& inputs, const DlssQualitySettings& settings) {",
    "  if (!hostDeviceReady_) {",
    "    lastError_ = \"Bridge is not initialized with a D3D12 device and command queue.\";",
    "    return false;",
    "  }",
    "  if (!inputs.HasRequiredResourcesForSr()) {",
    "    lastError_ = \"Host renderer must map color, depth, motion vectors, command list, command queue, and dimensions before DLSS SR/DLAA evaluation.\";",
    "    return false;",
    "  }",
    "  if (!inputs.exposure) {",
    "    lastError_ = \"Exposure resource mapping is still TODO for this host renderer.\";",
    "    return false;",
    "  }",
    "  if (settings.outputWidth == 0 || settings.outputHeight == 0) {",
    "    lastError_ = \"Output dimensions are required.\";",
    "    return false;",
    "  }",
    "  // TODO(host): tag color, depth, motion vectors, jitter, exposure, reset, command list, and command queue using the exact local Streamline SDK signatures.",
    "  // TODO(host): run the runtime DLSS feature requirement query before setting dlssRuntimeSupported_ to true.",
    "  lastError_ = \"DLSS SR/DLAA runtime call is intentionally blocked until resource tagging and support query are implemented.\";",
    "  return false;",
    "}",
    "",
    "}  // namespace nvidia::streamline",
    "",
    `// Kit readiness generated as: ${readiness.state}.`
  ];
}

function d3d12StreamlineCmakeWiring() {
  return [
    "# D3D12 Streamline DLSS SR/DLAA implementation kit wiring.",
    "# Include this from the renderer CMakeLists.txt only after reviewing the generated bridge files.",
    "",
    "set(NVIDIA_STREAMLINE_SDK_ROOT \"\" CACHE PATH \"Path to a local, user-provided NVIDIA Streamline SDK root\")",
    "set(NVIDIA_STREAMLINE_LIBRARY_DIR \"\" CACHE PATH \"Optional Streamline library directory\")",
    "option(NVIDIA_STREAMLINE_ENABLE_REAL_API \"Enable compile-time Streamline API probes in NvidiaStreamlineBridge\" OFF)",
    "",
    "if(NVIDIA_STREAMLINE_ENABLE_REAL_API)",
    "  if(NOT NVIDIA_STREAMLINE_SDK_ROOT)",
    "    message(FATAL_ERROR \"Set NVIDIA_STREAMLINE_SDK_ROOT to a local Streamline SDK root. This kit does not download SDKs.\")",
    "  endif()",
    "  set(NVIDIA_STREAMLINE_INCLUDE_DIR \"${NVIDIA_STREAMLINE_SDK_ROOT}/include\" CACHE PATH \"Streamline include directory\")",
    "  if(NOT EXISTS \"${NVIDIA_STREAMLINE_INCLUDE_DIR}/sl.h\")",
    "    message(FATAL_ERROR \"Streamline sl.h not found under ${NVIDIA_STREAMLINE_INCLUDE_DIR}\")",
    "  endif()",
    "endif()",
    "",
    "add_library(nvidia_streamline_dlss_bridge",
    "  src/nvidia/streamline/NvidiaStreamlineBridge.cpp",
    ")",
    "target_include_directories(nvidia_streamline_dlss_bridge PUBLIC",
    "  \"${CMAKE_CURRENT_LIST_DIR}/../src\"",
    ")",
    "if(NVIDIA_STREAMLINE_ENABLE_REAL_API)",
    "  target_include_directories(nvidia_streamline_dlss_bridge PUBLIC \"${NVIDIA_STREAMLINE_INCLUDE_DIR}\")",
    "  target_compile_definitions(nvidia_streamline_dlss_bridge PUBLIC NVIDIA_STREAMLINE_BRIDGE_ENABLE_REAL_API=1)",
    "  if(NVIDIA_STREAMLINE_LIBRARY_DIR)",
    "    target_link_directories(nvidia_streamline_dlss_bridge PUBLIC \"${NVIDIA_STREAMLINE_LIBRARY_DIR}\")",
    "  endif()",
    "else()",
    "  target_compile_definitions(nvidia_streamline_dlss_bridge PUBLIC NVIDIA_STREAMLINE_BRIDGE_ENABLE_REAL_API=0)",
    "endif()",
    ""
  ];
}

function d3d12StreamlineMsbuildProps() {
  return [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Project ToolsVersion=\"Current\" xmlns=\"http://schemas.microsoft.com/developer/msbuild/2003\">",
    "  <PropertyGroup>",
    "    <NvidiaStreamlineSdkRoot Condition=\"'$(NvidiaStreamlineSdkRoot)' == ''\"></NvidiaStreamlineSdkRoot>",
    "    <NvidiaStreamlineEnableRealApi Condition=\"'$(NvidiaStreamlineEnableRealApi)' == ''\">false</NvidiaStreamlineEnableRealApi>",
    "  </PropertyGroup>",
    "  <ItemDefinitionGroup Condition=\"'$(NvidiaStreamlineEnableRealApi)' == 'true'\">",
    "    <ClCompile>",
    "      <AdditionalIncludeDirectories>$(NvidiaStreamlineSdkRoot)\\include;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>",
    "      <PreprocessorDefinitions>NVIDIA_STREAMLINE_BRIDGE_ENABLE_REAL_API=1;%(PreprocessorDefinitions)</PreprocessorDefinitions>",
    "    </ClCompile>",
    "    <Link>",
    "      <AdditionalLibraryDirectories>$(NvidiaStreamlineSdkRoot)\\lib\\x64;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>",
    "    </Link>",
    "  </ItemDefinitionGroup>",
    "  <ItemDefinitionGroup Condition=\"'$(NvidiaStreamlineEnableRealApi)' != 'true'\">",
    "    <ClCompile>",
    "      <PreprocessorDefinitions>NVIDIA_STREAMLINE_BRIDGE_ENABLE_REAL_API=0;%(PreprocessorDefinitions)</PreprocessorDefinitions>",
    "    </ClCompile>",
    "  </ItemDefinitionGroup>",
    "</Project>",
    ""
  ];
}

function d3d12StreamlineKitNotes(readiness, validationHarness) {
  return [
    "# D3D12 Streamline DLSS SR/DLAA Kit",
    "",
    `Readiness state: ${readiness.state}`,
    `Real API implementation allowed: ${readiness.real_api_implementation_allowed ? "yes" : "no"}`,
    `Detected SDK root: ${readiness.streamline_sdk_requirement.detected_sdk_root || "missing"}`,
    `Build system state: ${readiness.build_system_detection.state}`,
    "",
    "## Scope",
    "",
    "- D3D12 custom renderer only.",
    "- DLSS Super Resolution and DLAA only.",
    "- No other DLSS feature path is generated by this kit.",
    "- No NVIDIA SDK download, binary copy, binary packaging, or redistribution is performed.",
    "",
    "## Host Renderer TODO Boundaries",
    "",
    ...readiness.host_resource_todo_boundaries.map((item) => `- ${item}`),
    "",
    "## Compile Commands",
    "",
    ...validationHarness.compile_commands.map((item) => `- \`${item}\``),
    "",
    "## Runtime Support Query Checklist",
    "",
    ...validationHarness.runtime_support_query_checklist.map((item) => `- ${item}`),
    "",
    "## Streamline Logs",
    "",
    `- Configured app-local log directory: \`${validationHarness.streamline_log_path.configured_app_log_directory}\``,
    `- ${validationHarness.streamline_log_path.note}`,
    "",
    "## Nsight Capture Checklist",
    "",
    ...validationHarness.nsight_capture_checklist.map((item) => `- ${item}`),
    "",
    "## Blockers",
    "",
    ...(readiness.blockers.length ? readiness.blockers.map((item) => `- ${item}`) : ["- None from static inspection."]),
    ""
  ];
}

function escapeCppString(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function rtxRayTracingContextHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "struct ID3D12Device;",
    "struct ID3D12Device5;",
    "struct ID3D12GraphicsCommandList4;",
    "struct ID3D12CommandQueue;",
    "",
    "namespace nvidia::dxr {",
    "",
    "struct RtxRayTracingContextDesc {",
    "  ID3D12Device* device = nullptr;",
    "  ID3D12CommandQueue* graphicsQueue = nullptr;",
    "  const char* shaderCompilerPath = nullptr;",
    "  const char* captureLabel = \"basic-dxr-shadows-reflections\";",
    "};",
    "",
    "struct RtxRayTracingFeatureSupport {",
    "  bool deviceReady = false;",
    "  bool featureQueryRan = false;",
    "  bool rayTracingSupported = false;",
    "  const char* reason = \"Feature query has not run.\";",
    "};",
    "",
    "class RtxRayTracingContext final {",
    " public:",
    "  bool Initialize(const RtxRayTracingContextDesc& desc);",
    "  void Shutdown();",
    "  RtxRayTracingFeatureSupport QueryFeatureSupport();",
    "  bool IsReady() const { return initialized_ && support_.rayTracingSupported; }",
    "  const RtxRayTracingFeatureSupport& Support() const { return support_; }",
    "",
    " private:",
    "  RtxRayTracingContextDesc desc_{};",
    "  ID3D12Device5* device5_ = nullptr;",
    "  bool initialized_ = false;",
    "  RtxRayTracingFeatureSupport support_{};",
    "};",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function rtxRayTracingContextCpp() {
  return [
    "#include \"RtxRayTracingContext.h\"",
    "",
    "namespace nvidia::dxr {",
    "",
    "bool RtxRayTracingContext::Initialize(const RtxRayTracingContextDesc& desc) {",
    "  desc_ = desc;",
    "  initialized_ = false;",
    "  support_ = {};",
    "  if (!desc.device || !desc.graphicsQueue) {",
    "    support_.reason = \"D3D12 device and graphics queue are required.\";",
    "    return false;",
    "  }",
    "  support_.deviceReady = true;",
    "  // TODO(host): Query ID3D12Device5 from desc.device after including the project D3D12 headers.",
    "  // TODO(host): Query D3D12_FEATURE_D3D12_OPTIONS5 and D3D12_RAYTRACING_TIER before enabling DXR UI.",
    "  initialized_ = true;",
    "  support_.reason = \"Host device accepted; DXR feature query still must be wired.\";",
    "  return true;",
    "}",
    "",
    "void RtxRayTracingContext::Shutdown() {",
    "  device5_ = nullptr;",
    "  initialized_ = false;",
    "  support_ = {};",
    "}",
    "",
    "RtxRayTracingFeatureSupport RtxRayTracingContext::QueryFeatureSupport() {",
    "  support_.featureQueryRan = true;",
    "  if (!initialized_) {",
    "    support_.rayTracingSupported = false;",
    "    support_.reason = \"Context is not initialized.\";",
    "    return support_;",
    "  }",
    "  // TODO(host): Set rayTracingSupported only after D3D12_RAYTRACING_TIER is confirmed on the runtime device.",
    "  support_.rayTracingSupported = false;",
    "  support_.reason = \"Wire D3D12 ray tracing tier query before claiming support.\";",
    "  return support_;",
    "}",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function accelerationStructureBuilderHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "struct ID3D12GraphicsCommandList4;",
    "struct ID3D12Resource;",
    "",
    "namespace nvidia::dxr {",
    "",
    "struct MeshGeometryView {",
    "  ID3D12Resource* vertexBuffer = nullptr;",
    "  ID3D12Resource* indexBuffer = nullptr;",
    "  std::uint32_t vertexCount = 0;",
    "  std::uint32_t indexCount = 0;",
    "  std::uint32_t vertexStrideBytes = 0;",
    "};",
    "",
    "struct InstanceView {",
    "  std::uint32_t instanceId = 0;",
    "  std::uint32_t meshIndex = 0;",
    "  float transform[12] = {};",
    "};",
    "",
    "struct AccelerationStructureInputs {",
    "  const MeshGeometryView* meshes = nullptr;",
    "  std::uint32_t meshCount = 0;",
    "  const InstanceView* instances = nullptr;",
    "  std::uint32_t instanceCount = 0;",
    "};",
    "",
    "class AccelerationStructureBuilder final {",
    " public:",
    "  bool BuildBlas(ID3D12GraphicsCommandList4* commandList, const AccelerationStructureInputs& inputs);",
    "  bool BuildTlas(ID3D12GraphicsCommandList4* commandList, const AccelerationStructureInputs& inputs);",
    "  ID3D12Resource* TlasResource() const { return tlasResource_; }",
    "  const char* LastError() const { return lastError_; }",
    "",
    " private:",
    "  ID3D12Resource* tlasResource_ = nullptr;",
    "  const char* lastError_ = \"Acceleration structures have not been built.\";",
    "};",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function accelerationStructureBuilderCpp() {
  return [
    "#include \"AccelerationStructureBuilder.h\"",
    "",
    "namespace nvidia::dxr {",
    "",
    "bool AccelerationStructureBuilder::BuildBlas(ID3D12GraphicsCommandList4* commandList, const AccelerationStructureInputs& inputs) {",
    "  if (!commandList || !inputs.meshes || inputs.meshCount == 0) {",
    "    lastError_ = \"BLAS build requires command list and mesh geometry.\";",
    "    return false;",
    "  }",
    "  // TODO(host): Convert MeshGeometryView into D3D12_RAYTRACING_GEOMETRY_DESC records.",
    "  // TODO(host): Allocate scratch/result buffers and call BuildRaytracingAccelerationStructure.",
    "  lastError_ = \"BLAS build is a host-renderer TODO.\";",
    "  return false;",
    "}",
    "",
    "bool AccelerationStructureBuilder::BuildTlas(ID3D12GraphicsCommandList4* commandList, const AccelerationStructureInputs& inputs) {",
    "  if (!commandList || !inputs.instances || inputs.instanceCount == 0) {",
    "    lastError_ = \"TLAS build requires command list and instance data.\";",
    "    return false;",
    "  }",
    "  // TODO(host): Upload D3D12_RAYTRACING_INSTANCE_DESC records and build the TLAS.",
    "  // TODO(host): Insert required UAV/resource barriers before DispatchRays.",
    "  lastError_ = \"TLAS build is a host-renderer TODO.\";",
    "  return false;",
    "}",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function shaderBindingTableBuilderHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "namespace nvidia::dxr {",
    "",
    "struct ShaderBindingTableLayout {",
    "  std::uint32_t raygenRecordSize = 0;",
    "  std::uint32_t missRecordSize = 0;",
    "  std::uint32_t hitGroupRecordSize = 0;",
    "  std::uint32_t missRecordCount = 0;",
    "  std::uint32_t hitGroupRecordCount = 0;",
    "};",
    "",
    "class ShaderBindingTableBuilder final {",
    " public:",
    "  bool Configure(const ShaderBindingTableLayout& layout);",
    "  bool Build();",
    "  const ShaderBindingTableLayout& Layout() const { return layout_; }",
    "  const char* LastError() const { return lastError_; }",
    "",
    " private:",
    "  ShaderBindingTableLayout layout_{};",
    "  const char* lastError_ = \"SBT has not been configured.\";",
    "};",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function shaderBindingTableBuilderCpp() {
  return [
    "#include \"ShaderBindingTableBuilder.h\"",
    "",
    "namespace nvidia::dxr {",
    "",
    "bool ShaderBindingTableBuilder::Configure(const ShaderBindingTableLayout& layout) {",
    "  if (layout.raygenRecordSize == 0 || layout.missRecordSize == 0 || layout.hitGroupRecordSize == 0) {",
    "    lastError_ = \"Raygen, miss, and hit-group record sizes are required.\";",
    "    return false;",
    "  }",
    "  layout_ = layout;",
    "  lastError_ = \"SBT layout configured; GPU buffer build remains TODO.\";",
    "  return true;",
    "}",
    "",
    "bool ShaderBindingTableBuilder::Build() {",
    "  if (layout_.raygenRecordSize == 0) {",
    "    lastError_ = \"Configure SBT layout before Build.\";",
    "    return false;",
    "  }",
    "  // TODO(host): Allocate upload/default buffers for raygen, miss, and hit-group records.",
    "  // TODO(host): Copy shader identifiers and local root data from the final state object.",
    "  lastError_ = \"SBT GPU records are a host-renderer TODO.\";",
    "  return false;",
    "}",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function rayTracingPassHeader() {
  return [
    "#pragma once",
    "",
    "#include \"AccelerationStructureBuilder.h\"",
    "#include \"RtxRayTracingContext.h\"",
    "#include \"ShaderBindingTableBuilder.h\"",
    "",
    "struct ID3D12GraphicsCommandList4;",
    "struct ID3D12Resource;",
    "",
    "namespace nvidia::dxr {",
    "",
    "enum class RayTracingMode {",
    "  Shadows,",
    "  Reflections",
    "};",
    "",
    "struct RayTracingPassInputs {",
    "  ID3D12GraphicsCommandList4* commandList = nullptr;",
    "  ID3D12Resource* output = nullptr;",
    "  ID3D12Resource* depth = nullptr;",
    "  ID3D12Resource* normal = nullptr;",
    "  ID3D12Resource* material = nullptr;",
    "  std::uint32_t width = 0;",
    "  std::uint32_t height = 0;",
    "  RayTracingMode mode = RayTracingMode::Shadows;",
    "  bool fallbackEnabled = true;",
    "};",
    "",
    "class RayTracingPass final {",
    " public:",
    "  bool Initialize(RtxRayTracingContext* context, AccelerationStructureBuilder* accelerationStructures, ShaderBindingTableBuilder* sbt);",
    "  bool Execute(const RayTracingPassInputs& inputs);",
    "  const char* LastError() const { return lastError_; }",
    "",
    " private:",
    "  RtxRayTracingContext* context_ = nullptr;",
    "  AccelerationStructureBuilder* accelerationStructures_ = nullptr;",
    "  ShaderBindingTableBuilder* sbt_ = nullptr;",
    "  const char* lastError_ = \"RayTracingPass has not initialized.\";",
    "};",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function rayTracingPassCpp() {
  return [
    "#include \"RayTracingPass.h\"",
    "",
    "namespace nvidia::dxr {",
    "",
    "bool RayTracingPass::Initialize(RtxRayTracingContext* context, AccelerationStructureBuilder* accelerationStructures, ShaderBindingTableBuilder* sbt) {",
    "  context_ = context;",
    "  accelerationStructures_ = accelerationStructures;",
    "  sbt_ = sbt;",
    "  if (!context_ || !accelerationStructures_ || !sbt_) {",
    "    lastError_ = \"Context, acceleration structures, and SBT are required.\";",
    "    return false;",
    "  }",
    "  lastError_ = \"Initialized; shader pipeline/state object creation remains TODO.\";",
    "  return true;",
    "}",
    "",
    "bool RayTracingPass::Execute(const RayTracingPassInputs& inputs) {",
    "  if (!context_ || !context_->IsReady()) {",
    "    lastError_ = \"DXR context is not ready; keep raster fallback active.\";",
    "    return false;",
    "  }",
    "  if (!inputs.commandList || !inputs.output || !inputs.depth || !inputs.normal || !inputs.material || inputs.width == 0 || inputs.height == 0) {",
    "    lastError_ = \"RayTracingPass requires command list, output, depth, normal, material, and dimensions.\";",
    "    return false;",
    "  }",
    "  if (!accelerationStructures_->TlasResource()) {",
    "    lastError_ = \"TLAS is not available.\";",
    "    return false;",
    "  }",
    "  // TODO(host): Bind state object, global/local root signatures, descriptor heap, TLAS, G-buffer/material resources, and SBT.",
    "  // TODO(host): DispatchRays for a first visible shadows/reflections pass, then composite with the existing render graph.",
    "  lastError_ = \"DispatchRays is intentionally blocked until host renderer bindings are reviewed.\";",
    "  return false;",
    "}",
    "",
    "}  // namespace nvidia::dxr",
    ""
  ];
}

function rayTracingCommonHlsl() {
  return [
    "#ifndef NVIDIA_DXR_RAYTRACING_COMMON_HLSL",
    "#define NVIDIA_DXR_RAYTRACING_COMMON_HLSL",
    "",
    "struct RayPayload",
    "{",
    "  float3 radiance;",
    "  float visibility;",
    "  uint hitKind;",
    "};",
    "",
    "struct ShadowPayload",
    "{",
    "  bool occluded;",
    "};",
    "",
    "struct Attributes",
    "{",
    "  float2 barycentrics;",
    "};",
    "",
    "cbuffer RayTracingConstants : register(b0)",
    "{",
    "  float4x4 gInvViewProjection;",
    "  float3 gCameraPosition;",
    "  uint gMode;",
    "  float3 gLightDirection;",
    "  uint gFrameIndex;",
    "};",
    "",
    "RaytracingAccelerationStructure gScene : register(t0);",
    "Texture2D<float> gDepth : register(t1);",
    "Texture2D<float4> gNormalRoughness : register(t2);",
    "Texture2D<float4> gMaterial : register(t3);",
    "RWTexture2D<float4> gOutput : register(u0);",
    "",
    "#endif",
    ""
  ];
}

function rayTracingRaygenHlsl() {
  return [
    "#include \"RayTracingCommon.hlsl\"",
    "",
    "[shader(\"raygeneration\")]",
    "void RayGen()",
    "{",
    "  uint2 pixel = DispatchRaysIndex().xy;",
    "  uint2 size = DispatchRaysDimensions().xy;",
    "  if (pixel.x >= size.x || pixel.y >= size.y) return;",
    "",
    "  float2 uv = (float2(pixel) + 0.5f) / float2(size);",
    "  float depth = gDepth.Load(int3(pixel, 0));",
    "  RayPayload payload;",
    "  payload.radiance = float3(0.0f, 0.0f, 0.0f);",
    "  payload.visibility = 1.0f;",
    "  payload.hitKind = 0u;",
    "",
    "  RayDesc ray;",
    "  ray.Origin = gCameraPosition;",
    "  ray.Direction = normalize(float3(uv * 2.0f - 1.0f, 1.0f));",
    "  ray.TMin = 0.001f;",
    "  ray.TMax = 100000.0f;",
    "",
    "  TraceRay(gScene, RAY_FLAG_NONE, 0xFF, 0, 1, 0, ray, payload);",
    "  gOutput[pixel] = float4(payload.radiance, payload.visibility);",
    "}",
    ""
  ];
}

function rayTracingMissHlsl() {
  return [
    "#include \"RayTracingCommon.hlsl\"",
    "",
    "[shader(\"miss\")]",
    "void Miss(inout RayPayload payload)",
    "{",
    "  payload.radiance = float3(0.0f, 0.0f, 0.0f);",
    "  payload.visibility = 1.0f;",
    "  payload.hitKind = 0u;",
    "}",
    ""
  ];
}

function rayTracingClosestHitHlsl() {
  return [
    "#include \"RayTracingCommon.hlsl\"",
    "",
    "[shader(\"closesthit\")]",
    "void ClosestHit(inout RayPayload payload, in BuiltInTriangleIntersectionAttributes attributes)",
    "{",
    "  float3 normal = normalize(float3(attributes.barycentrics, 1.0f - attributes.barycentrics.x - attributes.barycentrics.y));",
    "  float nDotL = saturate(dot(normal, -normalize(gLightDirection)));",
    "  payload.radiance = float3(nDotL, nDotL, nDotL);",
    "  payload.visibility = nDotL > 0.0f ? 1.0f : 0.0f;",
    "  payload.hitKind = 1u;",
    "}",
    ""
  ];
}

function d3d12DxrCmakeWiring() {
  return [
    "# D3D12 DXR starter-kit wiring.",
    "# Include from the renderer CMakeLists.txt after reviewing generated sources.",
    "",
    "option(NVIDIA_DXR_STARTER_ENABLE \"Enable generated D3D12 DXR starter kit\" OFF)",
    "set(NVIDIA_DXR_SHADER_OUTPUT_DIR \"${CMAKE_BINARY_DIR}/generated/shaders/dxr\" CACHE PATH \"Compiled DXIL output directory\")",
    "",
    "if(NVIDIA_DXR_STARTER_ENABLE)",
    "  add_library(nvidia_dxr_starter",
    "    src/nvidia/dxr/RtxRayTracingContext.cpp",
    "    src/nvidia/dxr/AccelerationStructureBuilder.cpp",
    "    src/nvidia/dxr/ShaderBindingTableBuilder.cpp",
    "    src/nvidia/dxr/RayTracingPass.cpp",
    "  )",
    "  target_include_directories(nvidia_dxr_starter PUBLIC \"${CMAKE_CURRENT_LIST_DIR}/../src\")",
    "  target_compile_definitions(nvidia_dxr_starter PUBLIC NVIDIA_DXR_STARTER_ENABLE=1)",
    "  set(NVIDIA_DXR_SHADER_FILES",
    "    shaders/nvidia/dxr/RayTracingRaygen.hlsl",
    "    shaders/nvidia/dxr/RayTracingMiss.hlsl",
    "    shaders/nvidia/dxr/RayTracingClosestHit.hlsl",
    "  )",
    "  message(STATUS \"Review and wire DXC shader compilation for: ${NVIDIA_DXR_SHADER_FILES}\")",
    "endif()",
    ""
  ];
}

function d3d12DxrStarterKitNotes(readiness, validationChecklist) {
  return [
    "# D3D12 DXR Ray Tracing Starter Kit",
    "",
    `Readiness state: ${readiness.state}`,
    `Starter kit generation allowed: ${readiness.starter_kit_generation_allowed ? "yes" : "no"}`,
    `Build system state: ${readiness.build_system_detection.state}`,
    "",
    "## Scope",
    "",
    "- D3D12 only.",
    "- Basic ray-traced shadows/reflections starter only.",
    "- No RTXDI or NRD full integration.",
    "- No full path tracer.",
    "- No invasive host renderer edits without a separate explicit approval.",
    "",
    "## Contract Checks",
    "",
    ...Object.values(readiness.contract_checks).map((check) => `- ${check.id}: ${check.status}${check.matched_tokens?.length ? ` (${check.matched_tokens.join(", ")})` : ""}`),
    "",
    "## Validation Checklist",
    "",
    ...validationChecklist.required_steps.map((item) => `- ${item}`),
    "",
    "## Blockers",
    "",
    ...(readiness.blockers.length ? readiness.blockers.map((item) => `- ${item}`) : ["- None from static inspection."]),
    "",
    "## Fallback",
    "",
    "- Keep the raster fallback live until feature query, BLAS/TLAS build, shader compile, first visible pass, and Nsight capture all pass.",
    ""
  ];
}

function nrdFrameInputsHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "namespace nvidia::nrd_bridge {",
    "",
    "enum class GraphicsApi {",
    "  Unknown,",
    "  D3D12,",
    "  Vulkan",
    "};",
    "",
    "enum class NrdSignalType {",
    "  Unknown,",
    "  DiffuseRadiance,",
    "  SpecularRadiance,",
    "  ShadowVisibility,",
    "  AmbientOcclusion",
    "};",
    "",
    "enum class NrdDenoiserFamily {",
    "  Unknown,",
    "  ReBLUR,",
    "  ReLAX,",
    "  SIGMA",
    "};",
    "",
    "struct NrdResourceView {",
    "  void* nativeResource = nullptr;",
    "  const char* debugName = nullptr;",
    "};",
    "",
    "struct NrdMatrix4x4 {",
    "  float m[16] = {};",
    "};",
    "",
    "struct NrdFrameInputs {",
    "  NrdSignalType signalType = NrdSignalType::Unknown;",
    "  NrdResourceView noisySignal;",
    "  NrdResourceView normalRoughness;",
    "  NrdResourceView viewZOrDepth;",
    "  NrdResourceView motionVectors;",
    "  NrdResourceView output;",
    "  NrdMatrix4x4 viewToClip;",
    "  NrdMatrix4x4 clipToView;",
    "  NrdMatrix4x4 previousViewToClip;",
    "  std::uint32_t width = 0;",
    "  std::uint32_t height = 0;",
    "  bool resetHistory = false;",
    "  bool cameraCut = false;",
    "  bool resolutionChanged = false;",
    "};",
    "",
    "struct NrdValidationResult {",
    "  bool valid = false;",
    "  const char* reason = \"NrdFrameInputs have not been validated.\";",
    "};",
    "",
    "}  // namespace nvidia::nrd_bridge",
    ""
  ];
}

function nrdDenoiserBridgeHeader() {
  return [
    "#pragma once",
    "",
    "#include \"NrdFrameInputs.h\"",
    "",
    "namespace nvidia::nrd_bridge {",
    "",
    "struct NrdDenoiserBridgeDesc {",
    "  GraphicsApi graphicsApi = GraphicsApi::Unknown;",
    "  void* nativeDevice = nullptr;",
    "  void* nativeCommandQueue = nullptr;",
    "  const char* sdkRoot = nullptr;",
    "  const char* debugName = \"nrd-denoiser-bridge\";",
    "};",
    "",
    "struct NrdDenoiserSupport {",
    "  bool initialized = false;",
    "  bool localHeadersEnabled = false;",
    "  bool frameInputsValid = false;",
    "  NrdDenoiserFamily recommendedFamily = NrdDenoiserFamily::Unknown;",
    "  const char* reason = \"Bridge has not been initialized.\";",
    "};",
    "",
    "class NrdDenoiserBridge final {",
    " public:",
    "  bool Initialize(const NrdDenoiserBridgeDesc& desc);",
    "  void Shutdown();",
    "  NrdValidationResult ValidateFrameInputs(const NrdFrameInputs& inputs) const;",
    "  NrdDenoiserFamily SelectDenoiser(const NrdFrameInputs& inputs) const;",
    "  bool Evaluate(const NrdFrameInputs& inputs);",
    "  const NrdDenoiserSupport& Support() const { return support_; }",
    "",
    " private:",
    "  NrdDenoiserBridgeDesc desc_{};",
    "  NrdDenoiserSupport support_{};",
    "};",
    "",
    "}  // namespace nvidia::nrd_bridge",
    ""
  ];
}

function nrdDenoiserBridgeCpp(apiGate, readiness) {
  const apiModeComment =
    apiGate.status === "header_grounded"
      ? "Local NRD headers were detected. Keep real SDK calls limited to observed local symbols after adding exact version-specific code in a reviewed patch."
      : "Local NRD headers were not sufficient for real SDK calls. This file stays in template-only mode.";
  return [
    "#include \"NrdDenoiserBridge.h\"",
    "",
    "#if defined(NVIDIA_NRD_BRIDGE_ENABLE_REAL_API) && NVIDIA_NRD_BRIDGE_ENABLE_REAL_API",
    "#  if defined(__has_include)",
    "#    if __has_include(<NRD.h>)",
    "#      include <NRD.h>",
    "#      define NVIDIA_NRD_BRIDGE_HAS_NRD 1",
    "#    else",
    "#      define NVIDIA_NRD_BRIDGE_HAS_NRD 0",
    "#    endif",
    "#  else",
    "#    define NVIDIA_NRD_BRIDGE_HAS_NRD 0",
    "#  endif",
    "#else",
    "#  define NVIDIA_NRD_BRIDGE_HAS_NRD 0",
    "#endif",
    "",
    "namespace nvidia::nrd_bridge {",
    "",
    "bool NrdDenoiserBridge::Initialize(const NrdDenoiserBridgeDesc& desc) {",
    "  desc_ = desc;",
    "  support_ = {};",
    "  if (!desc.nativeDevice || desc.graphicsApi == GraphicsApi::Unknown) {",
    "    support_.reason = \"NRD bridge requires a native graphics device and explicit graphics API.\";",
    "    return false;",
    "  }",
    `  // ${escapeCppString(apiModeComment)}`,
    "#if NVIDIA_NRD_BRIDGE_HAS_NRD",
    "  support_.localHeadersEnabled = true;",
    "#else",
    "  support_.localHeadersEnabled = false;",
    "#endif",
    "  support_.initialized = true;",
    "  support_.reason = \"Bridge initialized; real NRD dispatch remains blocked until frame inputs and local SDK code are reviewed.\";",
    "  return true;",
    "}",
    "",
    "void NrdDenoiserBridge::Shutdown() {",
    "  support_ = {};",
    "  desc_ = {};",
    "}",
    "",
    "NrdValidationResult NrdDenoiserBridge::ValidateFrameInputs(const NrdFrameInputs& inputs) const {",
    "  if (!support_.initialized) return {false, \"NRD bridge is not initialized.\"};",
    "  if (inputs.signalType == NrdSignalType::Unknown) return {false, \"NrdSignalType must identify diffuse, specular, shadow, or occlusion signal.\"};",
    "  if (!inputs.noisySignal.nativeResource) return {false, \"Noisy diffuse/specular/shadow signal is required.\"};",
    "  if (!inputs.normalRoughness.nativeResource) return {false, \"Normal and roughness guide buffer is required.\"};",
    "  if (!inputs.viewZOrDepth.nativeResource) return {false, \"ViewZ or depth buffer is required.\"};",
    "  if (!inputs.motionVectors.nativeResource) return {false, \"Motion vectors are required for temporal denoising.\"};",
    "  if (!inputs.output.nativeResource) return {false, \"Denoised output resource is required.\"};",
    "  if (inputs.width == 0 || inputs.height == 0) return {false, \"Render resolution width and height are required.\"};",
    "  return {true, \"NRD frame input contract is present; runtime correctness still requires captures and quality validation.\"};",
    "}",
    "",
    "NrdDenoiserFamily NrdDenoiserBridge::SelectDenoiser(const NrdFrameInputs& inputs) const {",
    "  switch (inputs.signalType) {",
    "    case NrdSignalType::DiffuseRadiance:",
    "    case NrdSignalType::SpecularRadiance:",
    "      return NrdDenoiserFamily::ReBLUR;",
    "    case NrdSignalType::ShadowVisibility:",
    "      return NrdDenoiserFamily::SIGMA;",
    "    case NrdSignalType::AmbientOcclusion:",
    "      return NrdDenoiserFamily::ReLAX;",
    "    default:",
    "      return NrdDenoiserFamily::Unknown;",
    "  }",
    "}",
    "",
    "bool NrdDenoiserBridge::Evaluate(const NrdFrameInputs& inputs) {",
    "  NrdValidationResult validation = ValidateFrameInputs(inputs);",
    "  support_.frameInputsValid = validation.valid;",
    "  support_.recommendedFamily = SelectDenoiser(inputs);",
    "  if (!validation.valid) {",
    "    support_.reason = validation.reason;",
    "    return false;",
    "  }",
    "  if (inputs.cameraCut || inputs.resolutionChanged || inputs.resetHistory) {",
    "    // TODO(host): Reset NRD history for temporal discontinuities before evaluating the denoiser.",
    "  }",
    "  // TODO(host): Convert NrdFrameInputs into the exact local NRD SDK descriptors after inspecting installed headers.",
    "  // TODO(host): Dispatch ReBLUR/ReLAX/SIGMA only after before/after captures and fallback behavior are defined.",
    `  support_.reason = "${escapeCppString(readiness.denoising_working_claim_blocker)}";`,
    "  return false;",
    "}",
    "",
    "}  // namespace nvidia::nrd_bridge",
    ""
  ];
}

function nrdCmakeWiring() {
  return [
    "# NRD denoiser bridge wiring.",
    "# Include from the renderer CMakeLists.txt after reviewing generated sources.",
    "",
    "option(NVIDIA_NRD_BRIDGE_ENABLE \"Enable generated NRD denoiser bridge\" OFF)",
    "option(NVIDIA_NRD_BRIDGE_ENABLE_REAL_API \"Enable compile-time NRD header include gate\" OFF)",
    "set(NVIDIA_NRD_SDK_ROOT \"\" CACHE PATH \"Path to a local, user-provided NRD SDK root\")",
    "",
    "if(NVIDIA_NRD_BRIDGE_ENABLE)",
    "  add_library(nvidia_nrd_bridge",
    "    src/nvidia/nrd/NrdDenoiserBridge.cpp",
    "  )",
    "  target_include_directories(nvidia_nrd_bridge PUBLIC \"${CMAKE_CURRENT_LIST_DIR}/../src\")",
    "  if(NVIDIA_NRD_BRIDGE_ENABLE_REAL_API)",
    "    if(NOT NVIDIA_NRD_SDK_ROOT)",
    "      message(FATAL_ERROR \"Set NVIDIA_NRD_SDK_ROOT to a local NRD SDK root. This kit does not download SDKs.\")",
    "    endif()",
    "    set(NVIDIA_NRD_INCLUDE_DIR \"${NVIDIA_NRD_SDK_ROOT}/include\" CACHE PATH \"NRD include directory\")",
    "    if(NOT EXISTS \"${NVIDIA_NRD_INCLUDE_DIR}/NRD.h\")",
    "      message(FATAL_ERROR \"NRD.h not found under ${NVIDIA_NRD_INCLUDE_DIR}\")",
    "    endif()",
    "    target_include_directories(nvidia_nrd_bridge PUBLIC \"${NVIDIA_NRD_INCLUDE_DIR}\")",
    "    target_compile_definitions(nvidia_nrd_bridge PUBLIC NVIDIA_NRD_BRIDGE_ENABLE_REAL_API=1)",
    "  else()",
    "    target_compile_definitions(nvidia_nrd_bridge PUBLIC NVIDIA_NRD_BRIDGE_ENABLE_REAL_API=0)",
    "  endif()",
    "endif()",
    ""
  ];
}

function nrdDenoiserBridgeNotes(readiness, validationChecklist) {
  return [
    "# NRD Denoiser Bridge Kit",
    "",
    `Readiness state: ${readiness.state}`,
    `Bridge generation mode: ${readiness.bridge_generation_mode}`,
    `Real NRD API calls allowed: ${readiness.real_nrd_api_calls_allowed ? "yes, after reviewed local-header implementation" : "no"}`,
    `Denoising working claim allowed: ${readiness.denoising_working_claim_allowed ? "yes" : "no"}`,
    "",
    "## Scope",
    "",
    "- Bridge/adapters only.",
    "- No claim that denoising works until required buffers, compile validation, frame captures, and quality checks exist.",
    "- No RTXDI integration.",
    "- No full NRD integration.",
    "- No full path tracer.",
    "- No guessed NRD SDK calls.",
    "",
    "## Required Frame Inputs",
    "",
    ...readiness.required_frame_inputs.map((item) => `- ${item}`),
    "",
    "## Contract Checks",
    "",
    ...Object.values(readiness.contract_checks).map((check) => `- ${check.id}: ${check.status}${check.matched_tokens?.length ? ` (${check.matched_tokens.join(", ")})` : ""}`),
    "",
    "## ReBLUR Readiness",
    "",
    ...validationChecklist.reblur_readiness.map((item) => `- ${item}`),
    "",
    "## ReLAX Readiness",
    "",
    ...validationChecklist.relax_readiness.map((item) => `- ${item}`),
    "",
    "## SIGMA Readiness",
    "",
    ...validationChecklist.sigma_readiness.map((item) => `- ${item}`),
    "",
    "## Validation Checklist",
    "",
    ...validationChecklist.required_steps.map((item) => `- ${item}`),
    "",
    "## Blockers",
    "",
    ...(readiness.blockers.length ? readiness.blockers.map((item) => `- ${item}`) : ["- None from static inspection."]),
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

function videoCodecNativePipelineKit(context, apiGate, baseValidation) {
  const readiness = videoCodecNativeReadiness(context, apiGate);
  const commandPlans = videoCodecCommandPlans(readiness);
  const validationPlan = videoCodecThroughputQualityValidationPlan(readiness);
  return {
    summary: "Create a gated Video Codec SDK / NVENC / NVDEC development kit with native adapters, FFmpeg/GStreamer/PyNvVideoCodec command plans, throughput checks, and quality validation.",
    implementation_readiness: readiness,
    contract_checks: readiness.contract_checks,
    build_system_detection: readiness.build_system_detection,
    command_plans: commandPlans,
    validation_harness: validationPlan,
    files: [
      scaffoldFile("src/nvidia_video/VideoCodecPipelineTypes.h", "cpp", "Shared codec request, frame format, platform, and validation contracts for NVENC/NVDEC adapters.", videoCodecPipelineTypesHeader()),
      scaffoldFile("src/nvidia_video/NvencPipelineAdapter.h", "cpp", "NVENC adapter interface for encode capability checks and host frame contracts.", nvencPipelineAdapterHeader()),
      scaffoldFile("src/nvidia_video/NvencPipelineAdapter.cpp", "cpp", "Header-gated NVENC adapter shell with no guessed SDK calls.", nvencPipelineAdapterCpp(apiGate, readiness)),
      scaffoldFile("src/nvidia_video/NvdecPipelineAdapter.h", "cpp", "NVDEC adapter interface for decode capability checks and host output frame contracts.", nvdecPipelineAdapterHeader()),
      scaffoldFile("src/nvidia_video/NvdecPipelineAdapter.cpp", "cpp", "Header-gated NVDEC adapter shell with no guessed SDK calls.", nvdecPipelineAdapterCpp(apiGate, readiness)),
      scaffoldFile("cmake/NvidiaVideoCodec.cmake", "cmake", "CMake wiring for user-provided Video Codec SDK include roots and native adapters.", videoCodecCmakeWiring()),
      scaffoldFile("docs/nvidia/video-codec-native-pipeline-kit.md", "markdown", "FFmpeg, GStreamer, PyNvVideoCodec, throughput, quality, and utilization validation plan.", videoCodecNativePipelineNotes(readiness, commandPlans, validationPlan))
    ],
    host_repo_edits_required: [
      "Add the generated NvencPipelineAdapter/NvdecPipelineAdapter files to the narrow native codec or media pipeline target after review.",
      "Wire the generated CMake include only after setting a local, license-approved Video Codec SDK root.",
      "For FFmpeg/GStreamer projects, apply command/pipeline changes in a separate reviewable diff and keep software fallback.",
      "For Python projects, choose PyNvVideoCodec only when dependency and deployment constraints are explicit.",
      "Validate encode/decode goal, codec, pixel format, bit depth, target platform, GPU capability, and any zero-copy claim before enabling acceleration."
    ],
    validation_plan: mergePlan(baseValidation, validationPlan.required_steps),
    rollback_plan: rollbackPlan("Remove the generated src/nvidia_video adapter files and CMake include/import. Revert FFmpeg/GStreamer/Python command changes separately and keep the original software path available."),
    sources: sourceRefs(["video-codec-sdk"])
  };
}

function videoCodecNativeReadiness(context, apiGate) {
  const project = context.project || {};
  const languages = project.languages || [];
  const buildSystems = project.build_systems || [];
  const contentPaths = project.content_paths || [];
  const targetPlatforms = project.target_platforms || [];
  const projectTypeNames = (project.project_types || []).map((item) => item.name);
  const text = inventoryText(context.inventory);
  const frameworks = videoCodecFrameworkDetection(context.inventory, project);
  const isCodecPipeline = contentPaths.includes("video_encode_decode") || projectTypeNames.includes("video_pipeline") || frameworks.detected.length > 0;
  const hasNativeOrPython = languages.some((language) => /C\/C\+\+|C\+\+|C\/C|Python|Rust|CUDA/i.test(language));
  const hasBuildOrScriptPath = buildSystems.some((item) => /CMake|MSBuild|Visual Studio|Python|npm|Cargo/i.test(item));
  const headers = context.headerGrounding || {};
  const hasVideoCodecHeaders = Boolean(headers.relevant_headers?.length);
  const gpuProbe = probeEnvironment();
  const toolAvailability = videoCodecToolAvailability(frameworks);
  const checks = {
    encode_decode_goal: videoCodecEvidenceCheck(context.inventory, "encode_decode_goal", "Encode, decode, transcode, capture, stream, or dataset ingest goal.", ["encode", "decode", "transcode", "capture", "streaming", "dataset", "nvenc", "nvdec"]),
    codec: videoCodecEvidenceCheck(context.inventory, "codec", "Codec choice such as H.264, HEVC, or AV1.", ["h264", "hevc", "av1", "h.264", "h.265", "codec"]),
    pixel_format: videoCodecEvidenceCheck(context.inventory, "pixel_format", "Pixel format such as NV12, P010, YUV420P, BGRA, or RGBA.", ["nv12", "p010", "yuv420p", "rgba", "bgra", "pixel format", "pix_fmt"]),
    bit_depth: videoCodecEvidenceCheck(context.inventory, "bit_depth", "8-bit or 10-bit bit-depth handling.", ["8-bit", "10-bit", "bit depth", "p010", "nv12"]),
    target_platform: {
      id: "target_platform",
      description: "Windows or Linux deployment target.",
      status: targetPlatforms.some((item) => /Windows|Linux/i.test(item)) || /windows|linux|win32|ubuntu|docker/i.test(text) ? "pass" : "fail",
      matched_tokens: targetPlatforms,
      required_tokens_any: ["Windows", "Linux"],
      blocker: targetPlatforms.some((item) => /Windows|Linux/i.test(item)) || /windows|linux|win32|ubuntu|docker/i.test(text) ? null : "Missing Video Codec readiness evidence: target platform."
    },
    gpu_capability: {
      id: "gpu_capability",
      description: "GPU/driver/codec support capability check or support-matrix path.",
      status: gpuProbe.gpu || /gpu capability|codec support|support matrix|nvidia-smi|driver|NV_ENC_CAPS|CUVIDDECODECAPS/i.test(text) ? "pass" : "fail",
      matched_tokens: [
        ...(gpuProbe.gpu ? [`nvidia-smi:${gpuProbe.gpu.name}`] : []),
        ...["gpu capability", "codec support", "support matrix", "nvidia-smi", "driver", "NV_ENC_CAPS", "CUVIDDECODECAPS"].filter((token) => text.includes(lower(token)))
      ],
      required_tokens_any: ["nvidia-smi GPU/driver", "codec support matrix", "NV_ENC_CAPS", "CUVIDDECODECAPS"],
      blocker: gpuProbe.gpu || /gpu capability|codec support|support matrix|nvidia-smi|driver|NV_ENC_CAPS|CUVIDDECODECAPS/i.test(text) ? null : "Missing Video Codec readiness evidence: GPU capability or codec support check path."
    },
    zero_copy_claim_validation: videoCodecZeroCopyCheck(context.inventory)
  };
  const failedChecks = Object.values(checks).filter((check) => check.status === "fail");
  const blockers = [];
  if (!context.root) blockers.push("project_path is required to prove Video Codec SDK pipeline readiness.");
  if (!hasNativeOrPython) blockers.push("Native or Python video pipeline source was not detected.");
  if (!isCodecPipeline) blockers.push("Encode/decode/transcode/capture/streaming pipeline evidence was not detected.");
  if (!hasBuildOrScriptPath) blockers.push("Build system or script/dependency path was not detected.");
  blockers.push(...failedChecks.map((check) => check.blocker));
  if (!hasVideoCodecHeaders) blockers.push("Local or project-vendored Video Codec SDK headers were not detected.");
  if (hasVideoCodecHeaders && !headers.can_generate_real_api_guidance) {
    blockers.push(`Video Codec SDK headers were detected but required symbols are missing: ${(headers.missing_required_symbols || []).join(", ") || "unknown"}.`);
  }

  let state = "video_codec_pipeline_ready";
  if (!context.root) state = "needs_project_inspection_template_only";
  else if (!hasNativeOrPython || !isCodecPipeline) state = "blocked_not_video_codec_pipeline";
  else if (failedChecks.length) state = "blocked_missing_video_codec_contract";
  else if (!hasVideoCodecHeaders) state = "blocked_missing_video_codec_sdk";
  else if (!headers.can_generate_real_api_guidance) state = "limited_missing_video_codec_symbols_template_only";
  else if (!hasBuildOrScriptPath) state = "header_grounded_build_or_script_path_unknown";

  return {
    state,
    adapter_generation_allowed: !["blocked_not_video_codec_pipeline", "blocked_missing_video_codec_contract"].includes(state),
    real_video_codec_api_calls_allowed: state === "video_codec_pipeline_ready" || state === "header_grounded_build_or_script_path_unknown",
    acceleration_working_claim_allowed: false,
    acceleration_working_claim_blocker: "This kit only proves adapter/command-plan readiness. NVENC/NVDEC acceleration can be claimed only after capability checks, tool logs, throughput, quality metrics, and utilization notes exist.",
    project_root: context.root,
    pipeline_detection: {
      frameworks: frameworks.detected,
      route: frameworks.primary_route,
      codec_pipeline_detected: isCodecPipeline,
      native_or_python_detected: hasNativeOrPython,
      languages,
      build_systems: buildSystems,
      content_paths: contentPaths,
      target_platforms: targetPlatforms,
      relevant_files: selectRelevantFiles(context.inventory, frameworks.primary_route === "python" ? "python-video" : "ffmpeg-gstreamer").slice(0, 28)
    },
    build_system_detection: {
      cmake: buildSystems.includes("CMake"),
      msbuild: buildSystems.includes("MSBuild/Visual Studio"),
      python: buildSystems.includes("Python"),
      detected: buildSystems,
      state: hasBuildOrScriptPath ? "supported_build_or_script_path_detected" : "build_or_script_path_unknown"
    },
    video_codec_sdk_requirement: {
      state: hasVideoCodecHeaders ? "sdk_headers_detected" : "sdk_path_required",
      detected_sdk_root: headers.detected_sdk_root || null,
      detected_version: headers.detected_version || null,
      required_symbols: headers.required_symbols || [],
      missing_required_symbols: headers.missing_required_symbols || [],
      relevant_headers: headers.relevant_headers || [],
      confidence_level: headers.confidence_level || "none",
      api_generation_gate_status: apiGate.status
    },
    tool_availability: toolAvailability,
    gpu_probe: {
      gpu: gpuProbe.gpu,
      nvidia_smi_error: gpuProbe.nvidia_smi_error
    },
    contract_checks: checks,
    required_codec_contract: [
      "encode/decode goal",
      "codec",
      "pixel format",
      "bit depth",
      "target platform",
      "GPU capability",
      "zero-copy claim validation"
    ],
    blockers: [...new Set(blockers.filter(Boolean))],
    missing_tools_are_graceful_skips: true,
    unsafe_assumptions_rejected: [
      "No NVENC/NVDEC support is claimed from static source evidence alone.",
      "No Video Codec SDK function signature is guessed.",
      "No zero-copy path is accepted without explicit hwframes/GPU-memory evidence.",
      "No FFmpeg/GStreamer hardware acceleration is claimed without logs proving the selected path.",
      "No PSNR, SSIM, VMAF, throughput, or utilization values are fabricated."
    ]
  };
}

function videoCodecFrameworkDetection(inventory, project) {
  const text = inventoryText(inventory);
  const detected = [];
  if (/ffmpeg|libavcodec|libavformat|avcodec|h264_nvenc|hevc_nvenc|av1_nvenc/i.test(text)) detected.push("ffmpeg/libav");
  if (/gstreamer|gst_|gst-launch|nvh264enc|nvh265enc|nvav1enc|nvh264dec|nvh265dec/i.test(text)) detected.push("gstreamer");
  if (/PyNvVideoCodec|pynvvideocodec/i.test(text) || (project?.primary_type === "python_video")) detected.push("pynvvideocodec/python");
  if (/nvEncodeAPI|NV_ENC|nvcuvid|CUVID|NVDEC/i.test(text)) detected.push("video-codec-sdk-cpp");
  let primary = "generic";
  if (detected.includes("pynvvideocodec/python")) primary = "python";
  else if (detected.includes("gstreamer")) primary = "gstreamer";
  else if (detected.includes("ffmpeg/libav")) primary = "ffmpeg";
  else if (detected.includes("video-codec-sdk-cpp")) primary = "cpp-sdk";
  return { detected: [...new Set(detected)], primary_route: primary };
}

function videoCodecToolAvailability(frameworks) {
  const ffmpeg = probeCommand("ffmpeg", ["-hide_banner", "-version"], 5000);
  const ffmpegEncoders = ffmpeg.available ? probeCommand("ffmpeg", ["-hide_banner", "-encoders"], 8000) : null;
  const ffmpegHwaccels = ffmpeg.available ? probeCommand("ffmpeg", ["-hide_banner", "-hwaccels"], 8000) : null;
  const gstLaunch = probeCommand("gst-launch-1.0", ["--version"], 5000);
  const gstInspect = probeCommand("gst-inspect-1.0", ["--version"], 5000);
  const python = probeCommand("python", ["--version"], 5000);
  const wanted = frameworks.detected || [];
  return {
    ffmpeg: {
      available: ffmpeg.available,
      execution_state: ffmpeg.available ? "available" : "plan_only_missing_tool",
      has_nvenc_encoder_clue: Boolean(ffmpegEncoders?.output && /h264_nvenc|hevc_nvenc|av1_nvenc/i.test(ffmpegEncoders.output)),
      has_cuda_hwaccel_clue: Boolean(ffmpegHwaccels?.output && /cuda/i.test(ffmpegHwaccels.output)),
      wanted: wanted.includes("ffmpeg/libav"),
      error: ffmpeg.error || null
    },
    gstreamer: {
      available: gstLaunch.available || gstInspect.available,
      execution_state: gstLaunch.available || gstInspect.available ? "available" : "plan_only_missing_tool",
      wanted: wanted.includes("gstreamer"),
      error: gstLaunch.error || gstInspect.error || null
    },
    python: {
      available: python.available,
      execution_state: python.available ? "available" : "plan_only_missing_tool",
      wanted: wanted.includes("pynvvideocodec/python"),
      error: python.error || null
    },
    note: "Missing local tools are graceful skips. Command plans remain useful, but acceleration is not claimed until logs prove the hardware path."
  };
}

function videoCodecEvidenceCheck(inventory, id, description, tokens) {
  const text = inventoryText(inventory);
  const matched = tokens.filter((token) => text.includes(lower(token)));
  return {
    id,
    description,
    status: matched.length ? "pass" : "fail",
    matched_tokens: matched,
    required_tokens_any: tokens,
    blocker: matched.length ? null : `Missing Video Codec readiness evidence: ${description}`
  };
}

function videoCodecZeroCopyCheck(inventory) {
  const text = inventoryText(inventory);
  const explicitNoClaim = /no zero-copy claim|zero-copy not claimed|not claiming zero-copy|zero copy not claimed|no zero copy claim/i.test(text);
  const claimed = !explicitNoClaim && /zero-copy|zero copy|no-copy|gpu memory path|gpu-memory path/i.test(text);
  const evidenceTokens = ["AVHWFramesContext", "hw_frames_ctx", "hwupload_cuda", "cuda surface", "GPU memory", "D3D11 texture", "D3D12 resource", "memory:NVMM", "GstCudaMemory"];
  const matched = evidenceTokens.filter((token) => text.includes(lower(token)));
  if (!claimed) {
    return {
      id: "zero_copy_claim_validation",
      description: "Zero-copy claim validation.",
      status: "pass",
      claim_state: "not_claimed",
      matched_tokens: [],
      required_tokens_any: evidenceTokens,
      blocker: null
    };
  }
  return {
    id: "zero_copy_claim_validation",
    description: "Zero-copy claim validation.",
    status: matched.length ? "pass" : "fail",
    claim_state: "claimed",
    matched_tokens: matched,
    required_tokens_any: evidenceTokens,
    blocker: matched.length ? null : "Zero-copy was claimed but no hwframes/GPU-memory evidence was observed."
  };
}

function videoCodecCommandPlans(readiness) {
  const route = readiness.pipeline_detection?.route || "generic";
  const codec = "<h264|hevc|av1>";
  const input = "<input.mp4>";
  const output = "<output.mp4>";
  return {
    selected_route: route,
    ffmpeg: {
      execution_state: readiness.tool_availability?.ffmpeg?.execution_state || "plan_only_missing_tool",
      encode_nvenc: [
        `ffmpeg -hide_banner -y -hwaccel cuda -i "${input}" -c:v h264_nvenc -pix_fmt nv12 -preset p5 -rc vbr -b:v <bitrate> "${output}"`,
        `ffmpeg -hide_banner -y -hwaccel cuda -i "${input}" -c:v hevc_nvenc -pix_fmt p010le -profile:v main10 -preset p5 -rc vbr -b:v <bitrate> "${output}"`,
        `ffmpeg -hide_banner -y -hwaccel cuda -i "${input}" -c:v av1_nvenc -pix_fmt p010le -preset p5 -b:v <bitrate> "${output}"`
      ],
      decode_nvdec: [
        `ffmpeg -hide_banner -hwaccel cuda -hwaccel_output_format cuda -i "${input}" -f null -`,
        `ffmpeg -hide_banner -benchmark -hwaccel cuda -i "${input}" -f null -`
      ],
      zero_copy_validation: [
        "Inspect FFmpeg logs for hwaccel_output_format cuda, hw_frames_ctx, hwupload_cuda, or explicit GPU-frame mapping.",
        "If logs show software frames or download/upload copies, do not claim zero-copy."
      ]
    },
    gstreamer: {
      execution_state: readiness.tool_availability?.gstreamer?.execution_state || "plan_only_missing_tool",
      encode_nvenc: [
        `gst-launch-1.0 filesrc location="${input}" ! decodebin ! videoconvert ! nvh264enc ! h264parse ! mp4mux ! filesink location="${output}"`,
        `gst-launch-1.0 filesrc location="${input}" ! decodebin ! videoconvert ! nvh265enc ! h265parse ! mp4mux ! filesink location="${output}"`
      ],
      decode_nvdec: [
        `gst-launch-1.0 filesrc location="${input}" ! qtdemux ! h264parse ! nvh264dec ! fakesink sync=false`,
        `gst-launch-1.0 filesrc location="${input}" ! decodebin ! fakesink sync=false`
      ],
      zero_copy_validation: [
        "Inspect caps for memory:NVMM, CUDAMemory, D3D11 memory, or project-specific GPU memory features.",
        "If caps negotiation falls back to system memory, do not claim zero-copy."
      ]
    },
    pynvvideocodec: {
      execution_state: readiness.tool_availability?.python?.execution_state || "plan_only_missing_tool",
      route_note: "Use PyNvVideoCodec for Python encode/decode pipelines when dependency, platform, driver, and sample media are approved.",
      command_plan: [
        "python -m pip show PyNvVideoCodec",
        `python <project-script>.py --input "${input}" --codec ${codec} --gpu 0 --validate`
      ]
    },
    cpp_sdk: {
      execution_state: readiness.real_video_codec_api_calls_allowed ? "header_grounded_adapter_ready" : "template_only_or_blocked",
      notes: [
        "Use NvencPipelineAdapter for NVENC session/capability scaffolding after local nvEncodeAPI.h symbols are confirmed.",
        "Use NvdecPipelineAdapter for NVDEC/CUVID decode capability scaffolding after local nvcuvid.h/cuviddec.h symbols are confirmed."
      ]
    }
  };
}

function videoCodecThroughputQualityValidationPlan(readiness) {
  return {
    required_steps: [
      "Run codec support/capability checks for the selected GPU, driver, codec, profile, pixel format, and bit depth before enabling NVENC/NVDEC.",
      "Run encode throughput tests with benchmark logs and confirm FFmpeg/GStreamer/SDK logs show NVENC rather than software fallback.",
      "Run decode throughput tests with benchmark logs and confirm NVDEC/CUVID/hardware decode rather than software fallback.",
      "Validate output quality with PSNR and SSIM when a matching reference is available.",
      "Run VMAF only when local FFmpeg advertises libvmaf support.",
      "Record encode/decode utilization notes separately from CUDA/graphics utilization.",
      "Validate any zero-copy claim with explicit hwframes/GPU-memory/caps evidence.",
      "Preserve software fallback and A/V sync checks until throughput and quality gates pass."
    ],
    quality_metrics: {
      psnr: "Use nvidia_quality_compare metric_set=ffmpeg-psnr-ssim or scripts/validation/quality-compare.mjs when reference/candidate files exist.",
      ssim: "Use nvidia_quality_compare metric_set=ffmpeg-psnr-ssim or scripts/validation/quality-compare.mjs when reference/candidate files exist.",
      vmaf: "Use metric_set=ffmpeg-vmaf only when FFmpeg has libvmaf; otherwise skip cleanly and report missing support."
    },
    throughput: {
      ffmpeg: "Use scripts/validation/codec-throughput.mjs or ffmpeg -benchmark logs; missing FFmpeg is a graceful skip.",
      gstreamer: "Use gst-launch/gst-inspect pipelines and caps/logs; missing GStreamer is a graceful skip.",
      python: "Use project Python benchmarks around PyNvVideoCodec; missing Python/PyNvVideoCodec is a graceful skip."
    },
    utilization_notes: [
      "NVENC/NVDEC are dedicated hardware engines; do not describe them as CUDA-core encode/decode work.",
      "Record GPU name, driver, codec, profile, bit depth, chroma, rate control, resolution, fps target, and sample clip.",
      "Keep CPU fallback logs so acceleration claims can be compared against a baseline."
    ],
    missing_tool_policy: readiness.missing_tools_are_graceful_skips
      ? "Missing FFmpeg, GStreamer, Python, VMAF, or NVIDIA GPU tools should produce plan-only output, not test failure."
      : "unknown"
  };
}

function videoCodecPipelineTypesHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "namespace nvidia_video_codec {",
    "",
    "enum class CodecGoal { Unknown, Encode, Decode, Transcode, Capture, Stream, DatasetIngest };",
    "enum class CodecId { Unknown, H264, HEVC, AV1 };",
    "enum class PixelFormat { Unknown, NV12, P010, YUV420P, BGRA8, RGBA8 };",
    "enum class TargetPlatform { Unknown, Windows, Linux };",
    "",
    "struct VideoCodecRequest {",
    "  CodecGoal goal = CodecGoal::Unknown;",
    "  CodecId codec = CodecId::Unknown;",
    "  PixelFormat pixelFormat = PixelFormat::Unknown;",
    "  TargetPlatform platform = TargetPlatform::Unknown;",
    "  std::uint32_t width = 0;",
    "  std::uint32_t height = 0;",
    "  std::uint32_t bitDepth = 8;",
    "  std::uint32_t fpsNumerator = 0;",
    "  std::uint32_t fpsDenominator = 1;",
    "  bool zeroCopyClaimed = false;",
    "  bool zeroCopyValidated = false;",
    "};",
    "",
    "struct VideoCodecCapability {",
    "  bool supported = false;",
    "  const char* reason = \"Capability has not been queried.\";",
    "};",
    "",
    "}  // namespace nvidia_video_codec",
    ""
  ];
}

function nvencPipelineAdapterHeader() {
  return [
    "#pragma once",
    "",
    "#include \"VideoCodecPipelineTypes.h\"",
    "",
    "namespace nvidia_video_codec {",
    "",
    "struct NvencAdapterDesc {",
    "  void* nativeDevice = nullptr;",
    "  const char* sdkRoot = nullptr;",
    "  const char* debugName = \"nvenc-pipeline-adapter\";",
    "};",
    "",
    "class NvencPipelineAdapter final {",
    " public:",
    "  bool Initialize(const NvencAdapterDesc& desc);",
    "  void Shutdown();",
    "  VideoCodecCapability QueryEncodeSupport(const VideoCodecRequest& request) const;",
    "  VideoCodecCapability ValidateEncodeInput(const VideoCodecRequest& request) const;",
    "",
    " private:",
    "  NvencAdapterDesc desc_{};",
    "  bool initialized_ = false;",
    "  bool localHeadersEnabled_ = false;",
    "};",
    "",
    "}  // namespace nvidia_video_codec",
    ""
  ];
}

function nvencPipelineAdapterCpp(apiGate, readiness) {
  const mode =
    apiGate.status === "header_grounded"
      ? "Local Video Codec SDK headers were detected. Add exact version-specific NVENC calls only after reviewing observed local symbols."
      : "Local Video Codec SDK headers were not sufficient for real NVENC calls. This file stays in template-only mode.";
  return [
    "#include \"NvencPipelineAdapter.h\"",
    "",
    "#if defined(NVIDIA_VIDEO_CODEC_ENABLE_REAL_API) && NVIDIA_VIDEO_CODEC_ENABLE_REAL_API",
    "#  if defined(__has_include)",
    "#    if __has_include(<nvEncodeAPI.h>)",
    "#      include <nvEncodeAPI.h>",
    "#      define NVIDIA_VIDEO_CODEC_HAS_NVENC 1",
    "#    else",
    "#      define NVIDIA_VIDEO_CODEC_HAS_NVENC 0",
    "#    endif",
    "#  else",
    "#    define NVIDIA_VIDEO_CODEC_HAS_NVENC 0",
    "#  endif",
    "#else",
    "#  define NVIDIA_VIDEO_CODEC_HAS_NVENC 0",
    "#endif",
    "",
    "namespace nvidia_video_codec {",
    "",
    "bool NvencPipelineAdapter::Initialize(const NvencAdapterDesc& desc) {",
    "  desc_ = desc;",
    "  if (!desc.nativeDevice) return false;",
    "#if NVIDIA_VIDEO_CODEC_HAS_NVENC",
    "  localHeadersEnabled_ = true;",
    "#else",
    "  localHeadersEnabled_ = false;",
    "#endif",
    `  // ${escapeCppString(mode)}`,
    "  initialized_ = true;",
    "  return true;",
    "}",
    "",
    "void NvencPipelineAdapter::Shutdown() {",
    "  initialized_ = false;",
    "  localHeadersEnabled_ = false;",
    "  desc_ = {};",
    "}",
    "",
    "VideoCodecCapability NvencPipelineAdapter::ValidateEncodeInput(const VideoCodecRequest& request) const {",
    "  if (!initialized_) return {false, \"NVENC adapter is not initialized.\"};",
    "  if (request.goal != CodecGoal::Encode && request.goal != CodecGoal::Transcode && request.goal != CodecGoal::Stream) return {false, \"Encode, transcode, or stream goal is required for NVENC.\"};",
    "  if (request.codec == CodecId::Unknown) return {false, \"Codec must be H.264, HEVC, or AV1 after capability validation.\"};",
    "  if (request.pixelFormat == PixelFormat::Unknown) return {false, \"Pixel format must be explicit.\"};",
    "  if (request.bitDepth != 8 && request.bitDepth != 10) return {false, \"Only validated 8-bit or 10-bit paths should reach the adapter.\"};",
    "  if (request.zeroCopyClaimed && !request.zeroCopyValidated) return {false, \"Zero-copy was claimed but not validated.\"};",
    "  return {true, \"Encode input contract is present; GPU codec capability and runtime logs are still required.\"};",
    "}",
    "",
    "VideoCodecCapability NvencPipelineAdapter::QueryEncodeSupport(const VideoCodecRequest& request) const {",
    "  VideoCodecCapability input = ValidateEncodeInput(request);",
    "  if (!input.supported) return input;",
    "  // TODO(host): Query NVENC codec/profile/pixel-format/bit-depth/rate-control support from the local Video Codec SDK headers.",
    `  return {false, "${escapeCppString(readiness.acceleration_working_claim_blocker)}"};`,
    "}",
    "",
    "}  // namespace nvidia_video_codec",
    ""
  ];
}

function nvdecPipelineAdapterHeader() {
  return [
    "#pragma once",
    "",
    "#include \"VideoCodecPipelineTypes.h\"",
    "",
    "namespace nvidia_video_codec {",
    "",
    "struct NvdecAdapterDesc {",
    "  void* nativeContext = nullptr;",
    "  const char* sdkRoot = nullptr;",
    "  const char* debugName = \"nvdec-pipeline-adapter\";",
    "};",
    "",
    "class NvdecPipelineAdapter final {",
    " public:",
    "  bool Initialize(const NvdecAdapterDesc& desc);",
    "  void Shutdown();",
    "  VideoCodecCapability QueryDecodeSupport(const VideoCodecRequest& request) const;",
    "  VideoCodecCapability ValidateDecodeInput(const VideoCodecRequest& request) const;",
    "",
    " private:",
    "  NvdecAdapterDesc desc_{};",
    "  bool initialized_ = false;",
    "  bool localHeadersEnabled_ = false;",
    "};",
    "",
    "}  // namespace nvidia_video_codec",
    ""
  ];
}

function nvdecPipelineAdapterCpp(apiGate, readiness) {
  const mode =
    apiGate.status === "header_grounded"
      ? "Local Video Codec SDK headers were detected. Add exact version-specific NVDEC/CUVID calls only after reviewing observed local symbols."
      : "Local Video Codec SDK headers were not sufficient for real NVDEC calls. This file stays in template-only mode.";
  return [
    "#include \"NvdecPipelineAdapter.h\"",
    "",
    "#if defined(NVIDIA_VIDEO_CODEC_ENABLE_REAL_API) && NVIDIA_VIDEO_CODEC_ENABLE_REAL_API",
    "#  if defined(__has_include)",
    "#    if __has_include(<nvcuvid.h>)",
    "#      include <nvcuvid.h>",
    "#      define NVIDIA_VIDEO_CODEC_HAS_NVDEC 1",
    "#    else",
    "#      define NVIDIA_VIDEO_CODEC_HAS_NVDEC 0",
    "#    endif",
    "#  else",
    "#    define NVIDIA_VIDEO_CODEC_HAS_NVDEC 0",
    "#  endif",
    "#else",
    "#  define NVIDIA_VIDEO_CODEC_HAS_NVDEC 0",
    "#endif",
    "",
    "namespace nvidia_video_codec {",
    "",
    "bool NvdecPipelineAdapter::Initialize(const NvdecAdapterDesc& desc) {",
    "  desc_ = desc;",
    "  if (!desc.nativeContext) return false;",
    "#if NVIDIA_VIDEO_CODEC_HAS_NVDEC",
    "  localHeadersEnabled_ = true;",
    "#else",
    "  localHeadersEnabled_ = false;",
    "#endif",
    `  // ${escapeCppString(mode)}`,
    "  initialized_ = true;",
    "  return true;",
    "}",
    "",
    "void NvdecPipelineAdapter::Shutdown() {",
    "  initialized_ = false;",
    "  localHeadersEnabled_ = false;",
    "  desc_ = {};",
    "}",
    "",
    "VideoCodecCapability NvdecPipelineAdapter::ValidateDecodeInput(const VideoCodecRequest& request) const {",
    "  if (!initialized_) return {false, \"NVDEC adapter is not initialized.\"};",
    "  if (request.goal != CodecGoal::Decode && request.goal != CodecGoal::Transcode && request.goal != CodecGoal::DatasetIngest) return {false, \"Decode, transcode, or dataset ingest goal is required for NVDEC.\"};",
    "  if (request.codec == CodecId::Unknown) return {false, \"Codec must be H.264, HEVC, or AV1 after capability validation.\"};",
    "  if (request.bitDepth != 8 && request.bitDepth != 10) return {false, \"Only validated 8-bit or 10-bit paths should reach the adapter.\"};",
    "  if (request.zeroCopyClaimed && !request.zeroCopyValidated) return {false, \"Zero-copy was claimed but not validated.\"};",
    "  return {true, \"Decode input contract is present; GPU codec capability and runtime logs are still required.\"};",
    "}",
    "",
    "VideoCodecCapability NvdecPipelineAdapter::QueryDecodeSupport(const VideoCodecRequest& request) const {",
    "  VideoCodecCapability input = ValidateDecodeInput(request);",
    "  if (!input.supported) return input;",
    "  // TODO(host): Query NVDEC/CUVID codec/profile/pixel-format/bit-depth support from the local Video Codec SDK headers.",
    `  return {false, "${escapeCppString(readiness.acceleration_working_claim_blocker)}"};`,
    "}",
    "",
    "}  // namespace nvidia_video_codec",
    ""
  ];
}

function videoCodecCmakeWiring() {
  return [
    "# Video Codec SDK native adapter wiring.",
    "# Include from the native codec/media pipeline CMakeLists.txt after reviewing generated sources.",
    "",
    "option(NVIDIA_VIDEO_CODEC_ENABLE \"Enable generated NVENC/NVDEC adapters\" OFF)",
    "option(NVIDIA_VIDEO_CODEC_ENABLE_REAL_API \"Enable compile-time Video Codec SDK include gate\" OFF)",
    "set(NVIDIA_VIDEO_CODEC_SDK_ROOT \"\" CACHE PATH \"Path to a local, user-provided Video Codec SDK root\")",
    "",
    "if(NVIDIA_VIDEO_CODEC_ENABLE)",
    "  add_library(nvidia_video_codec_adapters",
    "    src/nvidia_video/NvencPipelineAdapter.cpp",
    "    src/nvidia_video/NvdecPipelineAdapter.cpp",
    "  )",
    "  target_include_directories(nvidia_video_codec_adapters PUBLIC \"${CMAKE_CURRENT_LIST_DIR}/../src\")",
    "  if(NVIDIA_VIDEO_CODEC_ENABLE_REAL_API)",
    "    if(NOT NVIDIA_VIDEO_CODEC_SDK_ROOT)",
    "      message(FATAL_ERROR \"Set NVIDIA_VIDEO_CODEC_SDK_ROOT to a local Video Codec SDK root. This kit does not download SDKs.\")",
    "    endif()",
    "    set(NVIDIA_VIDEO_CODEC_INCLUDE_DIR \"${NVIDIA_VIDEO_CODEC_SDK_ROOT}/include\" CACHE PATH \"Video Codec SDK include directory\")",
    "    if(NOT EXISTS \"${NVIDIA_VIDEO_CODEC_INCLUDE_DIR}/nvEncodeAPI.h\")",
    "      message(FATAL_ERROR \"nvEncodeAPI.h not found under ${NVIDIA_VIDEO_CODEC_INCLUDE_DIR}\")",
    "    endif()",
    "    target_include_directories(nvidia_video_codec_adapters PUBLIC \"${NVIDIA_VIDEO_CODEC_INCLUDE_DIR}\")",
    "    target_compile_definitions(nvidia_video_codec_adapters PUBLIC NVIDIA_VIDEO_CODEC_ENABLE_REAL_API=1)",
    "  else()",
    "    target_compile_definitions(nvidia_video_codec_adapters PUBLIC NVIDIA_VIDEO_CODEC_ENABLE_REAL_API=0)",
    "  endif()",
    "endif()",
    ""
  ];
}

function videoCodecNativePipelineNotes(readiness, commandPlans, validationPlan) {
  return [
    "# Video Codec SDK / NVENC / NVDEC Native Pipeline Kit",
    "",
    `Readiness state: ${readiness.state}`,
    `Detected framework route: ${readiness.pipeline_detection.route}`,
    `Real Video Codec SDK API calls allowed: ${readiness.real_video_codec_api_calls_allowed ? "yes, after reviewed local-header implementation" : "no"}`,
    `Acceleration working claim allowed: ${readiness.acceleration_working_claim_allowed ? "yes" : "no"}`,
    "",
    "## Scope",
    "",
    "- Encode/decode/transcode/capture/streaming pipelines.",
    "- NVENC adapter scaffolding.",
    "- NVDEC adapter scaffolding.",
    "- FFmpeg hardware acceleration command plans.",
    "- GStreamer command plans.",
    "- PyNvVideoCodec route notes for Python pipelines.",
    "- No SDK downloads or binary copying.",
    "",
    "## Required Contract",
    "",
    ...readiness.required_codec_contract.map((item) => `- ${item}`),
    "",
    "## Contract Checks",
    "",
    ...Object.values(readiness.contract_checks).map((check) => `- ${check.id}: ${check.status}${check.matched_tokens?.length ? ` (${check.matched_tokens.join(", ")})` : check.claim_state ? ` (${check.claim_state})` : ""}`),
    "",
    "## Tool Availability",
    "",
    `- FFmpeg: ${readiness.tool_availability.ffmpeg.execution_state}`,
    `- GStreamer: ${readiness.tool_availability.gstreamer.execution_state}`,
    `- Python: ${readiness.tool_availability.python.execution_state}`,
    `- ${readiness.tool_availability.note}`,
    "",
    "## FFmpeg Command Plans",
    "",
    ...commandPlans.ffmpeg.encode_nvenc.map((item) => `- \`${item}\``),
    ...commandPlans.ffmpeg.decode_nvdec.map((item) => `- \`${item}\``),
    "",
    "## GStreamer Command Plans",
    "",
    ...commandPlans.gstreamer.encode_nvenc.map((item) => `- \`${item}\``),
    ...commandPlans.gstreamer.decode_nvdec.map((item) => `- \`${item}\``),
    "",
    "## PyNvVideoCodec Route",
    "",
    `- ${commandPlans.pynvvideocodec.route_note}`,
    ...commandPlans.pynvvideocodec.command_plan.map((item) => `- \`${item}\``),
    "",
    "## Throughput And Quality Validation",
    "",
    ...validationPlan.required_steps.map((item) => `- ${item}`),
    "",
    "## Metrics",
    "",
    `- PSNR: ${validationPlan.quality_metrics.psnr}`,
    `- SSIM: ${validationPlan.quality_metrics.ssim}`,
    `- VMAF: ${validationPlan.quality_metrics.vmaf}`,
    "",
    "## Utilization Notes",
    "",
    ...validationPlan.utilization_notes.map((item) => `- ${item}`),
    "",
    "## Blockers",
    "",
    ...(readiness.blockers.length ? readiness.blockers.map((item) => `- ${item}`) : ["- None from static inspection."]),
    ""
  ];
}

function rtxVideoNativePipelineKit(context, apiGate, baseValidation) {
  const readiness = rtxVideoNativeReadiness(context, apiGate);
  const validationHarness = rtxVideoValidationHarness(readiness);
  const files =
    readiness.state === "rejected_browser_only_requires_native_boundary"
      ? [
          scaffoldFile(
            "docs/nvidia/rtx-video-native-boundary.md",
            "markdown",
            "Boundary plan for using RTX Video SDK from a native companion/backend instead of browser-only code.",
            rtxVideoBrowserBoundaryNotes(readiness)
          )
        ]
      : [
          scaffoldFile("src/nvidia_video/RtxVideoFrame.h", "cpp", "RTX Video frame, format, API route, and effect-setting contracts.", rtxVideoFrameHeader()),
          scaffoldFile("src/nvidia_video/RtxVideoEnhancer.h", "cpp", "Native RTX Video enhancer interface for media-player frame enhancement.", rtxVideoEnhancerHeader()),
          scaffoldFile("src/nvidia_video/RtxVideoEnhancer.cpp", "cpp", "Header-gated RTX Video enhancer shell with explicit frame/effect validation and no guessed SDK calls.", rtxVideoEnhancerCpp(apiGate, readiness)),
          scaffoldFile("cmake/NvidiaRtxVideo.cmake", "cmake", "CMake wiring for user-provided RTX Video SDK include paths and the generated native adapter.", rtxVideoCmakeWiring()),
          scaffoldFile("docs/nvidia/rtx-video-native-pipeline-kit.md", "markdown", "Validation harness and integration boundaries for RTX Video SDK media enhancement.", rtxVideoNativePipelineNotes(readiness, validationHarness))
        ];
  return {
    summary: "Create a gated RTX Video SDK native media pipeline kit for Super Resolution, artifact reduction, and SDR-to-HDR. This is separate from DLSS and Optical Flow FRUC.",
    implementation_readiness: readiness,
    contract_checks: readiness.contract_checks,
    build_system_detection: readiness.build_system_detection,
    validation_harness: validationHarness,
    files,
    host_repo_edits_required:
      readiness.state === "rejected_browser_only_requires_native_boundary"
        ? [
            "Do not add RTX Video SDK calls to browser-only code.",
            "Choose a native companion, Electron/native backend, native app/plugin, or server-side NVIDIA GPU pipeline.",
            "Define IPC/frame sharing, copy count, latency, media privacy, and process lifetime before adapter generation."
          ]
        : [
            "Add the generated RtxVideoEnhancer.cpp and RtxVideoFrame.h files to the narrow native media-player/video target after review.",
            "Wire the generated CMake include only after setting a local, license-approved RTX Video SDK root.",
            "Map host media resources explicitly: decoded input frame, color format, 8-bit/10-bit bit depth, SDR/HDR metadata, DX11/DX12/Vulkan/CUDA route, and output surface ownership.",
            "Validate Super Resolution, artifact reduction, and SDR-to-HDR independently before exposing user-facing toggles.",
            "Keep DLSS, Optical Flow FRUC, and Video Codec SDK encode/decode work as separate routes and patches."
          ],
    validation_plan: mergePlan(baseValidation, validationHarness.required_steps),
    rollback_plan: rollbackPlan("Remove the generated src/nvidia_video files and CMake include/import. Keep the original media playback path and output surface untouched."),
    sources: sourceRefs(["rtx-video-sdk", "nvidia-optical-flow-sdk", "nvidia-dlss"])
  };
}

function rtxVideoNativeReadiness(context, apiGate) {
  const project = context.project || {};
  const graphicsApis = project.graphics_apis || [];
  const languages = project.languages || [];
  const buildSystems = project.build_systems || [];
  const contentPaths = project.content_paths || [];
  const projectTypeNames = (project.project_types || []).map((item) => item.name);
  const isBrowserOnly = project && context.inventory ? isBrowserOnlyProject(project, context.inventory) : false;
  const isNativeLanguage = languages.some((language) => /C\/C\+\+|C\+\+|C\/C|Rust|Python|CUDA/i.test(language));
  const hasNativeBuild = buildSystems.some((item) => /CMake|MSBuild|Visual Studio|Python|Cargo/i.test(item));
  const hasMediaPath = contentPaths.includes("media_playback") || contentPaths.includes("video_encode_decode") || projectTypeNames.includes("video_pipeline");
  const apiRoute = rtxVideoApiRoute(graphicsApis, context.inventory);
  const buildSystemDetection = {
    cmake: buildSystems.includes("CMake"),
    msbuild: buildSystems.includes("MSBuild/Visual Studio"),
    python: buildSystems.includes("Python"),
    detected: buildSystems.filter((item) => /CMake|MSBuild|Visual Studio|Python|Cargo/i.test(item)),
    state: hasNativeBuild ? "supported_native_build_system_detected" : "native_build_system_unknown"
  };
  const headers = context.headerGrounding || {};
  const hasRtxVideoHeaders = Boolean(headers.relevant_headers?.length);
  const checks = {
    input_video_frames: rtxVideoEvidenceCheck(context.inventory, "input_video_frames", "Decoded input video frames before presentation/export.", ["decoded frame", "video frame", "frame surface", "media foundation", "avframe", "input frame"]),
    color_format: rtxVideoEvidenceCheck(context.inventory, "color_format", "Color format such as NV12, P010, RGBA, or BGRA.", ["nv12", "p010", "rgba", "bgra", "color format", "format"]),
    bit_depth_8_10: rtxVideoEvidenceCheck(context.inventory, "bit_depth_8_10", "8-bit and/or 10-bit bit-depth handling.", ["8-bit", "10-bit", "bit depth", "p010", "nv12"]),
    sdr_hdr_path: rtxVideoEvidenceCheck(context.inventory, "sdr_hdr_path", "SDR/HDR metadata and SDR-to-HDR path.", ["sdr", "hdr", "hdr10", "sdr-to-hdr", "sdr to hdr", "color space", "colorspace"]),
    api_route: {
      id: "api_route",
      description: "DX11, DX12, Vulkan, or CUDA native route.",
      status: apiRoute.status,
      matched_tokens: apiRoute.matched,
      required_tokens_any: ["D3D11", "D3D12", "Vulkan", "CUDA", "DX11", "DX12"],
      blocker: apiRoute.status === "pass" ? null : "Missing RTX Video readiness evidence: DX11/DX12/Vulkan/CUDA native route."
    },
    output_surface_ownership: rtxVideoEvidenceCheck(context.inventory, "output_surface_ownership", "Output surface ownership for display or export.", ["output surface", "render target", "present", "display path", "swapchain", "export surface"])
  };
  const failedChecks = Object.values(checks).filter((check) => check.status !== "pass");
  const blockers = [];
  if (isBrowserOnly) blockers.push("Browser-only project cannot call native RTX Video SDK APIs directly; use a native companion, native app/plugin, Electron/native backend, or server-side NVIDIA GPU pipeline.");
  if (!context.root) blockers.push("project_path is required to prove media-player/native pipeline readiness.");
  if (!isNativeLanguage) blockers.push("Native media code was not detected.");
  if (!hasMediaPath) blockers.push("Media playback or decoded-frame path was not detected.");
  if (buildSystemDetection.state === "native_build_system_unknown") blockers.push("Native build-system evidence was not detected.");
  blockers.push(...failedChecks.map((check) => check.blocker));
  if (!hasRtxVideoHeaders) blockers.push("Local or project-vendored RTX Video SDK headers were not detected.");
  if (hasRtxVideoHeaders && !headers.can_generate_real_api_guidance) {
    blockers.push(`RTX Video SDK headers were detected but required symbols are missing: ${(headers.missing_required_symbols || []).join(", ") || "unknown"}.`);
  }

  let state = "rtx_video_native_pipeline_ready";
  if (isBrowserOnly) state = "rejected_browser_only_requires_native_boundary";
  else if (!context.root) state = "needs_project_inspection_template_only";
  else if (!isNativeLanguage || !hasMediaPath) state = "blocked_not_native_media_project";
  else if (failedChecks.length) state = "blocked_missing_rtx_video_contract";
  else if (!hasRtxVideoHeaders) state = "blocked_missing_rtx_video_sdk";
  else if (!headers.can_generate_real_api_guidance) state = "limited_missing_rtx_video_symbols_template_only";
  else if (buildSystemDetection.state === "native_build_system_unknown") state = "header_grounded_build_system_unknown";

  return {
    state,
    native_pipeline_generation_allowed: !["rejected_browser_only_requires_native_boundary", "blocked_not_native_media_project", "blocked_missing_rtx_video_contract"].includes(state),
    real_rtx_video_api_calls_allowed: state === "rtx_video_native_pipeline_ready" || state === "header_grounded_build_system_unknown",
    enhancement_working_claim_allowed: false,
    enhancement_working_claim_blocker: "This kit only proves native adapter/readiness scaffolding. RTX Video enhancement can be claimed only after the adapter compiles against local SDK headers and SR/artifact-reduction/SDR-to-HDR validation artifacts exist.",
    project_root: context.root,
    media_project_detection: {
      media_path_detected: hasMediaPath,
      native_language_detected: isNativeLanguage,
      browser_only: isBrowserOnly,
      content_paths: contentPaths,
      project_types: projectTypeNames,
      languages,
      relevant_files: selectRelevantFiles(context.inventory, "ffmpeg-gstreamer").slice(0, 24)
    },
    build_system_detection: buildSystemDetection,
    api_route: apiRoute,
    rtx_video_sdk_requirement: {
      state: hasRtxVideoHeaders ? "sdk_headers_detected" : "sdk_path_required",
      detected_sdk_root: headers.detected_sdk_root || null,
      detected_version: headers.detected_version || null,
      required_symbols: headers.required_symbols || [],
      missing_required_symbols: headers.missing_required_symbols || [],
      relevant_headers: headers.relevant_headers || [],
      confidence_level: headers.confidence_level || "none",
      api_generation_gate_status: apiGate.status
    },
    contract_checks: checks,
    required_frame_contract: [
      "input video frames",
      "color format",
      "8-bit/10-bit support",
      "SDR/HDR path",
      "DX11/DX12/Vulkan/CUDA route",
      "output surface ownership"
    ],
    explicit_route_separation: {
      rtx_video_sdk: "Video enhancement: Super Resolution, artifact reduction, and SDR-to-HDR.",
      dlss_streamline: "Rejected for generic decoded video enhancement; DLSS is for real-time rendered frames.",
      optical_flow_fruc: "Rejected for enhancement-only goals; Optical Flow FRUC is for frame-rate up-conversion/interpolation.",
      video_codec_sdk: "Separate encode/decode/transcode control plane; not the enhancement effect route."
    },
    native_boundary_recommendation: isBrowserOnly
      ? {
          required: true,
          routes: ["native companion process", "Electron/native backend", "native app/plugin architecture", "server-side NVIDIA GPU pipeline"],
          reason: "Pure browser code cannot be assumed to call RTX Video SDK directly."
        }
      : { required: false },
    blockers: [...new Set(blockers.filter(Boolean))],
    unsafe_assumptions_rejected: [
      "No RTX Video SDK runtime support is claimed from static source evidence alone.",
      "No RTX Video SDK function signature is guessed.",
      "No browser-only native SDK access is claimed.",
      "No SDK download, binary copy, binary packaging, or redistribution is performed.",
      "No DLSS or Optical Flow FRUC path is generated by this RTX Video enhancement kit."
    ]
  };
}

function rtxVideoApiRoute(graphicsApis, inventory) {
  const text = inventoryText(inventory);
  const matched = [];
  for (const api of ["D3D11", "D3D12", "Vulkan", "CUDA"]) {
    if (graphicsApis.includes(api) || text.includes(lower(api))) matched.push(api);
  }
  if (text.includes("dx11")) matched.push("DX11");
  if (text.includes("dx12")) matched.push("DX12");
  return {
    status: matched.length ? "pass" : "fail",
    matched: [...new Set(matched)],
    supported_routes: ["DX11", "DX12", "Vulkan", "CUDA"]
  };
}

function rtxVideoEvidenceCheck(inventory, id, description, tokens) {
  const text = inventoryText(inventory);
  const matched = tokens.filter((token) => text.includes(lower(token)));
  return {
    id,
    description,
    status: matched.length ? "pass" : "fail",
    matched_tokens: matched,
    required_tokens_any: tokens,
    blocker: matched.length ? null : `Missing RTX Video readiness evidence: ${description}`
  };
}

function rtxVideoValidationHarness(readiness) {
  const sdkRoot = readiness.rtx_video_sdk_requirement?.detected_sdk_root || "<RTX_VIDEO_SDK_ROOT>";
  return {
    required_steps: [
      "Compile the native RtxVideoEnhancer bridge against the selected local RTX Video SDK headers or keep it in explicit template-only mode.",
      "Validate Super Resolution with approved 8-bit and 10-bit clips where the local SDK and project frame path support both.",
      "Validate artifact reduction separately from Super Resolution on low-bitrate source material.",
      "Validate SDR-to-HDR separately with HDR metadata, display/output path, and visual review notes.",
      "Measure playback latency, dropped frames, copy count, and throughput without fabricating FPS or quality metrics.",
      "Preserve the original playback/fallback path and disable RTX Video effects when runtime support or required frame contract is missing."
    ],
    compile_commands: [
      `cmake -S . -B build -DNVIDIA_RTX_VIDEO_SDK_ROOT="${sdkRoot}" -DNVIDIA_RTX_VIDEO_ENABLE_REAL_API=ON`,
      "cmake --build build --config RelWithDebInfo",
      `msbuild <YourMediaPlayer>.sln /p:NvidiaRtxVideoSdkRoot="${sdkRoot}" /p:NvidiaRtxVideoEnableRealApi=true /p:Configuration=RelWithDebInfo`
    ],
    effect_validation: {
      super_resolution: [
        "Input clip and frame format recorded.",
        "Source and target resolution recorded.",
        "Before/after still frames or approved output clip captured locally.",
        "Latency and dropped-frame notes collected."
      ],
      artifact_reduction: [
        "Low-bitrate/compression-artifact source selected.",
        "Artifact reduction tested independently from upscaling.",
        "Before/after comparisons and quality notes captured locally."
      ],
      sdr_to_hdr: [
        "Input SDR metadata and output HDR path recorded.",
        "HDR display/export route validated separately from enhancement.",
        "Rollback/fallback to SDR path verified."
      ]
    },
    expected_artifacts: [
      "compile log",
      "runtime capability log",
      "effect settings JSON or app config snapshot",
      "approved before/after frame captures or clips",
      "latency/throughput/dropped-frame notes",
      "HDR output validation notes when SDR-to-HDR is enabled"
    ],
    safety_notes: [
      "No SDK download or binary copy.",
      "No browser-only native SDK claim.",
      "No DLSS route for decoded video enhancement.",
      "No Optical Flow FRUC route unless the user asks for frame-rate up-conversion."
    ]
  };
}

function rtxVideoFrameHeader() {
  return [
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "namespace nvidia_video {",
    "",
    "enum class RtxVideoApiRoute {",
    "  Unknown,",
    "  D3D11,",
    "  D3D12,",
    "  Vulkan,",
    "  CUDA",
    "};",
    "",
    "enum class RtxVideoColorFormat {",
    "  Unknown,",
    "  NV12,",
    "  P010,",
    "  RGBA8,",
    "  BGRA8,",
    "  RGBA16F",
    "};",
    "",
    "enum class RtxVideoColorSpace {",
    "  Unknown,",
    "  SDR_BT709,",
    "  HDR10_BT2020",
    "};",
    "",
    "struct RtxVideoFrame {",
    "  void* nativeResource = nullptr;",
    "  void* nativeDevice = nullptr;",
    "  void* nativeQueueOrContext = nullptr;",
    "  RtxVideoApiRoute apiRoute = RtxVideoApiRoute::Unknown;",
    "  RtxVideoColorFormat format = RtxVideoColorFormat::Unknown;",
    "  RtxVideoColorSpace colorSpace = RtxVideoColorSpace::Unknown;",
    "  std::uint32_t width = 0;",
    "  std::uint32_t height = 0;",
    "  std::uint32_t bitDepth = 8;",
    "  std::uint64_t pts100ns = 0;",
    "  const char* debugName = nullptr;",
    "};",
    "",
    "struct RtxVideoEffectSettings {",
    "  bool superResolution = false;",
    "  bool artifactReduction = false;",
    "  bool sdrToHdr = false;",
    "  float outputScale = 1.0f;",
    "  float sharpness = 0.0f;",
    "  float artifactReductionStrength = 0.0f;",
    "  bool requireHdrOutputPath = true;",
    "};",
    "",
    "struct RtxVideoEnhancementResult {",
    "  bool success = false;",
    "  const char* reason = \"RTX Video enhancement has not run.\";",
    "};",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function rtxVideoEnhancerHeader() {
  return [
    "#pragma once",
    "",
    "#include \"RtxVideoFrame.h\"",
    "",
    "namespace nvidia_video {",
    "",
    "struct RtxVideoEnhancerDesc {",
    "  RtxVideoApiRoute apiRoute = RtxVideoApiRoute::Unknown;",
    "  void* nativeDevice = nullptr;",
    "  void* nativeQueueOrContext = nullptr;",
    "  const char* sdkRoot = nullptr;",
    "  const char* debugName = \"rtx-video-enhancer\";",
    "};",
    "",
    "struct RtxVideoCapability {",
    "  bool initialized = false;",
    "  bool localHeadersEnabled = false;",
    "  bool inputFrameContractValid = false;",
    "  bool outputSurfaceOwned = false;",
    "  const char* reason = \"RtxVideoEnhancer has not been initialized.\";",
    "};",
    "",
    "class RtxVideoEnhancer final {",
    " public:",
    "  bool Initialize(const RtxVideoEnhancerDesc& desc);",
    "  void Shutdown();",
    "  RtxVideoEnhancementResult ValidateFrame(const RtxVideoFrame& input, const RtxVideoFrame& output, const RtxVideoEffectSettings& settings) const;",
    "  RtxVideoEnhancementResult Enhance(const RtxVideoFrame& input, const RtxVideoFrame& output, const RtxVideoEffectSettings& settings);",
    "  const RtxVideoCapability& Capability() const { return capability_; }",
    "",
    " private:",
    "  RtxVideoEnhancerDesc desc_{};",
    "  RtxVideoCapability capability_{};",
    "};",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function rtxVideoEnhancerCpp(apiGate, readiness) {
  const apiModeComment =
    apiGate.status === "header_grounded"
      ? "Local RTX Video SDK headers were detected. Add exact version-specific calls only after reviewing observed local symbols."
      : "Local RTX Video SDK headers were not sufficient for real SDK calls. This file stays in template-only mode.";
  return [
    "#include \"RtxVideoEnhancer.h\"",
    "",
    "#if defined(NVIDIA_RTX_VIDEO_ENABLE_REAL_API) && NVIDIA_RTX_VIDEO_ENABLE_REAL_API",
    "#  if defined(__has_include)",
    "#    if __has_include(<RtxVideoSDK.h>)",
    "#      include <RtxVideoSDK.h>",
    "#      define NVIDIA_RTX_VIDEO_HAS_SDK 1",
    "#    else",
    "#      define NVIDIA_RTX_VIDEO_HAS_SDK 0",
    "#    endif",
    "#  else",
    "#    define NVIDIA_RTX_VIDEO_HAS_SDK 0",
    "#  endif",
    "#else",
    "#  define NVIDIA_RTX_VIDEO_HAS_SDK 0",
    "#endif",
    "",
    "namespace nvidia_video {",
    "",
    "bool RtxVideoEnhancer::Initialize(const RtxVideoEnhancerDesc& desc) {",
    "  desc_ = desc;",
    "  capability_ = {};",
    "  if (!desc.nativeDevice || desc.apiRoute == RtxVideoApiRoute::Unknown) {",
    "    capability_.reason = \"RTX Video enhancer requires a native device and DX11/DX12/Vulkan/CUDA route.\";",
    "    return false;",
    "  }",
    `  // ${escapeCppString(apiModeComment)}`,
    "#if NVIDIA_RTX_VIDEO_HAS_SDK",
    "  capability_.localHeadersEnabled = true;",
    "#else",
    "  capability_.localHeadersEnabled = false;",
    "#endif",
    "  capability_.initialized = true;",
    "  capability_.reason = \"Enhancer initialized; runtime SDK capability query remains a host integration step.\";",
    "  return true;",
    "}",
    "",
    "void RtxVideoEnhancer::Shutdown() {",
    "  capability_ = {};",
    "  desc_ = {};",
    "}",
    "",
    "RtxVideoEnhancementResult RtxVideoEnhancer::ValidateFrame(const RtxVideoFrame& input, const RtxVideoFrame& output, const RtxVideoEffectSettings& settings) const {",
    "  if (!capability_.initialized) return {false, \"RTX Video enhancer is not initialized.\"};",
    "  if (!input.nativeResource) return {false, \"Input video frame resource is required.\"};",
    "  if (!output.nativeResource) return {false, \"Output surface ownership is required.\"};",
    "  if (input.apiRoute == RtxVideoApiRoute::Unknown || output.apiRoute == RtxVideoApiRoute::Unknown) return {false, \"Input and output API routes must be explicit.\"};",
    "  if (input.width == 0 || input.height == 0 || output.width == 0 || output.height == 0) return {false, \"Input and output dimensions are required.\"};",
    "  if (input.format == RtxVideoColorFormat::Unknown) return {false, \"Input color format must be known.\"};",
    "  if (input.bitDepth != 8 && input.bitDepth != 10) return {false, \"Only validated 8-bit or 10-bit inputs should reach the RTX Video adapter.\"};",
    "  if (settings.sdrToHdr && settings.requireHdrOutputPath && output.colorSpace != RtxVideoColorSpace::HDR10_BT2020) return {false, \"SDR-to-HDR requires a validated HDR output path.\"};",
    "  if (!settings.superResolution && !settings.artifactReduction && !settings.sdrToHdr) return {false, \"At least one RTX Video enhancement effect must be selected.\"};",
    "  return {true, \"RTX Video frame contract is present; runtime support and quality validation are still required.\"};",
    "}",
    "",
    "RtxVideoEnhancementResult RtxVideoEnhancer::Enhance(const RtxVideoFrame& input, const RtxVideoFrame& output, const RtxVideoEffectSettings& settings) {",
    "  RtxVideoEnhancementResult validation = ValidateFrame(input, output, settings);",
    "  capability_.inputFrameContractValid = validation.success;",
    "  capability_.outputSurfaceOwned = output.nativeResource != nullptr;",
    "  if (!validation.success) {",
    "    capability_.reason = validation.reason;",
    "    return validation;",
    "  }",
    "  // TODO(host): Query RTX Video SDK runtime support for Super Resolution, artifact reduction, and SDR-to-HDR separately.",
    "  // TODO(host): Convert RtxVideoFrame/RtxVideoEffectSettings into exact local SDK descriptors after inspecting installed headers.",
    "  // TODO(host): Preserve the original media playback path and disable effects when support or validation is missing.",
    `  capability_.reason = "${escapeCppString(readiness.enhancement_working_claim_blocker)}";`,
    "  return {false, capability_.reason};",
    "}",
    "",
    "}  // namespace nvidia_video",
    ""
  ];
}

function rtxVideoCmakeWiring() {
  return [
    "# RTX Video SDK native pipeline wiring.",
    "# Include from the native media-player/video CMakeLists.txt after reviewing generated sources.",
    "",
    "option(NVIDIA_RTX_VIDEO_ENABLE \"Enable generated RTX Video native enhancer adapter\" OFF)",
    "option(NVIDIA_RTX_VIDEO_ENABLE_REAL_API \"Enable compile-time RTX Video SDK include gate\" OFF)",
    "set(NVIDIA_RTX_VIDEO_SDK_ROOT \"\" CACHE PATH \"Path to a local, user-provided RTX Video SDK root\")",
    "",
    "if(NVIDIA_RTX_VIDEO_ENABLE)",
    "  add_library(nvidia_rtx_video_enhancer",
    "    src/nvidia_video/RtxVideoEnhancer.cpp",
    "  )",
    "  target_include_directories(nvidia_rtx_video_enhancer PUBLIC \"${CMAKE_CURRENT_LIST_DIR}/../src\")",
    "  if(NVIDIA_RTX_VIDEO_ENABLE_REAL_API)",
    "    if(NOT NVIDIA_RTX_VIDEO_SDK_ROOT)",
    "      message(FATAL_ERROR \"Set NVIDIA_RTX_VIDEO_SDK_ROOT to a local RTX Video SDK root. This kit does not download SDKs.\")",
    "    endif()",
    "    set(NVIDIA_RTX_VIDEO_INCLUDE_DIR \"${NVIDIA_RTX_VIDEO_SDK_ROOT}/include\" CACHE PATH \"RTX Video SDK include directory\")",
    "    if(NOT EXISTS \"${NVIDIA_RTX_VIDEO_INCLUDE_DIR}/RtxVideoSDK.h\")",
    "      message(FATAL_ERROR \"RtxVideoSDK.h not found under ${NVIDIA_RTX_VIDEO_INCLUDE_DIR}\")",
    "    endif()",
    "    target_include_directories(nvidia_rtx_video_enhancer PUBLIC \"${NVIDIA_RTX_VIDEO_INCLUDE_DIR}\")",
    "    target_compile_definitions(nvidia_rtx_video_enhancer PUBLIC NVIDIA_RTX_VIDEO_ENABLE_REAL_API=1)",
    "  else()",
    "    target_compile_definitions(nvidia_rtx_video_enhancer PUBLIC NVIDIA_RTX_VIDEO_ENABLE_REAL_API=0)",
    "  endif()",
    "endif()",
    ""
  ];
}

function rtxVideoNativePipelineNotes(readiness, validationHarness) {
  return [
    "# RTX Video SDK Native Pipeline Kit",
    "",
    `Readiness state: ${readiness.state}`,
    `Real RTX Video API calls allowed: ${readiness.real_rtx_video_api_calls_allowed ? "yes, after reviewed local-header implementation" : "no"}`,
    `Enhancement working claim allowed: ${readiness.enhancement_working_claim_allowed ? "yes" : "no"}`,
    "",
    "## Scope",
    "",
    "- Native media-player/video enhancement pipeline only.",
    "- RTX Video SDK is for Super Resolution, artifact reduction, and SDR-to-HDR video enhancement.",
    "- This is not DLSS.",
    "- This is not Optical Flow FRUC frame interpolation.",
    "- No browser-only native SDK claims.",
    "- No SDK downloads, binary copies, binary packaging, or redistribution.",
    "",
    "## Required Frame Contract",
    "",
    ...readiness.required_frame_contract.map((item) => `- ${item}`),
    "",
    "## Contract Checks",
    "",
    ...Object.values(readiness.contract_checks).map((check) => `- ${check.id}: ${check.status}${check.matched_tokens?.length ? ` (${check.matched_tokens.join(", ")})` : ""}`),
    "",
    "## Validation Harness",
    "",
    ...validationHarness.required_steps.map((item) => `- ${item}`),
    "",
    "## Compile Commands",
    "",
    ...validationHarness.compile_commands.map((item) => `- \`${item}\``),
    "",
    "## Effects",
    "",
    "- Super Resolution: validate independently from artifact reduction and SDR-to-HDR.",
    "- Artifact reduction: validate independently on compression-artifact source material.",
    "- SDR-to-HDR: validate output/display path separately from enhancement quality.",
    "",
    "## Route Separation",
    "",
    `- RTX Video SDK: ${readiness.explicit_route_separation.rtx_video_sdk}`,
    `- DLSS/Streamline: ${readiness.explicit_route_separation.dlss_streamline}`,
    `- Optical Flow FRUC: ${readiness.explicit_route_separation.optical_flow_fruc}`,
    `- Video Codec SDK: ${readiness.explicit_route_separation.video_codec_sdk}`,
    "",
    "## Blockers",
    "",
    ...(readiness.blockers.length ? readiness.blockers.map((item) => `- ${item}`) : ["- None from static inspection."]),
    ""
  ];
}

function rtxVideoBrowserBoundaryNotes(readiness) {
  const recommendation = readiness.native_boundary_recommendation || {};
  return [
    "# RTX Video SDK Browser Boundary",
    "",
    "This project was detected as browser-only. Do not add native RTX Video SDK calls to browser JavaScript, extensions, WebGPU, or WebCodecs code.",
    "",
    "Use one of these boundaries instead:",
    "",
    ...((recommendation.routes || ["native companion process", "Electron/native backend", "native app/plugin architecture", "server-side NVIDIA GPU pipeline"]).map((item) => `- ${item}`)),
    "",
    "Required design decisions before adapter generation:",
    "",
    "- frame ownership and legal media access path",
    "- IPC protocol and backpressure",
    "- texture/frame copy count",
    "- latency budget",
    "- user media privacy boundary",
    "- native process lifetime and crash recovery",
    "",
    "Route separation:",
    "",
    "- RTX Video SDK is for video enhancement.",
    "- DLSS is for real-time rendered frames.",
    "- Optical Flow FRUC is for frame-rate up-conversion.",
    "",
    "No SDK download, binary copy, upload, or browser-only native claim is performed by this plugin.",
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

function unrealDlssProjectValidationScript() {
  return [
    "param(",
    "  [string]$ProjectRoot = (Get-Location).Path",
    ")",
    "",
    "$ErrorActionPreference = 'Stop'",
    "$uproject = Get-ChildItem -LiteralPath $ProjectRoot -Filter '*.uproject' -File | Select-Object -First 1",
    "if (!$uproject) { throw \"No .uproject file found in $ProjectRoot\" }",
    "$json = Get-Content -LiteralPath $uproject.FullName -Raw | ConvertFrom-Json",
    "$pluginDescriptors = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'Plugins') -Recurse -Filter '*.uplugin' -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'NVIDIA|DLSS|Streamline|Reflex|NGX|NIS' })",
    "$pluginEntries = @($json.Plugins | Where-Object { $_.Name -match 'NVIDIA|DLSS|Streamline|Reflex|NGX|NIS' })",
    "$configFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'Config') -Filter '*.ini' -File -ErrorAction SilentlyContinue)",
    "$configHits = @()",
    "foreach ($file in $configFiles) {",
    "  $hits = Select-String -LiteralPath $file.FullName -Pattern 'DLSS|Streamline|Reflex|NVIDIA|NGX|r\\.DLSS|r\\.Streamline' -SimpleMatch:$false -ErrorAction SilentlyContinue",
    "  foreach ($hit in $hits) { $configHits += [pscustomobject]@{ file = $file.FullName; line = $hit.LineNumber; text = $hit.Line.Trim() } }",
    "}",
    "$logs = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'Saved\\Logs') -Filter '*.log' -File -ErrorAction SilentlyContinue)",
    "[pscustomobject]@{",
    "  project = $uproject.FullName",
    "  engineAssociation = $json.EngineAssociation",
    "  pluginDescriptorCount = $pluginDescriptors.Count",
    "  pluginEntryCount = $pluginEntries.Count",
    "  enabledPluginEntries = @($pluginEntries | Where-Object { $_.Enabled -eq $true }).Name",
    "  configHitCount = $configHits.Count",
    "  logs = $logs.FullName",
    "  boundaries = @(",
    "    'Read-only validation helper.'",
    "    'Does not download Unreal plugins.'",
    "    'Does not copy NVIDIA binaries.'",
    "    'Does not edit .uproject, .uplugin, or Config/*.ini files.'",
    "  )",
    "} | ConvertTo-Json -Depth 12",
    ""
  ];
}

function unrealDlssValidationMarkdown(report, safePatchPlan) {
  const steps = safePatchPlan?.steps || [];
  return [
    "# Unreal DLSS Validation Report",
    "",
    `State: ${report.state}`,
    `Project: ${report.uproject?.relative_path || "unknown"}`,
    `Engine: ${report.engine_compatibility.engine_version || "unknown"}`,
    `Engine compatibility: ${report.engine_compatibility.state}`,
    `Plugin state: ${report.plugin_status.state}`,
    `Config state: ${report.config_status.state}`,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length ? report.blockers.map((item) => `- ${item}`) : ["- None observed by static validation."]),
    "",
    "## Packaging Risks",
    "",
    ...(report.packaging_risks.risks.length ? report.packaging_risks.risks.map((item) => `- ${item}`) : ["- None observed by static validation."]),
    "",
    "## Patch Plan",
    "",
    ...(steps.length ? steps.map((step, index) => `${index + 1}. ${step.step}: ${step.edit_shape}`) : ["1. Patch planning was not requested."]),
    "",
    "## Boundaries",
    "",
    "- Do not download Unreal plugins from this helper.",
    "- Do not copy NVIDIA binaries from this helper.",
    "- Do not edit project files without a separate explicit approval.",
    "- Validate editor and packaged-build logs before claiming readiness.",
    ""
  ];
}

function unityHdrpValidationScript() {
  return [
    "param(",
    "  [string]$ProjectRoot = (Get-Location).Path",
    ")",
    "",
    "$ErrorActionPreference = 'Stop'",
    "$versionFile = Join-Path $ProjectRoot 'ProjectSettings\\ProjectVersion.txt'",
    "$manifestFile = Join-Path $ProjectRoot 'Packages\\manifest.json'",
    "if (!(Test-Path -LiteralPath $versionFile)) { throw \"No Unity ProjectSettings/ProjectVersion.txt found in $ProjectRoot\" }",
    "if (!(Test-Path -LiteralPath $manifestFile)) { throw \"No Unity Packages/manifest.json found in $ProjectRoot\" }",
    "$versionText = Get-Content -LiteralPath $versionFile -Raw",
    "$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json",
    "$unityVersion = if ($versionText -match 'm_EditorVersion:\\s*([^\\r\\n]+)') { $Matches[1].Trim() } else { $null }",
    "$deps = $manifest.dependencies",
    "$hdrp = $deps.'com.unity.render-pipelines.high-definition'",
    "$urp = $deps.'com.unity.render-pipelines.universal'",
    "$settings = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'ProjectSettings') -File -ErrorAction SilentlyContinue)",
    "$assets = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'Assets') -Recurse -File -ErrorAction SilentlyContinue)",
    "$hits = @()",
    "foreach ($file in @($settings + $assets)) {",
    "  if ($file.Extension -notmatch '\\.(asset|unity|cs|json|txt)$') { continue }",
    "  $matches = Select-String -LiteralPath $file.FullName -Pattern 'HDRP|HDRenderPipeline|RenderPipelineAsset|DynamicResolution|DLSS|NVIDIA|Reflex|Camera' -SimpleMatch:$false -ErrorAction SilentlyContinue",
    "  foreach ($match in $matches) { $hits += [pscustomobject]@{ file = $file.FullName; line = $match.LineNumber; text = $match.Line.Trim() } }",
    "}",
    "[pscustomobject]@{",
    "  project = $ProjectRoot",
    "  unityVersion = $unityVersion",
    "  hdrpPackage = $hdrp",
    "  urpPackage = $urp",
    "  evidenceHits = $hits",
    "  noFakeMetricsPolicy = @(",
    "    'This helper reports static readiness only.'",
    "    'It does not fabricate FPS, frame-time, latency, or profiler data.'",
    "    'Runtime success requires a runnable Unity validation path and collected artifacts.'",
    "  )",
    "} | ConvertTo-Json -Depth 12",
    ""
  ];
}

function unityHdrpValidationMarkdown(report, safePatchPlan) {
  const steps = safePatchPlan?.steps || [];
  return [
    "# Unity HDRP DLSS Validation Report",
    "",
    `State: ${report.state}`,
    `Route: ${report.route.recommended_route}`,
    `Unity version: ${report.unity_version.raw || "unknown"}`,
    `HDRP package: ${report.package_status.hdrp.version || "missing"}`,
    `URP package: ${report.package_status.urp.version || "missing"}`,
    `Render pipeline evidence: ${report.render_pipeline_hints.state}`,
    `NVIDIA/DLSS settings: ${report.nvidia_dlss_settings.state}`,
    `Reflex readiness: ${report.reflex_readiness.state}`,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length ? report.blockers.map((item) => `- ${item}`) : ["- None observed by static validation."]),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ["- None observed by static validation."]),
    "",
    "## Patch Plan",
    "",
    ...(steps.length ? steps.map((step, index) => `${index + 1}. ${step.step}: ${step.edit_shape}`) : ["1. Patch planning was not requested."]),
    "",
    "## No Fake Metrics",
    "",
    "- Do not report FPS, frame-time, latency, or profiler data unless Unity actually ran and produced artifacts.",
    "- Static readiness is not runtime success.",
    "- Keep ProjectSettings, Packages, scenes, assets, and scripts unchanged unless a separate implementation approval is supplied.",
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

function loadImplementationContracts() {
  try {
    return JSON.parse(readFileSync(IMPLEMENTATION_CONTRACTS_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load implementation contracts at ${IMPLEMENTATION_CONTRACTS_PATH}: ${errorMessage(error)}`);
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
  if (["nrd", "denoiser", "denoisers", "reblur", "relax", "sigma"].includes(needle)) {
    return registry.technologies.find((tech) => tech.id === "rtx-kit");
  }
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

