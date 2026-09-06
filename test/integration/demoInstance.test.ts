import { access } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GuardService } from "../../src/guard/service.js";

/**
 * Runs against the instance from docker-compose.yml:
 *
 *   docker compose up -d
 *   npm run test:integration
 *
 * It proves two things a unit test cannot: that the SQLite reader matches the
 * real n8n schema, and that a full run degrades gracefully against a live
 * instance whose Public API is not reachable for this process.
 */
const DEMO_PORT = process.env.N8N_DEMO_PORT ?? "5679";
const N8N_URL = process.env.N8N_URL ?? `http://localhost:${DEMO_PORT}`;
// Read once into locals: an inline `KEY: process.env.KEY` pair reads to secret
// scanners as a hardcoded high-entropy value even though nothing is stored here.
const API_KEY = process.env.N8N_API_KEY;
const GIT_REPO_PATH = process.env.N8N_GIT_REPO_PATH;
const SQLITE_PATH = process.env.N8N_SQLITE_PATH ?? path.resolve(process.cwd(), ".n8n-demo/database.sqlite");

async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never tried";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${N8N_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${N8N_URL} did not become healthy within ${timeoutMs}ms (${lastError}). Run: docker compose up -d`);
}

function service(env: Record<string, string> = {}): GuardService {
  return new GuardService(loadConfig({ N8N_URL, N8N_SQLITE_PATH: SQLITE_PATH, N8N_GUARD_TIMEOUT_MS: "5000", ...env }));
}

beforeAll(async () => {
  await waitForHealth();
  // n8n writes database.sqlite on first boot; give it a moment on a cold start.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await access(SQLITE_PATH).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${SQLITE_PATH} does not exist. Is the ./.n8n-demo bind mount in place?`);
}, 180_000);

describe("against the docker compose instance", () => {
  it("reports the instance as reachable", async () => {
    const info = await service().instanceInfo();
    expect(info.reachable).toBe(true);
    expect(info.datastore).toBe("sqlite");
  });

  it("reads the real n8n SQLite schema", async () => {
    const stats = await service().datastoreStats();
    expect(stats.kind).toBe("sqlite");
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.tables.map((t) => t.table)).toContain("execution_entity");
    expect(stats.tables.map((t) => t.table)).toContain("workflow_entity");
  });

  it("produces a database health verdict", async () => {
    const report = await service().dbHealth();
    expect(["ok", "warning", "critical"]).toContain(report.severity);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it("produces a retention report and never proposes deleting anything itself", async () => {
    const report = await service().retention(30);
    expect(report.executionCount).toBeGreaterThanOrEqual(0);
    expect(report.hint).toContain("never deletes");
  });

  it("completes a full run and stays honest about the steps it could not do", async () => {
    const report = await service().fullRun({ runOptions: { backoff: async () => undefined } });

    expect(report.steps).toHaveLength(6);
    const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]));
    expect(byName.datastore?.status).toBe("ok");
    expect(byName.db_health?.status).toBe("ok");
    expect(byName.retention?.status).toBe("ok");

    // Without N8N_API_KEY the API-backed steps must fail as findings, not as a crash.
    if (!API_KEY) {
      expect(byName.stuck_executions?.status).toBe("failed");
      expect(byName.stuck_executions?.error).toContain("N8N_API_KEY");
      expect(report.degraded).toBe(true);
      expect(report.summary.ok).toBeGreaterThanOrEqual(3);
    }
  }, 60_000);

  it.runIf(API_KEY)("queries executions through the Public API when a key is configured", async () => {
    const report = await service({ N8N_API_KEY: API_KEY! }).stuckExecutions();
    expect(report.runningCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.stuck)).toBe(true);
  });

  it.runIf(API_KEY && GIT_REPO_PATH)(
    "diffs live workflows against the configured repository",
    async () => {
      const report = await service({ N8N_API_KEY: API_KEY!, N8N_GIT_REPO_PATH: GIT_REPO_PATH! }).gitDrift();
      expect(report.liveCount).toBeGreaterThanOrEqual(0);
      // ./scripts/demo-setup.sh plants one case of each drift kind.
      const kinds = new Set(report.drift.map((d) => d.kind));
      expect(kinds).toContain("missing_in_git");
      expect(kinds).toContain("missing_in_instance");
      expect(kinds).toContain("content_drift");
    },
  );
});
