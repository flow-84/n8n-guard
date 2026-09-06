import type { N8nExecution } from "../n8n/api.js";
import type { Severity } from "./dbHealth.js";

export interface StuckExecution {
  id: string;
  workflowId: string | null;
  startedAt: string | null;
  runningForMinutes: number;
  /** How many times the workflow's own median runtime this run has already taken. */
  timesBaseline: number | null;
  severity: Severity;
  reason: string;
}

export interface StuckReport {
  thresholdMinutes: number;
  runningCount: number;
  stuck: StuckExecution[];
  /** Median runtime in seconds per workflow, derived from finished executions. */
  baselineSecondsByWorkflow: Record<string, number>;
  overallBaselineSeconds: number | null;
  findings: string[];
}

function durationSeconds(execution: N8nExecution): number | null {
  if (!execution.startedAt || !execution.stoppedAt) return null;
  const start = Date.parse(execution.startedAt);
  const stop = Date.parse(execution.stoppedAt);
  if (Number.isNaN(start) || Number.isNaN(stop) || stop < start) return null;
  return (stop - start) / 1000;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Every other n8n MCP server lists executions by status. Listing is not
 * detection: a run stuck in `running` looks exactly like a healthy long job
 * until you compare it against what that workflow normally takes.
 */
export function findStuckExecutions(
  running: N8nExecution[],
  finished: N8nExecution[],
  thresholdMinutes: number,
  now: number = Date.now(),
): StuckReport {
  const durationsByWorkflow = new Map<string, number[]>();
  const allDurations: number[] = [];
  for (const execution of finished) {
    const seconds = durationSeconds(execution);
    if (seconds === null) continue;
    allDurations.push(seconds);
    const key = String(execution.workflowId ?? "");
    if (!key) continue;
    const bucket = durationsByWorkflow.get(key) ?? [];
    bucket.push(seconds);
    durationsByWorkflow.set(key, bucket);
  }

  const baselineSecondsByWorkflow: Record<string, number> = {};
  for (const [workflowId, values] of durationsByWorkflow) {
    const value = median(values);
    if (value !== null) baselineSecondsByWorkflow[workflowId] = value;
  }
  const overallBaselineSeconds = median(allDurations);

  const stuck: StuckExecution[] = [];
  for (const execution of running) {
    if (!execution.startedAt) continue;
    const started = Date.parse(execution.startedAt);
    if (Number.isNaN(started)) continue;
    const runningForMinutes = (now - started) / 60_000;
    if (runningForMinutes < 0) continue;

    const workflowId = execution.workflowId ? String(execution.workflowId) : null;
    const baseline = workflowId ? baselineSecondsByWorkflow[workflowId] ?? null : null;
    const effectiveBaseline = baseline ?? overallBaselineSeconds;
    const timesBaseline =
      effectiveBaseline && effectiveBaseline > 0 ? (runningForMinutes * 60) / effectiveBaseline : null;

    const overThreshold = runningForMinutes >= thresholdMinutes;
    // A run 20x its own median is suspicious even below the absolute threshold,
    // but only once it is past a minute -- sub-second jobs make the ratio noisy.
    const overBaseline = timesBaseline !== null && timesBaseline >= 20 && runningForMinutes >= 1;
    if (!overThreshold && !overBaseline) continue;

    const reasons: string[] = [];
    if (overThreshold) reasons.push(`running ${runningForMinutes.toFixed(1)} min, threshold is ${thresholdMinutes} min`);
    if (overBaseline) reasons.push(`${timesBaseline!.toFixed(0)}x the ${effectiveBaseline!.toFixed(1)}s baseline for this workflow`);

    stuck.push({
      id: String(execution.id),
      workflowId,
      startedAt: execution.startedAt,
      runningForMinutes: Number(runningForMinutes.toFixed(2)),
      timesBaseline: timesBaseline === null ? null : Number(timesBaseline.toFixed(1)),
      severity: overThreshold && runningForMinutes >= thresholdMinutes * 4 ? "critical" : "warning",
      reason: reasons.join("; "),
    });
  }

  stuck.sort((a, b) => b.runningForMinutes - a.runningForMinutes);

  const findings =
    stuck.length === 0
      ? [`no stuck executions among ${running.length} running`]
      : [
          `${stuck.length} of ${running.length} running executions are stuck`,
          ...stuck.slice(0, 5).map((s) => `execution ${s.id} (workflow ${s.workflowId ?? "unknown"}): ${s.reason}`),
        ];

  return {
    thresholdMinutes,
    runningCount: running.length,
    stuck,
    baselineSecondsByWorkflow,
    overallBaselineSeconds,
    findings,
  };
}
