import { describe, expect, it } from "vitest";
import { findStuckExecutions, median } from "../../src/checks/stuckExecutions.js";
import type { N8nExecution } from "../../src/n8n/api.js";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const finished: N8nExecution[] = [
  { id: 1, workflowId: "wf-fast", status: "success", startedAt: "2026-09-06T11:00:00Z", stoppedAt: "2026-09-06T11:00:08Z" },
  { id: 2, workflowId: "wf-fast", status: "success", startedAt: "2026-09-06T11:10:00Z", stoppedAt: "2026-09-06T11:10:06Z" },
  { id: 3, workflowId: "wf-slow", status: "success", startedAt: "2026-09-06T10:00:00Z", stoppedAt: "2026-09-06T10:40:00Z" },
];

describe("median", () => {
  it("handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("findStuckExecutions", () => {
  it("flags a run past the absolute threshold", () => {
    const running: N8nExecution[] = [{ id: 10, workflowId: "wf-slow", status: "running", startedAt: minutesAgo(40) }];
    const report = findStuckExecutions(running, finished, 15, NOW);

    expect(report.stuck).toHaveLength(1);
    expect(report.stuck[0]).toMatchObject({ id: "10", severity: "warning" });
    expect(report.stuck[0]?.runningForMinutes).toBeCloseTo(40, 1);
  });

  it("escalates to critical at four times the threshold", () => {
    const running: N8nExecution[] = [{ id: 11, workflowId: "wf-slow", status: "running", startedAt: minutesAgo(70) }];
    expect(findStuckExecutions(running, finished, 15, NOW).stuck[0]?.severity).toBe("critical");
  });

  it("catches a run far past its own baseline even below the threshold", () => {
    // wf-fast normally takes 7s; 5 minutes is 43x that, but under a 15 min threshold.
    const running: N8nExecution[] = [{ id: 12, workflowId: "wf-fast", status: "running", startedAt: minutesAgo(5) }];
    const report = findStuckExecutions(running, finished, 15, NOW);

    expect(report.stuck).toHaveLength(1);
    expect(report.stuck[0]?.timesBaseline).toBeGreaterThan(20);
    expect(report.stuck[0]?.reason).toContain("baseline");
  });

  it("leaves a long-running workflow alone when that is its normal duration", () => {
    // wf-slow's median is 40 min, so 10 minutes in is neither over threshold nor anomalous.
    const running: N8nExecution[] = [{ id: 13, workflowId: "wf-slow", status: "running", startedAt: minutesAgo(9) }];
    const report = findStuckExecutions(running, finished, 15, NOW);

    expect(report.stuck).toHaveLength(0);
    expect(report.findings[0]).toContain("no stuck executions");
  });

  it("falls back to the overall baseline for an unknown workflow", () => {
    const running: N8nExecution[] = [{ id: 14, workflowId: "wf-new", status: "running", startedAt: minutesAgo(30) }];
    const report = findStuckExecutions(running, finished, 15, NOW);

    expect(report.stuck).toHaveLength(1);
    expect(report.overallBaselineSeconds).toBe(8);
  });

  it("ignores executions without a usable start time", () => {
    const running: N8nExecution[] = [
      { id: 15, workflowId: "wf-fast", status: "running", startedAt: null },
      { id: 16, workflowId: "wf-fast", status: "running", startedAt: "not a date" },
      { id: 17, workflowId: "wf-fast", status: "running", startedAt: minutesAgo(-5) },
    ];
    expect(findStuckExecutions(running, finished, 15, NOW).stuck).toHaveLength(0);
  });

  it("sorts the worst offender first", () => {
    const running: N8nExecution[] = [
      { id: 20, workflowId: "wf-slow", status: "running", startedAt: minutesAgo(20) },
      { id: 21, workflowId: "wf-slow", status: "running", startedAt: minutesAgo(90) },
    ];
    expect(findStuckExecutions(running, finished, 15, NOW).stuck.map((s) => s.id)).toEqual(["21", "20"]);
  });

  it("works with no finished executions to learn from", () => {
    const running: N8nExecution[] = [{ id: 30, workflowId: "wf-x", status: "running", startedAt: minutesAgo(60) }];
    const report = findStuckExecutions(running, [], 15, NOW);

    expect(report.overallBaselineSeconds).toBeNull();
    expect(report.stuck).toHaveLength(1);
    expect(report.stuck[0]?.timesBaseline).toBeNull();
  });
});
