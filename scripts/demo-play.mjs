#!/usr/bin/env node
/**
 * The part of the demo that is on camera: talks to the n8n-guard MCP server
 * over stdio and prints the answers at reading speed.
 *
 * Not meant to be started by hand - scripts/record-demo.sh prepares the
 * instance, writes .n8n-demo-env and runs this in the window it records.
 *
 * The API key is read from .n8n-demo-env inside this process. It is never an
 * argument and never printed, so it cannot end up in the recording.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Every pause is multiplied by this. The default is tuned so the whole run
// lands around 90 seconds, well inside the 2:00 the submission allows.
const speed = Number(process.env.DEMO_SPEED ?? 1.8);
const marker = process.env.DEMO_DONE_MARKER;

const C = {
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  bold: "\u001b[1m",
  off: "\u001b[0m",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));

function env() {
  const out = { ...process.env };
  for (const line of readFileSync(resolve(root, ".n8n-demo-env"), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function type(text, ms = 26) {
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(ms);
  }
  process.stdout.write("\n");
}

/** Answers are long; the recording shows the header and the findings, not the JSON. */
function condense(result, maxLines) {
  const text = result.content.map((c) => c.text ?? "").join("\n");
  const lines = [];
  for (const raw of text.split("\n")) {
    if (raw.startsWith("```")) break;
    const line = raw.trimEnd();
    if (!line) continue;
    lines.push(line.length > 92 ? `${line.slice(0, 89)}...` : line);
  }
  const shown = lines.slice(0, maxLines);
  if (lines.length > shown.length) {
    shown.push(`${C.dim}... ${lines.length - shown.length} more finding(s)${C.off}`);
  }
  return shown;
}

/** The per-step array is the evidence for "a failing step does not end the run". */
function steps(result) {
  const list = result.structuredContent?.steps;
  if (!Array.isArray(list)) return [];
  const color = { ok: C.green, failed: C.yellow, skipped: C.dim };
  return list.map((s) => {
    const status = `${color[s.status] ?? ""}${String(s.status).padEnd(7)}${C.off}`;
    return `  ${status} ${String(s.name).padEnd(18)} ${String(s.attempts)} attempt(s)  ${s.durationMs} ms`;
  });
}

async function call(client, tool, args, { label, maxLines = 8, hold = 2.4, withSteps = false }) {
  await type(`${C.green}n8n-guard >${C.off} ${label ?? tool}`);
  const result = await client.callTool({ name: tool, arguments: args });
  const lines = condense(result, maxLines);
  if (withSteps) lines.push("", ...steps(result));
  for (const line of lines) {
    console.log(line.startsWith("## ") ? `${C.bold}${C.cyan}${line}${C.off}` : line);
    await sleep(110);
  }
  console.log("");
  await sleep(hold * 1000);
}

async function main() {
  const environment = env();
  console.log(`${C.bold}n8n-guard${C.off} ${C.dim}- MCP server for the layer under the n8n Public API${C.off}`);
  console.log(`${C.dim}six read-only checks, one sweep, over stdio${C.off}\n`);
  await sleep(2200);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/index.js")],
    env: environment,
  });
  const client = new Client({ name: "n8n-guard-demo", version: "1.0.0" });
  await client.connect(transport);

  await call(client, "guard_run", {}, { label: "guard_run", maxLines: 4, hold: 4, withSteps: true });
  await call(client, "stuck_executions", { threshold_minutes: 1 }, {
    label: "stuck_executions { threshold_minutes: 1 }",
    maxLines: 5,
    hold: 4.5,
  });
  await call(client, "git_drift", {}, { label: "git_drift", maxLines: 7, hold: 4.5 });

  await type(`${C.yellow}$${C.off} docker compose stop n8n`);
  spawnSync("docker", ["compose", "stop", "n8n"], { cwd: root, stdio: "ignore" });
  console.log(`${C.dim}the instance is gone. the sweep is not.${C.off}\n`);
  await sleep(2600);

  await call(client, "guard_run", {}, { label: "guard_run", maxLines: 5, hold: 5, withSteps: true });

  console.log(`${C.bold}github.com/flow-84/n8n-guard${C.off} ${C.dim}- read-only, six checks, MIT${C.off}`);
  await sleep(4000);
  await client.close();
}

main()
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (marker) writeFileSync(marker, String(process.exitCode ?? 0));
  });
