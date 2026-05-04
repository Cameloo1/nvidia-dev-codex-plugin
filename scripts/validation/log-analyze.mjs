#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const paths = collectValues(args, "log").concat(collectValues(args, "logs"));
const limit = Math.max(1, Math.min(Number(args.limit || 200), 2000));

if (!paths.length) {
  console.error("Usage: node log-analyze.mjs --log <path> [--log <path>] [--technology <id>] [--limit 200]");
  process.exit(2);
}

const result = analyze(paths, args.technology || "", limit);
console.log(JSON.stringify(result, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!parsed[key]) parsed[key] = [];
    if (!next || next.startsWith("--")) {
      parsed[key].push(true);
    } else {
      parsed[key].push(next);
      index++;
    }
  }
  return parsed;
}

function collectValues(args, key) {
  const value = args[key];
  if (!value) return [];
  return Array.isArray(value) ? value.filter((item) => item !== true) : [value];
}

function analyze(paths, technology, limit) {
  const findings = [];
  const unreadable_paths = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      unreadable_paths.push({ path, error: "Path does not exist" });
      continue;
    }
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const files = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(log|txt|out|err)$/i.test(entry.name))
        .map((entry) => join(path, entry.name));
      const nested = analyze(files, technology, Math.max(1, limit - findings.length));
      findings.push(...nested.findings);
      unreadable_paths.push(...nested.unreadable_paths);
      continue;
    }
    const lines = readFileSync(path, "utf8").slice(0, 2_000_000).split(/\r?\n/);
    for (let index = 0; index < lines.length && findings.length < limit; index++) {
      for (const match of matchLine(lines[index], technology)) {
        findings.push({ ...match, path, line: index + 1, text: lines[index].trim() });
        if (findings.length >= limit) break;
      }
    }
  }
  return {
    findings,
    findings_by_severity: {
      error: findings.filter((item) => item.severity === "error"),
      warning: findings.filter((item) => item.severity === "warning"),
      info: findings.filter((item) => item.severity === "info")
    },
    unreadable_paths
  };
}

function matchLine(line, technology) {
  const haystack = `${technology} ${line}`;
  const patterns = [
    ["error", /(failed|error|exception|fatal).*(streamline|dlss|sl\.|nvngx|nvidia)/i, "streamline_dlss_load", "Check SDK version, binary placement, signatures, feature support query, and runtime logs."],
    ["warning", /((unsupported|not supported|feature.*disabled|requirements.*failed).*(dlss|frame generation|streamline|reflex))|((dlss|frame generation|streamline|reflex).*(unsupported|not supported|disabled|requirements.*failed))/i, "feature_unsupported", "Hide/disable UI for the feature and collect GPU, driver, OS, API, SDK, and settings."],
    ["error", /(uproject|uplugin|plugin).*(missing|failed|incompatible|not found).*(dlss|streamline|nvidia|reflex)/i, "unreal_plugin", "Validate UE version/plugin package match and packaged-build logs."],
    ["warning", /(h264_nvenc|hevc_nvenc|av1_nvenc|nvdec|cuvid|cuda).*(not found|unavailable|failed|fallback|software)/i, "video_codec_acceleration", "Check GPU codec support, FFmpeg/GStreamer build options, driver, and selected codec/profile."],
    ["warning", /(ffmpeg|gstreamer|gst).*(hwaccel|nvenc|nvdec|cuda).*(failed|unavailable|fallback|not negotiated)/i, "framework_hwaccel", "Inspect pipeline caps, hwframes context, codec support, and verbose framework logs."],
    ["error", /(gpu crash|tdr|device removed|device lost|aftermath|crash dump|nv-gpudmp)/i, "nsight_aftermath", "Collect Nsight/Aftermath artifacts with repro metadata."],
    ["info", /(streamline|dlss|reflex|nvenc|nvdec|nvidia|nsight).*(loaded|enabled|initialized|available|created)/i, "nvidia_feature_state", "Correlate with capability checks and validation metrics."]
  ];
  return patterns
    .filter(([, regex]) => regex.test(line) || regex.test(haystack))
    .map(([severity, , category, next]) => ({
      severity,
      category,
      recommended_next_validation_step: next
    }));
}
