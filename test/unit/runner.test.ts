import { describe, expect, it, vi } from "vitest";
import { runSteps, type Step } from "../../src/guard/runner.js";

const noBackoff = { backoff: async () => undefined };

describe("runSteps recovery", () => {
  it("finishes the remaining checks when one step fails", async () => {
    const steps: Step[] = [
      { name: "api", description: "reach api", run: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5678"); } },
      { name: "disk", description: "read disk", run: async () => ({ bytes: 42 }) },
      { name: "git", description: "read git", run: async () => ({ files: 3 }) },
    ];

    const report = await runSteps(steps, noBackoff);

    expect(report.summary).toEqual({ ok: 2, failed: 1, skipped: 0 });
    expect(report.degraded).toBe(true);
    expect(report.steps.find((s) => s.name === "disk")?.result).toEqual({ bytes: 42 });
    expect(report.findings.some((f) => f.includes("ECONNREFUSED"))).toBe(true);
  });

  it("retries a transient failure and recovers", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary");
      return "recovered";
    });

    const report = await runSteps([{ name: "flaky", description: "flaky check", retries: 2, run }], noBackoff);

    expect(report.summary.ok).toBe(1);
    expect(report.degraded).toBe(false);
    expect(report.steps[0]?.attempts).toBe(3);
    expect(report.steps[0]?.result).toBe("recovered");
  });

  it("gives up after the configured retries and reports why", async () => {
    const run = vi.fn(async () => { throw new Error("still down"); });

    const report = await runSteps([{ name: "down", description: "dead check", retries: 2, run }], noBackoff);

    expect(run).toHaveBeenCalledTimes(3);
    expect(report.steps[0]).toMatchObject({ status: "failed", attempts: 3, error: "still down" });
  });

  it("skips dependents of a failed step instead of crashing on their missing input", async () => {
    const dependent = vi.fn(async () => "never runs");
    const steps: Step[] = [
      { name: "datastore", description: "read datastore", run: async () => { throw new Error("no such file"); } },
      { name: "retention", description: "analyze retention", dependsOn: ["datastore"], run: dependent },
      { name: "stuck", description: "stuck executions", run: async () => "independent result" },
    ];

    const report = await runSteps(steps, noBackoff);

    expect(dependent).not.toHaveBeenCalled();
    expect(report.summary).toEqual({ ok: 1, failed: 1, skipped: 1 });
    expect(report.steps.find((s) => s.name === "retention")?.skippedBecause).toContain("datastore");
  });

  it("never throws, whatever a step does", async () => {
    const steps: Step[] = [
      { name: "throws-string", description: "bad throw", run: async () => { throw "not an Error"; } },
      { name: "ok", description: "fine", run: async () => 1 },
    ];

    await expect(runSteps(steps, noBackoff)).resolves.toMatchObject({ degraded: true });
  });

  it("reports a clean run as not degraded", async () => {
    const report = await runSteps([{ name: "a", description: "a", run: async () => 1 }], noBackoff);
    expect(report.degraded).toBe(false);
    expect(report.findings).toContain("all 1 checks completed");
  });
});
