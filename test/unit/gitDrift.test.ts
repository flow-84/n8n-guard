import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffWorkflows, fingerprintWorkflow, loadExportedWorkflows, type ExportedWorkflow } from "../../src/checks/gitDrift.js";
import type { N8nWorkflow } from "../../src/n8n/api.js";

const nodes = (parameter: string) => [
  { name: "Start", type: "n8n-nodes-base.start", typeVersion: 1, position: [0, 0], parameters: {} },
  { name: "HTTP", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [200, 0], parameters: { url: parameter } },
];

const live = (over: Partial<N8nWorkflow> = {}): N8nWorkflow => ({
  id: "wf1",
  name: "Sync CRM",
  active: true,
  nodes: nodes("https://api.example.com"),
  connections: { Start: { main: [[{ node: "HTTP", type: "main", index: 0 }]] } },
  ...over,
});

const exported = (over: Partial<ExportedWorkflow> = {}): ExportedWorkflow => ({
  id: "wf1",
  name: "Sync CRM",
  nodes: nodes("https://api.example.com"),
  connections: { Start: { main: [[{ node: "HTTP", type: "main", index: 0 }]] } },
  file: "workflows/sync-crm.json",
  ...over,
});

describe("fingerprintWorkflow", () => {
  it("ignores canvas position and node order", () => {
    const a = { nodes: nodes("https://api.example.com"), connections: {} };
    const b = { nodes: [...nodes("https://api.example.com")].reverse().map((n) => ({ ...n, position: [99, 99] })), connections: {} };
    expect(fingerprintWorkflow(a)).toBe(fingerprintWorkflow(b));
  });

  it("changes when a parameter changes", () => {
    expect(fingerprintWorkflow({ nodes: nodes("https://a"), connections: {} })).not.toBe(
      fingerprintWorkflow({ nodes: nodes("https://b"), connections: {} }),
    );
  });

  it("changes when the wiring changes", () => {
    const a = { nodes: nodes("x"), connections: { Start: { main: [[{ node: "HTTP" }]] } } };
    const b = { nodes: nodes("x"), connections: {} };
    expect(fingerprintWorkflow(a)).not.toBe(fingerprintWorkflow(b));
  });
});

describe("diffWorkflows", () => {
  it("reports nothing when instance and repository agree", () => {
    const report = diffWorkflows([live()], [exported()]);
    expect(report.drift).toHaveLength(0);
    expect(report.inSync).toBe(1);
  });

  it("reports a live workflow that was never exported", () => {
    const report = diffWorkflows([live(), live({ id: "wf2", name: "Nightly" })], [exported()]);
    expect(report.drift).toEqual([
      expect.objectContaining({ kind: "missing_in_git", workflowId: "wf2", active: true }),
    ]);
  });

  it("reports an export whose workflow is gone from the instance", () => {
    const report = diffWorkflows([], [exported()]);
    expect(report.drift[0]).toMatchObject({ kind: "missing_in_instance", file: "workflows/sync-crm.json" });
  });

  it("reports content that drifted apart", () => {
    const report = diffWorkflows([live()], [exported({ nodes: nodes("https://changed.example.com") })]);
    expect(report.drift[0]).toMatchObject({ kind: "content_drift", workflowId: "wf1" });
  });

  it("matches by name when the export carries no id", () => {
    const report = diffWorkflows([live()], [exported({ id: null })]);
    expect(report.drift).toHaveLength(0);
  });

  it("gives each export to only one live workflow when names collide", () => {
    // Duplicating a workflow in n8n keeps the name, so same-name pairs are normal.
    const report = diffWorkflows([live({ id: "wf1" }), live({ id: "wf2" })], [exported({ id: null })]);

    expect(report.inSync).toBe(1);
    expect(report.drift).toEqual([
      expect.objectContaining({ kind: "missing_in_git", workflowId: "wf2" }),
    ]);
  });

  it("prefers an id match over a name match when both compete for one export", () => {
    const byName = exported({ id: null, file: "by-name.json" });
    const byId = exported({ id: "wf2", name: "Sync CRM", file: "by-id.json" });
    const report = diffWorkflows([live({ id: "wf2" }), live({ id: "wf3" })], [byName, byId]);

    // wf2 must take by-id.json, leaving by-name.json for wf3 rather than the reverse.
    expect(report.drift).toHaveLength(0);
    expect(report.inSync).toBe(2);
  });

  it("flags two export files claiming the same workflow", () => {
    const report = diffWorkflows([live()], [exported(), exported({ file: "backup/sync-crm.json" })]);
    expect(report.drift.some((d) => d.kind === "duplicate_export")).toBe(true);
    expect(report.drift.some((d) => d.kind === "missing_in_instance")).toBe(false);
  });
});

describe("loadExportedWorkflows", () => {
  it("reads workflow JSON recursively and ignores everything else", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "n8n-guard-"));
    await mkdir(path.join(dir, "flows", "nested"), { recursive: true });
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "flows", "one.json"), JSON.stringify({ id: "a", name: "One", nodes: [], connections: {} }));
    await writeFile(path.join(dir, "flows", "nested", "two.json"), JSON.stringify({ name: "Two", nodes: [] }));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "not-a-workflow" }));
    await writeFile(path.join(dir, "flows", "broken.json"), "{ not json");
    await writeFile(path.join(dir, "node_modules", "hidden.json"), JSON.stringify({ name: "Hidden", nodes: [] }));

    const found = await loadExportedWorkflows(dir);

    expect(found.map((w) => w.name).sort()).toEqual(["One", "Two"]);
    expect(found.find((w) => w.name === "Two")?.id).toBeNull();
  });

  it("accepts a file holding an array of workflows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "n8n-guard-"));
    await writeFile(path.join(dir, "all.json"), JSON.stringify([{ name: "A", nodes: [] }, { name: "B", nodes: [] }]));
    expect((await loadExportedWorkflows(dir)).map((w) => w.name)).toEqual(["A", "B"]);
  });

  it("fails loudly when the path is not a directory", async () => {
    await expect(loadExportedWorkflows("/nonexistent/path/for/n8n-guard")).rejects.toThrow(/not a readable directory/);
  });
});
