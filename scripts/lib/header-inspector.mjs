import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const HEADER_PATTERNS = [
  {
    technology_id: "streamline-core",
    label: "Streamline Core",
    files: [/^sl\.h$/i, /^sl_core.*\.h$/i, /streamline/i],
    symbols: [/\bsl[A-Z]\w+/g, /\bSL_[A-Z0-9_]+\b/g, /\bsl::\w+/g]
  },
  {
    technology_id: "dlss-feature-headers",
    label: "DLSS Feature Headers",
    files: [/^sl_dlss.*\.h$/i, /dlss/i],
    symbols: [/\bslDLSS\w+/g, /\bSL_FEATURE_DLSS\w*/g, /\bSL_[A-Z0-9_]*DLSS[A-Z0-9_]*\b/g]
  },
  {
    technology_id: "dlss-streamline",
    label: "Streamline/DLSS",
    files: [/^sl\.h$/i, /^sl_.*\.h$/i, /streamline/i, /dlss/i],
    symbols: [/\bsl[A-Z]\w+/g, /\bSL_[A-Z0-9_]+\b/g, /\bsl::\w+/g]
  },
  {
    technology_id: "video-codec-sdk",
    label: "Video Codec SDK",
    files: [/^nvEncodeAPI\.h$/i, /^nvcuvid\.h$/i, /^cuviddec\.h$/i],
    symbols: [/\bNV_ENC_\w+/g, /\bNV_ENCODE_API_FUNCTION_LIST\b/g, /\bCUVID\w+/g]
  },
  {
    technology_id: "optical-flow-fruc",
    label: "Optical Flow SDK / NvOFFRUC",
    files: [/NvOF/i, /NVOF/i, /NvOFFRUC/i, /OpticalFlow/i],
    symbols: [/\bNV_OF_\w+/g, /\bNvOF\w+/g, /\bNvOFFRUC\w+/g]
  },
  {
    technology_id: "rtx-video-sdk",
    label: "RTX Video SDK",
    files: [/RTXVideo/i, /rtx.*video/i, /rtxvsr/i],
    symbols: [/\bRTX\w*Video\w*/g, /\bVSR\w+/g, /\bArtifactReduction\w*/g, /\bSdrToHdr\w*/g]
  },
  {
    technology_id: "nrd",
    label: "NVIDIA Real-Time Denoisers",
    files: [/^NRD\.h$/i, /^Nrd\.h$/i, /Real.*Time.*Denois/i, /RayTracingDenoiser/i],
    symbols: [/\bnrd::\w+/g, /\bnrd\b/g, /\bNRD_\w+/g, /\bNRD_VERSION_\w+/g, /\bReBLUR\b/g, /\bReLAX\b/g, /\bSIGMA\b/g]
  },
  {
    technology_id: "reflex",
    label: "Reflex",
    files: [/^sl\.h$/i, /^sl_reflex.*\.h$/i, /reflex/i, /low.*latency/i, /nvapi/i],
    symbols: [/\bSL_FEATURE_REFLEX\b/g, /\bslReflex\w+/g, /\bNvLowLatency\w+/g, /\bNV_LATENCY\w+/g, /\bNvAPI\w+/g]
  },
  {
    technology_id: "nsight-aftermath",
    label: "Nsight Aftermath",
    files: [/GFSDK_Aftermath\.h$/i, /Aftermath/i],
    symbols: [/\bGFSDK_Aftermath\w+/g]
  }
];

const GROUNDING_PROFILES = [
  {
    id: "dlss-streamline",
    aliases: ["streamline", "streamline-core", "dlss", "dlss-sr", "dlaa", "custom-cpp-renderer", "streamline-init-scaffold", "d3d12-streamline-dlss-sr-kit"],
    technologies: ["dlss-streamline", "streamline-core", "dlss-feature-headers", "reflex"],
    required_symbols: ["slInit", "slShutdown", "SL_FEATURE_DLSS", "slDLSSGetOptimalSettings"]
  },
  {
    id: "dlss-feature-headers",
    aliases: ["dlss-feature-headers", "dlss-feature", "frame-generation", "mfg", "fg"],
    technologies: ["dlss-streamline", "dlss-feature-headers"],
    required_symbols: ["SL_FEATURE_DLSS"]
  },
  {
    id: "reflex",
    aliases: ["reflex", "latency", "reflex-marker-scaffold"],
    technologies: ["reflex", "dlss-streamline", "streamline-core"],
    required_symbols: ["SL_FEATURE_REFLEX"]
  },
  {
    id: "nrd",
    aliases: ["nrd", "denoiser", "denoisers", "reblur", "relax"],
    technologies: ["nrd"],
    required_symbols: ["NRD_VERSION", "nrd", "ReBLUR"]
  },
  {
    id: "rtx-video-sdk",
    aliases: ["rtx-video", "rtx video", "rtx-video-sdk", "rtx-video-native-pipeline-kit", "rtx-video-pipeline-skeleton"],
    technologies: ["rtx-video-sdk"],
    required_symbols: ["RTXVideo", "VSR", "ArtifactReduction", "SdrToHdr"]
  },
  {
    id: "video-codec-sdk",
    aliases: ["video-codec", "video-codec-sdk", "nvenc", "nvdec", "video-codec-native-pipeline-kit", "video-codec-sample-adaptation", "ffmpeg-gstreamer", "python-video"],
    technologies: ["video-codec-sdk"],
    required_symbols: ["NV_ENCODE_API_FUNCTION_LIST", "NV_ENC_SUCCESS", "CUVID"]
  }
];

export function inspectNvidiaHeaders(options = {}) {
  const roots = normalizeRoots(options.roots);
  const technology = String(options.technology || "").toLowerCase();
  const maxFiles = clamp(Number(options.maxFiles || options.max_files || 12000), 100, 100000);
  const includeSnippets = options.includeSnippets === true || options.include_snippets === true;
  const findings = [];
  const scannedRoots = [];
  let scannedFiles = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    scannedRoots.push(root);
    for (const file of walk(root, maxFiles - scannedFiles)) {
      scannedFiles++;
      const name = file.name;
      const rel = file.relative;
      const patternMatches = HEADER_PATTERNS.filter((pattern) => {
        if (technology && !`${pattern.technology_id} ${pattern.label}`.toLowerCase().includes(technology)) return false;
        return pattern.files.some((regex) => regex.test(name) || regex.test(rel));
      });
      if (!patternMatches.length) continue;
      const text = safeRead(file.full, 250000);
      for (const pattern of patternMatches) {
        findings.push({
          technology_id: pattern.technology_id,
          label: pattern.label,
          path: file.full,
          relative_path: rel,
          symbols: extractSymbols(text, pattern.symbols).slice(0, 80),
          version_clues: extractVersionClues(text).slice(0, 20),
          snippet: includeSnippets ? text.slice(0, 1200) : undefined
        });
      }
      if (scannedFiles >= maxFiles) break;
    }
  }

  const byTechnology = {};
  for (const item of findings) {
    if (!byTechnology[item.technology_id]) {
      byTechnology[item.technology_id] = { headers: 0, symbols: new Set(), versionClues: new Set() };
    }
    byTechnology[item.technology_id].headers++;
    for (const symbol of item.symbols || []) byTechnology[item.technology_id].symbols.add(symbol);
    for (const clue of item.version_clues || []) byTechnology[item.technology_id].versionClues.add(clue);
  }

  return {
    scanned_roots: scannedRoots,
    scanned_files: scannedFiles,
    findings,
    summary: Object.fromEntries(
      Object.entries(byTechnology).map(([id, value]) => [
        id,
        {
          headers: value.headers,
          symbol_count: value.symbols.size,
          sample_symbols: [...value.symbols].slice(0, 30),
          version_clues: [...value.versionClues].slice(0, 10)
        }
      ])
    ),
    warnings: findings.length
      ? []
      : ["No NVIDIA SDK headers were found in the provided roots. Pass explicit SDK roots when SDKs are installed elsewhere."]
  };
}

export function buildHeaderGrounding(options = {}) {
  const roots = normalizeRoots(options.roots);
  const profile = resolveGroundingProfile(options.technology || options.workflow || "");
  const explicitRequired = normalizeStringList(options.required_symbols);
  const requiredSymbols = explicitRequired.length ? explicitRequired : profile.required_symbols;
  const report = inspectNvidiaHeaders({
    roots,
    technology: "",
    max_files: options.max_files || options.maxFiles,
    include_snippets: options.include_snippets === true || options.includeSnippets === true
  });
  const relevantFindings = report.findings.filter((finding) =>
    !profile.technologies.length || profile.technologies.includes(finding.technology_id)
  );
  const relevantSymbols = [...new Set(relevantFindings.flatMap((finding) => finding.symbols || []))].sort();
  const versionClues = [...new Set(relevantFindings.flatMap((finding) => finding.version_clues || []))].sort();
  const missingRequired = requiredSymbols.filter((symbol) => !symbolObserved(symbol, relevantSymbols));
  const detectedRoot = detectedRootForFindings(roots, relevantFindings);
  const confidence = groundingConfidence({
    relevantHeaders: relevantFindings.length,
    relevantSymbols: relevantSymbols.length,
    missingRequired,
    versionClues
  });

  return {
    detected_sdk_root: detectedRoot,
    detected_version: versionClues[0] || null,
    technology: profile.id,
    profile_aliases: profile.aliases,
    required_symbols: requiredSymbols,
    relevant_headers: relevantFindings.map((finding) => ({
      path: finding.path,
      relative_path: finding.relative_path,
      technology_id: finding.technology_id,
      label: finding.label,
      symbols: finding.symbols || [],
      version_clues: finding.version_clues || []
    })),
    relevant_symbols: relevantSymbols,
    missing_required_symbols: missingRequired,
    confidence_level: confidence,
    can_generate_real_api_guidance: relevantFindings.length > 0 && missingRequired.length === 0,
    warnings: groundingWarnings(report, relevantFindings, missingRequired)
  };
}

export function requiredHeaderSymbolsFor(technology) {
  return resolveGroundingProfile(technology).required_symbols;
}

function normalizeRoots(input) {
  const values = Array.isArray(input) ? input : String(input || process.cwd()).split(/[;,]/);
  return values.map((value) => resolve(String(value).trim())).filter(Boolean);
}

function walk(root, maxFiles) {
  const output = [];
  const ignored = new Set([".git", "node_modules", "dist", "build", "out", "bin", "obj", "Library", "Temp", "Saved", "Intermediate"]);
  function visit(dir) {
    if (output.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (output.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) visit(full);
      } else if (entry.isFile() && /\.(h|hpp|hxx|inl)$/i.test(extname(entry.name))) {
        output.push({ full, name: entry.name, relative: full.slice(root.length).replace(/^[/\\]/, "") });
      }
    }
  }
  visit(root);
  return output;
}

function safeRead(path, maxBytes) {
  try {
    const stat = statSync(path);
    const text = readFileSync(path, "utf8");
    return stat.size > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return "";
  }
}

function extractSymbols(text, regexes) {
  const symbols = new Set();
  for (const regex of regexes) {
    for (const match of text.matchAll(regex)) symbols.add(match[0]);
  }
  return [...symbols].sort();
}

function extractVersionClues(text) {
  const clues = new Set();
  const patterns = [
    /#\s*define\s+([A-Z0-9_]*VERSION[A-Z0-9_]*)\s+([0-9][A-Za-z0-9_.-]*)/g,
    /\b(static\s+const\s+int|constexpr\s+int|const\s+int)\s+([A-Za-z0-9_]*Version[A-Za-z0-9_]*)\s*=\s*([0-9]+)/g
  ];
  for (const regex of patterns) {
    for (const match of text.matchAll(regex)) {
      if (match.length >= 4) {
        clues.add(`${match[2]}=${match[3]}`);
      } else {
        clues.add(`${match[1]}=${match[2]}`);
      }
    }
  }
  return [...clues].sort();
}

function resolveGroundingProfile(value) {
  const needle = String(value || "").toLowerCase();
  return (
    GROUNDING_PROFILES.find((profile) => profile.id === needle || profile.aliases.some((alias) => needle.includes(alias))) ||
    GROUNDING_PROFILES[0]
  );
}

function symbolObserved(required, symbols) {
  const needle = String(required || "").toLowerCase();
  return symbols.some((symbol) => String(symbol || "").toLowerCase().includes(needle));
}

function detectedRootForFindings(roots, findings) {
  const counts = new Map();
  for (const finding of findings) {
    const root = roots.find((candidate) => finding.path.toLowerCase().startsWith(candidate.toLowerCase()));
    if (!root) continue;
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function groundingConfidence({ relevantHeaders, relevantSymbols, missingRequired, versionClues }) {
  if (!relevantHeaders) return "none";
  if (missingRequired.length) return "blocked_missing_symbols";
  if (versionClues.length && relevantSymbols >= 3) return "high";
  if (relevantSymbols >= 3) return "medium";
  return "low";
}

function groundingWarnings(report, relevantFindings, missingRequired) {
  const warnings = [...(report.warnings || [])];
  if (!relevantFindings.length) warnings.push("No relevant SDK headers were detected for the selected technology.");
  if (missingRequired.length) warnings.push(`Required symbols missing: ${missingRequired.join(", ")}`);
  return [...new Set(warnings)];
}

function normalizeStringList(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : String(input).split(/[;,]/);
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.trunc(value), max));
}
