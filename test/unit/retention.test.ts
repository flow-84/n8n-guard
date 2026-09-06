import { describe, expect, it } from "vitest";
import { analyzeRetention } from "../../src/checks/retention.js";
import type { DatastoreStats } from "../../src/n8n/datastore.js";

const NOW = Date.parse("2026-09-06T00:00:00Z");
const MB = 1024 * 1024;

const base: DatastoreStats = {
  kind: "postgres",
  totalBytes: 1000 * MB,
  components: [{ name: "database", bytes: 1000 * MB }],
  tables: [
    { table: "execution_entity", rows: 10_000, bytes: 100 * MB },
    { table: "execution_data", rows: 10_000, bytes: 800 * MB },
    { table: "workflow_entity", rows: 40, bytes: 5 * MB },
  ],
  executionCount: 10_000,
  oldestExecutionAt: "2026-06-08T00:00:00Z",
  newestExecutionAt: "2026-09-06T00:00:00Z",
  executionsOlderThanDays: { "7": 9000, "30": 7000, "90": 0, "365": 0 },
};

describe("analyzeRetention", () => {
  it("derives the execution rate from the stored span", () => {
    const report = analyzeRetention(base, 30, NOW);
    expect(report.spanDays).toBeCloseTo(90, 0);
    expect(report.executionsPerDay).toBeCloseTo(111, 0);
  });

  it("estimates freed bytes from the execution tables only", () => {
    // 900 MB across 10k rows = 92 KB/row; 7000 prunable rows ~ 630 MB.
    const report = analyzeRetention(base, 30, NOW);
    expect(report.recommendation?.prunableRows).toBe(7000);
    expect(report.recommendation?.estimatedBytesFreed).toBeCloseTo(0.7 * 900 * MB, -5);
    expect(report.recommendation?.estimatedHumanFreed).toBe("630 MB");
  });

  it("falls back to total size when per-table bytes are unknown", () => {
    const stats = { ...base, tables: base.tables.map((t) => ({ ...t, bytes: null })) };
    const report = analyzeRetention(stats, 30, NOW);
    expect(report.recommendation?.estimatedBytesFreed).toBeCloseTo(0.7 * 1000 * MB, -5);
  });

  it("returns no recommendation for a window without a matching bucket", () => {
    expect(analyzeRetention(base, 45, NOW).recommendation).toBeNull();
  });

  it("says retention is tight when nothing is old enough", () => {
    const stats = { ...base, executionsOlderThanDays: { "7": 3, "30": 0, "90": 0, "365": 0 } };
    expect(analyzeRetention(stats, 30, NOW).findings.join(" ")).toContain("already tight");
  });

  it("handles an empty instance", () => {
    const stats: DatastoreStats = {
      ...base,
      executionCount: 0,
      totalBytes: 0,
      tables: [],
      oldestExecutionAt: null,
      newestExecutionAt: null,
      executionsOlderThanDays: {},
    };
    const report = analyzeRetention(stats, 30, NOW);
    expect(report.spanDays).toBeNull();
    expect(report.buckets).toHaveLength(0);
    expect(report.recommendation).toBeNull();
  });

  it("never suggests a destructive command itself", () => {
    expect(analyzeRetention(base, 30, NOW).hint).toContain("never deletes");
  });
});
