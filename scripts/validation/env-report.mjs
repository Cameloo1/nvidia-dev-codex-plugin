#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";

const args = parseArgs(process.argv.slice(2));
const report = {
  generated_at: new Date().toISOString(),
  local_only: true,
  project_path: args["project-path"] || null,
  project_path_exists: args["project-path"] ? existsSync(args["project-path"]) : null,
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
  nvidia: nvidiaSmiSummary(),
  cuda_env: {
    CUDA_PATH: process.env.CUDA_PATH || null,
    CUDA_HOME: process.env.CUDA_HOME || null,
    NVIDIA_SDK_ROOT: process.env.NVIDIA_SDK_ROOT || null,
    STREAMLINE_SDK: process.env.STREAMLINE_SDK || null,
    RTX_VIDEO_SDK: process.env.RTX_VIDEO_SDK || null,
    VIDEO_CODEC_SDK: process.env.VIDEO_CODEC_SDK || null
  },
  tools: {
    ffmpeg: toolSummary("ffmpeg", ["-version"]),
    "gst-launch-1.0": toolSummary("gst-launch-1.0", ["--version"]),
    "gst-inspect-1.0": toolSummary("gst-inspect-1.0", ["--version"]),
    "nvidia-smi": toolSummary("nvidia-smi", ["--version"])
  },
  notes: [
    "Missing tools are reported as environment state, not failure.",
    "This script does not download SDKs, install tools, upload files, or package NVIDIA binaries."
  ]
};

console.log(JSON.stringify(report, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index++;
    }
  }
  return parsed;
}

function toolSummary(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    available: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
    summary: output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
  };
}

function nvidiaSmiSummary() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return {
      gpu: null,
      error: result.error ? result.error.message : `${result.stderr || result.stdout}`.trim()
    };
  }
  const first = String(result.stdout || "").trim().split(/\r?\n/)[0] || "";
  const [name, driver] = first.split(",").map((part) => part.trim());
  return {
    gpu: name ? { name, driver_version: driver || null } : null,
    error: null
  };
}
