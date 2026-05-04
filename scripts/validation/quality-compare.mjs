#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const reference = args.reference;
const candidate = args.candidate;
const metric = args.metric || "video-basic";

if (!reference || !candidate) {
  console.error("Usage: node quality-compare.mjs --reference <path> --candidate <path> [--metric video-basic|image-basic|ffmpeg-psnr-ssim|ffmpeg-vmaf]");
  process.exit(2);
}

const result = compare(reference, candidate, metric);
console.log(JSON.stringify(result, null, 2));
process.exit(result.execution_state === "blocked_missing_requirements" ? 1 : 0);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    parsed[key] = !next || next.startsWith("--") ? true : next;
    if (next && !next.startsWith("--")) index++;
  }
  return parsed;
}

function compare(referencePath, candidatePath, metricSet) {
  const missing = [];
  if (!existsSync(referencePath)) missing.push(`reference does not exist: ${referencePath}`);
  if (!existsSync(candidatePath)) missing.push(`candidate does not exist: ${candidatePath}`);
  const ffmpeg = probe("ffmpeg", ["-version"], 5000);
  if (["video-basic", "ffmpeg-psnr-ssim", "ffmpeg-vmaf"].includes(metricSet) && !ffmpeg.ok) missing.push("FFmpeg was not found on PATH.");
  if (metricSet === "ffmpeg-vmaf") {
    const filters = probe("ffmpeg", ["-hide_banner", "-filters"], 7000);
    if (!filters.ok || !/libvmaf/i.test(filters.output)) missing.push("FFmpeg does not advertise the libvmaf filter.");
  }
  if (missing.length) {
    return {
      execution_state: "blocked_missing_requirements",
      missing_requirements: missing,
      parsed_metrics: {}
    };
  }
  if (metricSet === "image-basic") {
    return { execution_state: "completed_or_ready", parsed_metrics: { reference: summary(referencePath), candidate: summary(candidatePath) } };
  }
  if (metricSet === "video-basic") {
    return {
      execution_state: "completed_or_ready",
      parsed_metrics: {
        reference: summary(referencePath),
        candidate: summary(candidatePath),
        ffmpeg_reference: firstLine(probe("ffmpeg", ["-hide_banner", "-i", referencePath], 8000).output),
        ffmpeg_candidate: firstLine(probe("ffmpeg", ["-hide_banner", "-i", candidatePath], 8000).output)
      }
    };
  }
  if (metricSet === "ffmpeg-psnr-ssim") {
    const psnr = probe("ffmpeg", ["-hide_banner", "-i", referencePath, "-i", candidatePath, "-lavfi", "psnr", "-f", "null", "-"], 20000);
    const ssim = probe("ffmpeg", ["-hide_banner", "-i", referencePath, "-i", candidatePath, "-lavfi", "ssim", "-f", "null", "-"], 20000);
    return {
      execution_state: "completed_or_ready",
      parsed_metrics: {
        psnr_average: numberMatch(psnr.output, /average:([0-9.]+)/i),
        ssim_all: numberMatch(ssim.output, /All:([0-9.]+)/i),
        psnr_status: psnr.status,
        ssim_status: ssim.status
      }
    };
  }
  const vmaf = probe("ffmpeg", ["-hide_banner", "-i", referencePath, "-i", candidatePath, "-lavfi", "libvmaf", "-f", "null", "-"], 30000);
  return {
    execution_state: "completed_or_ready",
    parsed_metrics: {
      vmaf_score: numberMatch(vmaf.output, /VMAF score:\s*([0-9.]+)/i),
      vmaf_status: vmaf.status
    }
  };
}

function probe(command, commandArgs, timeout) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout, windowsHide: true });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
    output: `${result.stdout || ""}${result.stderr || ""}`
  };
}

function summary(path) {
  const stat = statSync(path);
  return { path, bytes: stat.size, modified_at: stat.mtime.toISOString() };
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function numberMatch(value, regex) {
  const match = String(value || "").match(regex);
  return match ? Number.parseFloat(match[1]) : null;
}
