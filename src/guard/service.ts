import type { GuardConfig } from "../config.js";
import { N8nApi, type N8nExecution, type N8nWorkflow } from "../n8n/api.js";
import { readDatastoreStats, resolveDatastoreKind, type DatastoreStats } from "../n8n/datastore.js";
import { assessDatabaseHealth, humanBytes, type DbHealthReport } from "../checks/dbHealth.js";
import { findStuckExecutions, type StuckReport } from "../checks/stuckExecutions.js";
import { analyzeRetention, type RetentionReport } from "../checks/retention.js";
import { diffWorkflows, loadExportedWorkflows, type GitDriftReport } from "../checks/gitDrift.js";
import { runSteps, type GuardRunReport, type RunOptions, type Step } from "./runner.js";

export interface InstanceInfo {
  url: string;
  reachable: boolean;
  detail: string;
  apiKeyConfigured: boolean;
  datastore: string;
  gitRepoConfigured: boolean;
  workflowCount: number | null;
  activeWorkflowCount: number | null;
}

/**
 * One place that knows how to read the instance. The MCP tool layer above it
 * only formats; the check modules below it stay pure and testable.
 */
export class GuardService {
  readonly api: N8nApi;

  constructor(readonly config: GuardConfig) {
    this.api = new N8nApi(config);
  }

  async instanceInfo(): Promise<InstanceInfo> {
    const health = await this.api.health();
    let workflows: N8nWorkflow[] | null = null;
    if (this.config.n8nApiKey) {
      workflows = await this.api.listWorkflows().catch(() => null);
    }
    let datastore: string;
    try {
      datastore = resolveDatastoreKind(this.config);
    } catch {
      datastore = "not configured";
    }
    return {
      url: this.config.n8nUrl,
      reachable: health.reachable,
      detail: health.detail,
      apiKeyConfigured: Boolean(this.config.n8nApiKey),
      datastore,
      gitRepoConfigured: Boolean(this.config.gitRepoPath),
      workflowCount: workflows?.length ?? null,
      activeWorkflowCount: workflows?.filter((w) => w.active).length ?? null,
    };
  }

  datastoreStats(): Promise<DatastoreStats> {
    return readDatastoreStats(this.config);
  }

  async dbHealth(stats?: DatastoreStats): Promise<DbHealthReport> {
    const resolved = stats ?? (await this.datastoreStats());
    return assessDatabaseHealth(resolved, {
      warnBytes: this.config.dbWarnBytes,
      criticalBytes: this.config.dbCriticalBytes,
    });
  }

  async stuckExecutions(thresholdMinutes = this.config.stuckThresholdMinutes): Promise<StuckReport> {
    const [running, success, failed] = await Promise.all([
      this.api.listExecutions("running", 500),
      this.api.listExecutions("success", 500),
      this.api.listExecutions("error", 200),
    ]);
    const finished: N8nExecution[] = [...success, ...failed];
    return findStuckExecutions(running, finished, thresholdMinutes);
  }

  async retention(keepDays = 30, stats?: DatastoreStats): Promise<RetentionReport> {
    const resolved = stats ?? (await this.datastoreStats());
    return analyzeRetention(resolved, keepDays);
  }

  async gitDrift(): Promise<GitDriftReport> {
    if (!this.config.gitRepoPath) {
      throw new Error("N8N_GIT_REPO_PATH is not set, so there is nothing to diff the instance against");
    }
    const [live, exported] = await Promise.all([
      this.api.listWorkflows().then((list) => Promise.all(list.map((w) => this.api.getWorkflow(String(w.id))))),
      loadExportedWorkflows(this.config.gitRepoPath),
    ]);
    return diffWorkflows(live, exported);
  }

  /**
   * The background sweep for the `render` track: it survives a partial outage.
   * A dead API still leaves disk and retention answerable; a missing git repo
   * still leaves the API answerable. Failures become findings, not an abort.
   */
  async fullRun(options: { keepDays?: number; runOptions?: RunOptions } = {}): Promise<GuardRunReport> {
    const keepDays = options.keepDays ?? 30;
    let stats: DatastoreStats | undefined;

    const steps: Step[] = [
      {
        name: "instance",
        description: "reach the n8n instance and read its workflow inventory",
        retries: 2,
        run: () => this.instanceInfo(),
      },
      {
        name: "datastore",
        description: "read size and row counts from the n8n datastore",
        retries: 1,
        run: async () => {
          stats = await this.datastoreStats();
          return { kind: stats.kind, totalBytes: stats.totalBytes, totalHuman: humanBytes(stats.totalBytes) };
        },
      },
      {
        name: "db_health",
        description: "judge datastore size and growth against the configured thresholds",
        dependsOn: ["datastore"],
        run: () => this.dbHealth(stats),
      },
      {
        name: "retention",
        description: "estimate what pruning old executions would free",
        dependsOn: ["datastore"],
        run: () => this.retention(keepDays, stats),
      },
      {
        name: "stuck_executions",
        description: "detect executions stuck in running against their own baseline",
        retries: 2,
        run: () => this.stuckExecutions(),
      },
      {
        name: "git_drift",
        description: "compare live workflows against the exports in the git repository",
        retries: 1,
        run: () => this.gitDrift(),
      },
    ];

    return runSteps(steps, options.runOptions);
  }
}
