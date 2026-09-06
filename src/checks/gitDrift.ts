import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { N8nWorkflow } from "../n8n/api.js";

export interface ExportedWorkflow {
  id: string | null;
  name: string;
  nodes?: unknown[];
  connections?: Record<string, unknown>;
  /** Repo-relative path of the file this was read from. */
  file: string;
}

export type DriftKind = "missing_in_git" | "missing_in_instance" | "content_drift" | "duplicate_export";

export interface DriftEntry {
  kind: DriftKind;
  workflowId: string | null;
  name: string;
  file: string | null;
  active: boolean | null;
  detail: string;
}

export interface GitDriftReport {
  liveCount: number;
  exportedCount: number;
  inSync: number;
  drift: DriftEntry[];
  findings: string[];
}

/**
 * Fingerprint of what a workflow *does*: node types, their parameters and the
 * wiring. Canvas positions, timestamps and per-instance ids are excluded, so a
 * dragged node is not reported as drift.
 */
export function fingerprintWorkflow(workflow: { nodes?: unknown[]; connections?: unknown }): string {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const normalizedNodes = nodes
    .map((raw) => {
      const node = (raw ?? {}) as Record<string, unknown>;
      return {
        name: node.name ?? null,
        type: node.type ?? null,
        typeVersion: node.typeVersion ?? null,
        disabled: node.disabled ?? false,
        parameters: node.parameters ?? {},
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return createHash("sha256")
    .update(stableStringify({ nodes: normalizedNodes, connections: workflow.connections ?? {} }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The diff every existing n8n MCP server is missing: it compares two API
 * objects, not the running instance against what is versioned in git.
 */
export function diffWorkflows(live: N8nWorkflow[], exported: ExportedWorkflow[]): GitDriftReport {
  const available = new Set(exported);
  const claimed = new Map<ExportedWorkflow, N8nWorkflow>();

  const pick = (predicate: (item: ExportedWorkflow) => boolean): ExportedWorkflow | undefined => {
    for (const item of available) if (predicate(item)) return item;
    return undefined;
  };

  // Two passes, because an export may only be claimed once. Duplicating a
  // workflow in n8n keeps the name, so same-name pairs are the normal case:
  // matching by name first would let one of them consume the export another
  // workflow owns by id, and the unexported twin would silently look in sync.
  const assignment = new Map<N8nWorkflow, ExportedWorkflow>();
  for (const workflow of live) {
    const match = pick((item) => item.id !== null && item.id === String(workflow.id));
    if (match) {
      available.delete(match);
      claimed.set(match, workflow);
      assignment.set(workflow, match);
    }
  }
  for (const workflow of live) {
    if (assignment.has(workflow)) continue;
    const match = pick((item) => item.name === workflow.name);
    if (match) {
      available.delete(match);
      claimed.set(match, workflow);
      assignment.set(workflow, match);
    }
  }

  const drift: DriftEntry[] = [];
  let inSync = 0;

  for (const workflow of live) {
    const match = assignment.get(workflow);
    if (!match) {
      drift.push({
        kind: "missing_in_git",
        workflowId: String(workflow.id),
        name: workflow.name,
        file: null,
        active: workflow.active,
        detail: workflow.active
          ? "active in the instance but not exported to the repository"
          : "present in the instance but not exported to the repository",
      });
      continue;
    }

    if (fingerprintWorkflow(workflow) === fingerprintWorkflow(match)) {
      inSync += 1;
    } else {
      drift.push({
        kind: "content_drift",
        workflowId: String(workflow.id),
        name: workflow.name,
        file: match.file,
        active: workflow.active,
        detail: `nodes or connections differ between the instance and ${match.file}`,
      });
    }
  }

  // Whatever is left over was claimed by nobody. If a live workflow already
  // took an export with the same identity, the leftovers are redundant copies
  // of it; otherwise the workflow they describe is gone from the instance.
  const identities = new Map<string, N8nWorkflow>();
  for (const [item, workflow] of claimed) {
    if (item.id) identities.set(`id:${item.id}`, workflow);
    identities.set(`name:${item.name}`, workflow);
  }
  for (const item of available) {
    const owner = (item.id ? identities.get(`id:${item.id}`) : undefined) ?? identities.get(`name:${item.name}`);
    if (owner) {
      drift.push({
        kind: "duplicate_export",
        workflowId: String(owner.id),
        name: owner.name,
        file: item.file,
        active: owner.active,
        detail: `a second export file claims this workflow, alongside ${assignment.get(owner)!.file}`,
      });
      continue;
    }
    drift.push({
      kind: "missing_in_instance",
      workflowId: item.id,
      name: item.name,
      file: item.file,
      active: null,
      detail: "exported in the repository but not present in the instance (deleted or never imported)",
    });
  }

  const counts = drift.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
    return acc;
  }, {});

  const findings =
    drift.length === 0
      ? [`all ${live.length} workflows match their exports`]
      : [
          `${drift.length} differences across ${live.length} live and ${exported.length} exported workflows`,
          ...Object.entries(counts).map(([kind, n]) => `${kind}: ${n}`),
        ];

  return { liveCount: live.length, exportedCount: exported.length, inSync, drift, findings };
}

const SKIP_DIRS = new Set([".git", "node_modules", ".github", "dist", "build"]);

/** Reads every workflow-shaped JSON file under `repoPath`, recursively. */
export async function loadExportedWorkflows(repoPath: string): Promise<ExportedWorkflow[]> {
  const root = path.resolve(repoPath);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`N8N_GIT_REPO_PATH is not a readable directory: ${repoPath}`);
  }

  const found: ExportedWorkflow[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const parsed = await readFile(full, "utf8").then((text) => JSON.parse(text) as unknown).catch(() => null);
      for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
        const workflow = toExported(candidate, path.relative(root, full));
        if (workflow) found.push(workflow);
      }
    }
  };
  await walk(root);
  return found;
}

function toExported(value: unknown, file: string): ExportedWorkflow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // A workflow export always carries nodes; package.json and friends do not.
  if (!Array.isArray(record.nodes)) return null;
  return {
    id: record.id === undefined || record.id === null ? null : String(record.id),
    name: typeof record.name === "string" ? record.name : path.basename(file, ".json"),
    nodes: record.nodes,
    connections: (record.connections ?? {}) as Record<string, unknown>,
    file,
  };
}
