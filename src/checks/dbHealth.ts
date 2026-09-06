import type { DatastoreStats } from "../n8n/datastore.js";

export type Severity = "ok" | "warning" | "critical";

export interface DbHealthThresholds {
  warnBytes: number;
  criticalBytes: number;
}

export interface DbHealthReport {
  kind: DatastoreStats["kind"];
  totalBytes: number;
  totalHuman: string;
  severity: Severity;
  components: { name: string; bytes: number }[];
  tables: { table: string; rows: number; bytes: number | null; share: number | null }[];
  /** Average bytes added per day, derived from the age of the oldest execution. */
  growthBytesPerDay: number | null;
  /** Days until the datastore reaches `criticalBytes` at the observed growth rate. */
  daysUntilCritical: number | null;
  /** Bytes stored per execution record; the lever that retention pruning pulls on. */
  bytesPerExecution: number | null;
  findings: string[];
}

export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const sign = bytes < 0 ? "-" : "";
  return `${sign}${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Pure assessment of a datastore snapshot. The n8n Public API exposes none of
 * this: it has no endpoint for database size, so an API wrapper cannot warn
 * before the disk fills up and the instance stops accepting executions.
 */
export function assessDatabaseHealth(
  stats: DatastoreStats,
  thresholds: DbHealthThresholds,
  now: number = Date.now(),
): DbHealthReport {
  const findings: string[] = [];

  let severity: Severity = "ok";
  if (stats.totalBytes >= thresholds.criticalBytes) severity = "critical";
  else if (stats.totalBytes >= thresholds.warnBytes) severity = "warning";

  if (severity !== "ok") {
    findings.push(
      `datastore is ${humanBytes(stats.totalBytes)}, at or past the ${severity} threshold of ` +
        `${humanBytes(severity === "critical" ? thresholds.criticalBytes : thresholds.warnBytes)}`,
    );
  }

  const oldest = stats.oldestExecutionAt ? Date.parse(stats.oldestExecutionAt) : NaN;
  const ageDays = Number.isNaN(oldest) ? null : Math.max((now - oldest) / 86_400_000, 1 / 24);
  const growthBytesPerDay = ageDays === null ? null : stats.totalBytes / ageDays;

  let daysUntilCritical: number | null = null;
  if (growthBytesPerDay !== null && growthBytesPerDay > 0) {
    const headroom = thresholds.criticalBytes - stats.totalBytes;
    daysUntilCritical = headroom <= 0 ? 0 : headroom / growthBytesPerDay;
    if (daysUntilCritical <= 30) {
      findings.push(
        `at ${humanBytes(growthBytesPerDay)}/day the datastore reaches ` +
          `${humanBytes(thresholds.criticalBytes)} in about ${daysUntilCritical.toFixed(1)} days`,
      );
      if (severity === "ok") severity = "warning";
    }
  }

  const bytesPerExecution = stats.executionCount > 0 ? stats.totalBytes / stats.executionCount : null;

  const tables = stats.tables
    .map((t) => ({ ...t, share: t.bytes !== null && stats.totalBytes > 0 ? t.bytes / stats.totalBytes : null }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows);

  const dominant = tables.find((t) => t.share !== null && t.share >= 0.5);
  if (dominant) {
    findings.push(`${dominant.table} holds ${(dominant.share! * 100).toFixed(0)}% of the datastore`);
  }
  if (stats.kind === "sqlite" && tables.every((t) => t.bytes === null)) {
    findings.push("per-table sizes unavailable: this SQLite build lacks the dbstat module, row counts only");
  }
  if (findings.length === 0) {
    findings.push(`datastore is ${humanBytes(stats.totalBytes)} and below all thresholds`);
  }

  return {
    kind: stats.kind,
    totalBytes: stats.totalBytes,
    totalHuman: humanBytes(stats.totalBytes),
    severity,
    components: stats.components,
    tables,
    growthBytesPerDay,
    daysUntilCritical,
    bytesPerExecution,
    findings,
  };
}
