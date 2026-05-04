#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const sample = args.sample || args["sample-path"];
const framework = args.framework || "ffmpeg";
const operation = args.operation || "decode";
const run = args.run === true || args.run === "true";

if (!sample) {
  console.error("Usage: node codec-throughput.mjs --sample <path> [--framework ffmpeg|gstreamer] [--operation decode|encode] [--run]");
  process.exit(2);
}

const plan = buildPlan(sample, framework, operation);
if (!run) {
  console.log(JSON.stringify({ execution_state: "plan_only", ...plan }, null, 2));
  process.exit(0);
}

if (!existsSync(sample)) {
  console.log(JSON.stringify({ execution_state: "blocked_missing_requirements", missing_requirements: [`sample does not exist: ${sample}`], ...plan }, null, 2));
  process.exit(1);
}

const command = plan.command[0];
const result = spawnSync(command.executable, command.args, {
  encoding: "utf8",
  timeout: 120000,
  windowsHide: true
});
console.log(
  JSON.stringify(
    {
      execution_state: result.error ? "failed_to_run" : "completed",
      ...plan,
      run_result: {
        status: result.status,
        error: result.error ? result.error.message : null,
        output_tail: `${result.stdout || ""}${result.stderr || ""}`.slice(-4000)
      }
    },
    null,
    2
  )
);
process.exit(result.error || result.status ? 1 : 0);

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

function buildPlan(samplePath, frameworkName, op) {
  if (frameworkName === "gstreamer") {
    return {
      required_tools: ["gst-launch-1.0", "gst-inspect-1.0"],
      command: [
        {
          executable: "gst-launch-1.0",
          args: ["filesrc", `location=${samplePath}`, "!", "decodebin", "!", "fakesink", "sync=false"]
        }
      ],
      pass_fail_criteria: [
        "Pipeline negotiates without software fallback surprises.",
        "Throughput meets target for the selected sample and codec.",
        "Logs identify whether NVIDIA elements are actually in use."
      ]
    };
  }
  if (op === "encode") {
    return {
      required_tools: ["ffmpeg", "nvidia-smi"],
      command: [
        {
          executable: "ffmpeg",
          args: ["-hide_banner", "-benchmark", "-i", samplePath, "-c:v", "h264_nvenc", "-f", "null", "-"]
        }
      ],
      pass_fail_criteria: [
        "FFmpeg selects h264_nvenc without fallback.",
        "Encode throughput and latency meet target.",
        "A/V sync remains acceptable for representative samples."
      ]
    };
  }
  return {
    required_tools: ["ffmpeg", "nvidia-smi"],
    command: [
      {
        executable: "ffmpeg",
        args: ["-hide_banner", "-benchmark", "-hwaccel", "cuda", "-i", samplePath, "-f", "null", "-"]
      }
    ],
    pass_fail_criteria: [
      "FFmpeg logs confirm the intended hardware acceleration path.",
      "Decode throughput meets target.",
      "No unexpected CPU-only fallback is claimed as NVIDIA acceleration."
    ]
  };
}
