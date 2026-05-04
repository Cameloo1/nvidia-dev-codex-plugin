#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "nvidia-rtx-dlss-mcp.mjs");
const child = spawn(process.execPath, [serverPath], {
  cwd: dirname(here),
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

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

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nvidia-rtx-dlss-smoke-test", version: "0.1.0" }
  });
  assertOk(initialized, "initialize");

  const listed = await request("tools/list", {});
  assertOk(listed, "tools/list");
  console.log(`MCP handshake ok. Tools: ${listed.result.tools.map((tool) => tool.name).join(", ")}`);
} finally {
  child.kill();
}

function request(method, params) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function assertOk(message, label) {
  if (message.error) throw new Error(`${label} failed: ${message.error.message}`);
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
