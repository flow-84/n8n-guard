export type StepStatus = "ok" | "failed" | "skipped";

export interface Step<T = unknown> {
  name: string;
  /** Human-readable purpose, surfaced in the report so a partial run still explains itself. */
  description: string;
  run: () => Promise<T>;
  /** Extra attempts after the first one. Transient failures are the norm here. */
  retries?: number;
  /** Names of steps whose results this one needs. A failed dependency skips it. */
  dependsOn?: string[];
}

export interface StepResult {
  name: string;
  description: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  result?: unknown;
  error?: string;
  /** Set when the step was skipped: which dependency was not available. */
  skippedBecause?: string;
}

export interface GuardRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** true when at least one step failed but the run still produced results. */
  degraded: boolean;
  summary: { ok: number; failed: number; skipped: number };
  steps: StepResult[];
  findings: string[];
}

export interface RunOptions {
  /** Delay between retries; injectable so tests do not sleep. */
  backoff?: (attempt: number) => Promise<void>;
  now?: () => number;
}

const defaultBackoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 4000)));

/**
 * The recovery core. A monitoring run that aborts on the first unreachable
 * dependency is worthless precisely when it matters: the API being down is the
 * incident, not a reason to stop looking at the disk. Every step is isolated,
 * retried, and its failure is reported as a finding rather than thrown.
 */
export async function runSteps(steps: Step[], options: RunOptions = {}): Promise<GuardRunReport> {
  const backoff = options.backoff ?? defaultBackoff;
  const now = options.now ?? Date.now;

  const startedAtMs = now();
  const results: StepResult[] = [];
  const byName = new Map<string, StepResult>();

  for (const step of steps) {
    const failedDependency = (step.dependsOn ?? []).find((dep) => byName.get(dep)?.status !== "ok");
    if (failedDependency) {
      const record: StepResult = {
        name: step.name,
        description: step.description,
        status: "skipped",
        attempts: 0,
        durationMs: 0,
        skippedBecause: byName.has(failedDependency)
          ? `depends on ${failedDependency}, which ${byName.get(failedDependency)!.status}`
          : `depends on ${failedDependency}, which did not run`,
      };
      results.push(record);
      byName.set(step.name, record);
      continue;
    }

    const stepStart = now();
    const maxAttempts = 1 + Math.max(0, step.retries ?? 0);
    let attempts = 0;
    let lastError: unknown;
    let value: unknown;
    let ok = false;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        value = await step.run();
        ok = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempts < maxAttempts) await backoff(attempts);
      }
    }

    const record: StepResult = ok
      ? { name: step.name, description: step.description, status: "ok", attempts, durationMs: now() - stepStart, result: value }
      : {
          name: step.name,
          description: step.description,
          status: "failed",
          attempts,
          durationMs: now() - stepStart,
          error: errorMessage(lastError),
        };
    results.push(record);
    byName.set(step.name, record);
  }

  const summary = {
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  const findings: string[] = [];
  for (const record of results) {
    if (record.status === "failed") findings.push(`${record.name} failed after ${record.attempts} attempt(s): ${record.error}`);
    if (record.status === "skipped") findings.push(`${record.name} skipped: ${record.skippedBecause}`);
  }
  if (summary.failed === 0 && summary.skipped === 0) findings.push(`all ${summary.ok} checks completed`);
  else findings.push(`${summary.ok} of ${results.length} checks completed despite the failures above`);

  const finishedAtMs = now();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    degraded: summary.failed > 0 || summary.skipped > 0,
    summary,
    steps: results,
    findings,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
