import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { loadConfig } from "../config.js";
import { GuardService } from "../guard/service.js";
import type { DatastoreStats } from "../n8n/datastore.js";
import { humanBytes } from "../checks/dbHealth.js";

/**
 * The guard sweep as a Render Workflow.
 *
 * Every check is its own Render task: it gets its own instance, its own retry
 * policy and its own line in the run history. Ordering, retries and backoff are
 * declared here in the task definitions and executed by Render, not by the
 * in-process step runner in `src/guard/runner.ts` (which stays for the local
 * MCP path).
 */

/** Each task instance is short-lived, so the service is built per invocation. */
const guard = (): GuardService => new GuardService(loadConfig());

const RETRY_TRANSIENT = { maxRetries: 2, waitDurationMs: 1_000, backoffScaling: 2 };
const RETRY_LOCAL = { maxRetries: 1, waitDurationMs: 1_000 };

export const instance = task(
  { name: "instance", retry: RETRY_TRANSIENT, timeoutSeconds: 120 },
  async (_ctx: TaskContext) => guard().instanceInfo(),
);

export const datastore = task(
  { name: "datastore", retry: RETRY_LOCAL, timeoutSeconds: 300 },
  async (_ctx: TaskContext): Promise<DatastoreStats> => guard().datastoreStats(),
);

export const dbHealth = task(
  { name: "db_health", retry: RETRY_LOCAL, timeoutSeconds: 120 },
  async (_ctx: TaskContext, stats: DatastoreStats) => guard().dbHealth(stats),
);

export const retention = task(
  { name: "retention", retry: RETRY_LOCAL, timeoutSeconds: 120 },
  async (_ctx: TaskContext, stats: DatastoreStats, keepDays: number) =>
    guard().retention(keepDays, stats),
);

export const stuckExecutions = task(
  { name: "stuck_executions", retry: RETRY_TRANSIENT, timeoutSeconds: 300 },
  async (_ctx: TaskContext) => guard().stuckExecutions(),
);

export const gitDrift = task(
  { name: "git_drift", retry: RETRY_LOCAL, timeoutSeconds: 300 },
  async (_ctx: TaskContext) => guard().gitDrift(),
);

/**
 * A task that fails on purpose until a deadline passes, so a run can show a
 * real Render retry without touching the instance. It reads nothing and writes
 * nothing; it exists to make the retry path verifiable on demand.
 */
export const flakyProbe = task(
  { name: "flaky_probe", retry: { maxRetries: 3, waitDurationMs: 5_000, backoffScaling: 2 }, timeoutSeconds: 60 },
  async (_ctx: TaskContext, failUntilEpochMs: number) => {
    const now = Date.now();
    if (now < failUntilEpochMs) {
      throw new Error(
        `flaky_probe: deliberate failure, ${Math.ceil((failUntilEpochMs - now) / 1000)}s left before it succeeds`,
      );
    }
    return { succeededAt: new Date(now).toISOString() };
  },
);

export interface GuardStep {
  name: string;
  description: string;
  status: "ok" | "failed";
  result?: unknown;
  error?: string;
}

export interface GuardWorkflowReport {
  startedAt: string;
  finishedAt: string;
  degraded: boolean;
  summary: { ok: number; failed: number };
  steps: GuardStep[];
  findings: string[];
}

const DESCRIPTIONS: Record<string, string> = {
  instance: "reach the n8n instance and read its workflow inventory",
  datastore: "read size and row counts from the n8n datastore",
  db_health: "judge datastore size and growth against the configured thresholds",
  retention: "estimate what pruning old executions would free",
  stuck_executions: "detect executions stuck in running against their own baseline",
  git_drift: "compare live workflows against the exports in the git repository",
  flaky_probe: "deliberate failure, used to demonstrate Render's retry policy",
};

/**
 * Isolate one child run. A monitoring sweep that aborts on the first
 * unreachable dependency is worthless precisely when it matters: the API being
 * down is the incident, not a reason to stop looking at the disk. Render has
 * already exhausted the task's retries by the time this rejects.
 */
async function step<T>(name: string, run: () => Promise<T>): Promise<GuardStep & { value?: T }> {
  const description = DESCRIPTIONS[name] ?? name;
  try {
    const value = await run();
    return { name, description, status: "ok", result: value, value };
  } catch (error) {
    return { name, description, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export interface GuardRunInput {
  keepDays?: number;
  /** Seconds the flaky probe should keep failing. Omit or 0 to skip the probe. */
  demoRetrySeconds?: number;
}

/**
 * The entry point of the workflow: `guard_run`. It fans the checks out over
 * Render tasks and assembles the same report shape the MCP tool returns.
 */
export const guardRun = task(
  { name: "guard_run", timeoutSeconds: 1_800 },
  async (ctx: TaskContext, input: GuardRunInput = {}): Promise<GuardWorkflowReport> => {
    const keepDays = input.keepDays ?? 30;
    const startedAt = new Date().toISOString();
    const steps: GuardStep[] = [];

    if (input.demoRetrySeconds && input.demoRetrySeconds > 0) {
      const deadline = Date.now() + input.demoRetrySeconds * 1_000;
      steps.push(await step("flaky_probe", () => ctx.run(flakyProbe, deadline)));
    }

    const [instanceStep, datastoreStep, stuckStep, driftStep] = await Promise.all([
      step("instance", () => ctx.run(instance)),
      step("datastore", () => ctx.run(datastore)),
      step("stuck_executions", () => ctx.run(stuckExecutions)),
      step("git_drift", () => ctx.run(gitDrift)),
    ]);

    steps.push(instanceStep, datastoreStep);

    const stats = datastoreStep.value;
    if (stats) {
      const [health, ret] = await Promise.all([
        step("db_health", () => ctx.run(dbHealth, stats)),
        step("retention", () => ctx.run(retention, stats, keepDays)),
      ]);
      steps.push(health, ret);
    } else {
      for (const name of ["db_health", "retention"]) {
        steps.push({
          name,
          description: DESCRIPTIONS[name]!,
          status: "failed",
          error: "datastore failed, so there are no stats to judge",
        });
      }
    }

    steps.push(stuckStep, driftStep);

    const ok = steps.filter((s) => s.status === "ok").length;
    const failed = steps.length - ok;
    const findings = steps
      .filter((s) => s.status === "failed")
      .map((s) => `${s.name} failed after Render exhausted its retries: ${s.error}`);
    findings.push(
      failed === 0
        ? `all ${ok} checks completed`
        : `${ok} of ${steps.length} checks completed despite the failures above`,
    );
    if (stats) findings.push(`datastore is ${humanBytes(stats.totalBytes)} across ${stats.tables.length} tables`);

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      degraded: failed > 0,
      summary: { ok, failed },
      steps,
      findings,
    };
  },
);
