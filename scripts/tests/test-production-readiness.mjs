#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..", "..");
const serverPath = join(pluginRoot, "scripts", "nvidia-rtx-dlss-mcp.mjs");
const child = spawn(process.execPath, [serverPath], {
  cwd: pluginRoot,
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
let stderr = "";

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const message = readMessage();
    if (!message) break;
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nvidia-rtx-dlss-production-readiness-test", version: "1.0.0" }
  });
  assertNoError(initialized, "initialize");

  const listed = await request("tools/list", {});
  assertNoError(listed, "tools/list");
  const tools = listed.result.tools.map((tool) => tool.name);
  for (const tool of [
    "nvidia_header_inspector",
    "nvidia_registry_audit",
    "nvidia_release_readiness",
    "nvidia_submission_packager"
  ]) {
    assert(tools.includes(tool), `Self-test missing ${tool}.`);
  }
  console.log("Release-candidate tool list OK");

  const registry = await callTool("nvidia_registry_audit", { staleness_days: 10000 });
  assert(registry.audit.technology_count >= 8, "Registry audit did not see expected technology entries.");
  assert(registry.audit.source_count >= 8, "Registry audit did not see expected source entries.");
  console.log("Registry audit OK");

  const readiness = await callTool("nvidia_release_readiness", {
    project_path: pluginRoot,
    include_environment_probe: false,
    include_registry_audit: true
  });
  assert(readiness.version === "1.0.0-rc.1", `Release readiness reported wrong version: ${readiness.version}`);
  assert(readiness.readiness.items.length >= 5, "Release readiness checklist too small.");
  console.log(`Release readiness gate: ${readiness.readiness.gate} score=${readiness.readiness.score}`);

  const submission = await callTool("nvidia_submission_packager", {
    project_path: pluginRoot,
    target: "local-review"
  });
  const missing = submission.required_files.filter((file) => !file.exists);
  assert(!missing.length, `Submission packager missing files: ${missing.map((file) => file.path).join(", ")}`);
  console.log("Submission package checklist OK");

  for (const phaseFile of ["docs/phase-2-plan.md", "docs/phase-3-plan.md", "docs/phase-4-plan.md"]) {
    assert(!existsSync(join(pluginRoot, ...phaseFile.split("/"))), `Development phase file still present: ${phaseFile}`);
  }
  console.log("Development phase docs cleaned OK");
} finally {
  child.kill();
}

async function callTool(name, args) {
  const message = await request("tools/call", { name, arguments: args });
  assertNoError(message, name);
  return JSON.parse(message.result.content[0].text);
}

function request(method, params) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out. Server stderr: ${stderr.trim()}`));
    }, 15000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

function assertNoError(message, label) {
  if (message.error) throw new Error(`${label} failed: ${message.error.message}`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function readMessage() {
  const text = buffer.toString("utf8");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const header = text.slice(0, headerEnd);
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error("Bad MCP response: no Content-Length header");
  const length = Number(match[1]);
  const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4), "utf8");
  if (buffer.length < bodyStart + length) return null;
  const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
  buffer = buffer.slice(bodyStart + length);
  return JSON.parse(body);
}
