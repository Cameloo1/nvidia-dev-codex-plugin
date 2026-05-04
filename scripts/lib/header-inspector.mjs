import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const HEADER_PATTERNS = [
  {
    technology_id: "dlss-streamline",
    label: "Streamline/DLSS",
    files: [/^sl\.h$/i, /^sl_.*\.h$/i, /streamline/i, /dlss/i],
    symbols: [/\bsl[A-Z]\w+/g, /\bSL_\w+/g, /\bsl::\w+/g]
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
    symbols: [/\bRTX\w*Video\w*/g, /\bVSR\w+/g]
  },
  {
    technology_id: "reflex",
    label: "Reflex",
    files: [/reflex/i, /low.*latency/i, /nvapi/i],
    symbols: [/\bNvLowLatency\w+/g, /\bNV_LATENCY\w+/g, /\bNvAPI\w+/g]
  },
  {
    technology_id: "nsight-aftermath",
    label: "Nsight Aftermath",
    files: [/GFSDK_Aftermath\.h$/i, /Aftermath/i],
    symbols: [/\bGFSDK_Aftermath\w+/g]
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
          snippet: includeSnippets ? text.slice(0, 1200) : undefined
        });
      }
      if (scannedFiles >= maxFiles) break;
    }
  }

  const byTechnology = {};
  for (const item of findings) {
    if (!byTechnology[item.technology_id]) {
      byTechnology[item.technology_id] = { headers: 0, symbols: new Set() };
    }
    byTechnology[item.technology_id].headers++;
    for (const symbol of item.symbols || []) byTechnology[item.technology_id].symbols.add(symbol);
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
          sample_symbols: [...value.symbols].slice(0, 30)
        }
      ])
    ),
    warnings: findings.length
      ? []
      : ["No NVIDIA SDK headers were found in the provided roots. Pass explicit SDK roots when SDKs are installed elsewhere."]
  };
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

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.trunc(value), max));
}
