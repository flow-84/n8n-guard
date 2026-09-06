import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../../src/n8n/sqlite.js";
import { loadConfig } from "../../src/config.js";
import { GuardService } from "../../src/guard/service.js";

/**
 * The `render` track asks for a background job that recovers from a failing
 * step. This is that proof, end to end: a real (tiny) n8n-shaped SQLite file is
 * readable while the API is pointed at a dead port and no git repo is set.
 */
let sqlitePath: string;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "n8n-guard-db-"));
  sqlitePath = path.join(dir, "database.sqlite");
  const db = openSqlite(sqlitePath);
  db.exec(`CREATE TABLE execution_entity ("id" INTEGER PRIMARY KEY, "workflowId" TEXT, "status" TEXT, "startedAt" TEXT, "stoppedAt" TEXT)`);
  db.exec(`CREATE TABLE workflow_entity ("id" TEXT PRIMARY KEY, "name" TEXT, "active" INTEGER)`);
  const insert = db.prepare(`INSERT INTO execution_entity ("workflowId","status","startedAt","stoppedAt") VALUES (?,?,?,?)`);
  const now = Date.now();
  for (let i = 0; i < 50; i += 1) {
    // Two-day spacing keeps every record clear of the 7/30/90 day bucket edges.
    const started = new Date(now - i * 2 * 86_400_000).toISOString();
    insert.run("wf1", "success", started, started);
  }
  db.prepare(`INSERT INTO workflow_entity VALUES (?,?,?)`).run("wf1", "Demo", 1);
  db.close();
});

function service(): GuardService {
  return new GuardService(
    loadConfig({
      // Port 9 is the discard service: reliably refuses connections.
      N8N_URL: "http://127.0.0.1:9",
      N8N_API_KEY: "irrelevant-because-nothing-answers",
      N8N_SQLITE_PATH: sqlitePath,
      N8N_GUARD_TIMEOUT_MS: "1000",
    }),
  );
}

describe("GuardService.fullRun under partial outage", () => {
  it("completes the datastore checks while the API and git steps fail", async () => {
    const report = await service().fullRun({ runOptions: { backoff: async () => undefined } });

    expect(report.degraded).toBe(true);
    expect(report.summary.ok).toBeGreaterThanOrEqual(3);

    const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
    expect(byName.datastore?.status).toBe("ok");
    expect(byName.db_health?.status).toBe("ok");
    expect(byName.retention?.status).toBe("ok");
    expect(byName.stuck_executions?.status).toBe("failed");
    expect(byName.git_drift?.status).toBe("failed");
    expect(byName.git_drift?.error).toContain("N8N_GIT_REPO_PATH");
  });

  it("names the failures in its findings instead of swallowing them", async () => {
    const report = await service().fullRun({ runOptions: { backoff: async () => undefined } });
    expect(report.findings.join("\n")).toMatch(/stuck_executions failed/);
    expect(report.findings.join("\n")).toMatch(/checks completed despite the failures/);
  });

  it("retries the API steps before giving up", async () => {
    const report = await service().fullRun({ runOptions: { backoff: async () => undefined } });
    expect(report.steps.find((s) => s.name === "stuck_executions")?.attempts).toBe(3);
  });

  it("reads real numbers out of the SQLite datastore", async () => {
    const stats = await service().datastoreStats();
    expect(stats.kind).toBe("sqlite");
    expect(stats.executionCount).toBe(50);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.tables.map((t) => t.table)).toContain("execution_entity");
    expect(stats.executionsOlderThanDays["7"]).toBe(46);
    expect(stats.executionsOlderThanDays["30"]).toBe(35);
    expect(stats.executionsOlderThanDays["365"]).toBe(0);
  });

  it("skips dependent checks when the datastore itself is unreadable", async () => {
    const broken = new GuardService(
      loadConfig({ N8N_URL: "http://127.0.0.1:9", N8N_SQLITE_PATH: "/nonexistent/database.sqlite", N8N_GUARD_TIMEOUT_MS: "1000" }),
    );
    const report = await broken.fullRun({ runOptions: { backoff: async () => undefined } });

    const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
    expect(byName.datastore?.status).toBe("failed");
    expect(byName.db_health?.status).toBe("skipped");
    expect(byName.retention?.status).toBe("skipped");
    // The run still returns a report rather than throwing.
    expect(report.steps).toHaveLength(6);
  });
});

describe("SQLite timestamp formats", () => {
  /**
   * n8n has stored startedAt both as ISO text and as epoch millis. In SQLite
   * integers sort before every string, so a text-only comparison counts every
   * numeric row as ancient and retention_report proposes deleting everything.
   */
  it("buckets epoch-millis timestamps by real age, not by storage type", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "n8n-guard-epoch-"));
    const file = path.join(dir, "database.sqlite");
    const db = openSqlite(file);
    db.exec(`CREATE TABLE execution_entity ("id" INTEGER PRIMARY KEY, "workflowId" TEXT, "status" TEXT, "startedAt" INTEGER, "stoppedAt" INTEGER)`);
    const insert = db.prepare(`INSERT INTO execution_entity ("workflowId","status","startedAt","stoppedAt") VALUES (?,?,?,?)`);
    const now = Date.now();
    insert.run("wf1", "success", now, now);
    insert.run("wf1", "success", now - 60 * 86_400_000, now - 60 * 86_400_000);
    db.close();

    const stats = await new GuardService(loadConfig({ N8N_SQLITE_PATH: file })).datastoreStats();

    expect(stats.executionCount).toBe(2);
    expect(stats.executionsOlderThanDays["7"]).toBe(1);
    expect(stats.executionsOlderThanDays["90"]).toBe(0);
    expect(stats.oldestExecutionAt).toBe(new Date(now - 60 * 86_400_000).toISOString());
  });
});
