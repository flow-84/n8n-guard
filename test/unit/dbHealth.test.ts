import { describe, expect, it } from "vitest";
import { assessDatabaseHealth, humanBytes } from "../../src/checks/dbHealth.js";
import type { DatastoreStats } from "../../src/n8n/datastore.js";

const NOW = Date.parse("2026-09-06T00:00:00Z");
const GB = 1024 ** 3;

function stats(overrides: Partial<DatastoreStats> = {}): DatastoreStats {
  return {
    kind: "sqlite",
    totalBytes: 100 * 1024 * 1024,
    components: [{ name: "database.sqlite", bytes: 100 * 1024 * 1024 }],
    tables: [
      { table: "execution_entity", rows: 1000, bytes: 20 * 1024 * 1024 },
      { table: "execution_data", rows: 1000, bytes: 70 * 1024 * 1024 },
    ],
    executionCount: 1000,
    oldestExecutionAt: "2026-08-07T00:00:00Z",
    newestExecutionAt: "2026-09-05T00:00:00Z",
    executionsOlderThanDays: { "7": 800, "30": 0, "90": 0, "365": 0 },
    ...overrides,
  };
}

const thresholds = { warnBytes: GB, criticalBytes: 4 * GB };

describe("humanBytes", () => {
  it("formats across units", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(5 * GB)).toBe("5.0 GB");
  });
});

describe("assessDatabaseHealth", () => {
  it("stays ok below the warning threshold", () => {
    const report = assessDatabaseHealth(stats(), thresholds, NOW);
    expect(report.severity).toBe("ok");
  });

  it("warns at the warning threshold and escalates at the critical one", () => {
    expect(assessDatabaseHealth(stats({ totalBytes: GB }), thresholds, NOW).severity).toBe("warning");
    expect(assessDatabaseHealth(stats({ totalBytes: 5 * GB }), thresholds, NOW).severity).toBe("critical");
  });

  it("projects when growth will reach the critical threshold", () => {
    // 3 GB accumulated over 30 days = 0.1 GB/day, 1 GB of headroom left.
    const report = assessDatabaseHealth(stats({ totalBytes: 3 * GB }), thresholds, NOW);
    expect(report.growthBytesPerDay).toBeCloseTo(GB / 10, -6);
    expect(report.daysUntilCritical).toBeCloseTo(10, 0);
    expect(report.severity).toBe("warning");
    expect(report.findings.join(" ")).toContain("10.0 days");
  });

  it("reports zero days left once the critical threshold is passed", () => {
    const report = assessDatabaseHealth(stats({ totalBytes: 9 * GB }), thresholds, NOW);
    expect(report.daysUntilCritical).toBe(0);
    expect(report.severity).toBe("critical");
  });

  it("names the table that dominates the datastore", () => {
    const report = assessDatabaseHealth(stats(), thresholds, NOW);
    expect(report.tables[0]?.table).toBe("execution_data");
    expect(report.findings.join(" ")).toContain("execution_data holds 70%");
  });

  it("says so when per-table sizes are unavailable", () => {
    const report = assessDatabaseHealth(
      stats({ tables: [{ table: "execution_entity", rows: 5, bytes: null }] }),
      thresholds,
      NOW,
    );
    expect(report.findings.join(" ")).toContain("dbstat");
  });

  it("survives an empty instance without dividing by zero", () => {
    const report = assessDatabaseHealth(
      stats({ totalBytes: 0, executionCount: 0, oldestExecutionAt: null, newestExecutionAt: null, tables: [] }),
      thresholds,
      NOW,
    );
    expect(report.severity).toBe("ok");
    expect(report.growthBytesPerDay).toBeNull();
    expect(report.bytesPerExecution).toBeNull();
  });
});
