import type { DatastoreStats } from "../n8n/datastore.js";
import { humanBytes } from "./dbHealth.js";

export interface RetentionReport {
  executionCount: number;
  oldestExecutionAt: string | null;
  newestExecutionAt: string | null;
  spanDays: number | null;
  executionsPerDay: number | null;
  buckets: { olderThanDays: number; rows: number; share: number; estimatedBytes: number | null }[];
  recommendation: {
    keepDays: number;
    prunableRows: number;
    estimatedBytesFreed: number | null;
    estimatedHumanFreed: string | null;
  } | null;
  findings: string[];
  /** n8n prunes on its own only when these are set; guard reports, it never writes. */
  hint: string;
}

/**
 * Turns raw execution counts into "what does deleting old runs actually buy me".
 * Byte figures are estimates: they assume execution rows cost the same on
 * average, which is what the row-count-to-size ratio can support.
 */
export function analyzeRetention(stats: DatastoreStats, keepDays = 30, now: number = Date.now()): RetentionReport {
  const oldest = stats.oldestExecutionAt ? Date.parse(stats.oldestExecutionAt) : NaN;
  const newest = stats.newestExecutionAt ? Date.parse(stats.newestExecutionAt) : NaN;
  const spanDays =
    Number.isNaN(oldest) || Number.isNaN(newest) ? null : Math.max((newest - oldest) / 86_400_000, 1 / 24);
  const executionsPerDay = spanDays === null ? null : stats.executionCount / spanDays;

  // Only execution-shaped tables shrink when executions are pruned.
  const executionTables = stats.tables.filter((t) => t.table.startsWith("execution_"));
  const executionBytes = executionTables.every((t) => t.bytes === null)
    ? stats.totalBytes || null
    : executionTables.reduce((sum, t) => sum + (t.bytes ?? 0), 0);
  const bytesPerRow = stats.executionCount > 0 && executionBytes ? executionBytes / stats.executionCount : null;

  const buckets = Object.entries(stats.executionsOlderThanDays)
    .map(([days, rows]) => ({
      olderThanDays: Number(days),
      rows,
      share: stats.executionCount > 0 ? rows / stats.executionCount : 0,
      estimatedBytes: bytesPerRow === null ? null : Math.round(rows * bytesPerRow),
    }))
    .sort((a, b) => a.olderThanDays - b.olderThanDays);

  const chosen = buckets.find((b) => b.olderThanDays === keepDays) ?? null;
  const recommendation = chosen
    ? {
        keepDays,
        prunableRows: chosen.rows,
        estimatedBytesFreed: chosen.estimatedBytes,
        estimatedHumanFreed: chosen.estimatedBytes === null ? null : humanBytes(chosen.estimatedBytes),
      }
    : null;

  const findings: string[] = [];
  findings.push(
    `${stats.executionCount} execution records` +
      (spanDays !== null ? ` spanning ${spanDays.toFixed(1)} days (${executionsPerDay!.toFixed(1)}/day)` : ""),
  );
  if (recommendation && recommendation.prunableRows > 0) {
    findings.push(
      `keeping ${keepDays} days would drop ${recommendation.prunableRows} rows` +
        (recommendation.estimatedHumanFreed ? `, roughly ${recommendation.estimatedHumanFreed}` : ""),
    );
  } else if (stats.executionCount > 0) {
    findings.push(`nothing older than ${keepDays} days, retention is already tight`);
  }

  return {
    executionCount: stats.executionCount,
    oldestExecutionAt: stats.oldestExecutionAt,
    newestExecutionAt: stats.newestExecutionAt,
    spanDays: spanDays === null ? null : Number(spanDays.toFixed(2)),
    executionsPerDay: executionsPerDay === null ? null : Number(executionsPerDay.toFixed(2)),
    buckets,
    recommendation,
    findings,
    hint:
      "n8n-guard never deletes. To act on this, set EXECUTIONS_DATA_PRUNE=true and " +
      `EXECUTIONS_DATA_MAX_AGE=${keepDays * 24} (hours) on the n8n instance, then restart it.`,
  };
}
