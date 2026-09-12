import { describe, expect, it } from "vitest";
import type { TaskContext, TaskDefinition } from "@renderinc/sdk/workflows";
import { flakyProbe, guardRun, type GuardWorkflowReport } from "../../src/workflow/tasks.js";

/**
 * A context that answers ctx.run from a table instead of dispatching to Render,
 * which is how the SDK intends tasks to be exercised in tests.
 */
function fakeContext(answers: Record<string, (...args: unknown[]) => unknown>): TaskContext {
  return {
    run: async (task: TaskDefinition<never[], unknown>, ...args: unknown[]) => {
      const answer = answers[task.name];
      if (!answer) throw new Error(`unexpected task ${task.name}`);
      return answer(...args);
    },
  } as TaskContext;
}

const stats = { kind: "sqlite", totalBytes: 2048, components: [], tables: [{ table: "execution_entity", rows: 1, bytes: 2048 }], executionCount: 1, oldestExecutionAt: null, newestExecutionAt: null, executionsOlderThanDays: {} };

const happy = {
  instance: () => ({ reachable: true }),
  datastore: () => stats,
  db_health: () => ({ level: "ok" }),
  retention: () => ({ keepDays: 30 }),
  stuck_executions: () => ({ stuck: [] }),
  git_drift: () => ({ drifted: [] }),
};

describe("guard_run workflow task", () => {
  it("reports every check as ok when all child runs succeed", async () => {
    const report = (await guardRun.func(fakeContext(happy), {})) as GuardWorkflowReport;
    expect(report.summary).toEqual({ ok: 6, failed: 0 });
    expect(report.degraded).toBe(false);
    expect(report.steps.map((s) => s.name)).toEqual([
      "instance",
      "datastore",
      "db_health",
      "retention",
      "stuck_executions",
      "git_drift",
    ]);
  });

  it("keeps the disk answerable when the n8n API is down", async () => {
    const report = (await guardRun.func(
      fakeContext({ ...happy, instance: () => { throw new Error("connect ECONNREFUSED"); } }),
      {},
    )) as GuardWorkflowReport;
    expect(report.degraded).toBe(true);
    expect(report.summary).toEqual({ ok: 5, failed: 1 });
    expect(report.findings[0]).toContain("instance failed after Render exhausted its retries");
    expect(report.steps.find((s) => s.name === "db_health")?.status).toBe("ok");
  });

  it("marks the datastore-derived checks failed when the datastore is unreadable", async () => {
    const report = (await guardRun.func(
      fakeContext({ ...happy, datastore: () => { throw new Error("no datastore configured"); } }),
      {},
    )) as GuardWorkflowReport;
    expect(report.summary).toEqual({ ok: 3, failed: 3 });
    expect(report.steps.filter((s) => s.status === "failed").map((s) => s.name)).toEqual([
      "datastore",
      "db_health",
      "retention",
    ]);
  });

  it("runs the flaky probe first when a retry demo is requested", async () => {
    let attempts = 0;
    const report = (await guardRun.func(
      fakeContext({ ...happy, flaky_probe: () => { attempts += 1; return { succeededAt: "now" }; } }),
      { demoRetrySeconds: 5 },
    )) as GuardWorkflowReport;
    expect(attempts).toBe(1);
    expect(report.steps[0]?.name).toBe("flaky_probe");
  });
});

describe("flaky_probe task", () => {
  it("fails while the deadline is in the future and succeeds after it", async () => {
    const ctx = fakeContext({});
    await expect(flakyProbe.func(ctx, Date.now() + 60_000)).rejects.toThrow("deliberate failure");
    await expect(flakyProbe.func(ctx, Date.now() - 1)).resolves.toMatchObject({ succeededAt: expect.any(String) });
  });
});
