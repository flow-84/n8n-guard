import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GuardConfig } from "./config.js";
import { GuardService } from "./guard/service.js";
import { errorMessage } from "./guard/runner.js";

export const SERVER_NAME = "n8n-guard";
export const SERVER_VERSION = "0.1.0";

interface ToolPayload {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function render(title: string, findings: string[], payload: unknown): ToolPayload {
  const text = [`## ${title}`, ...findings.map((f) => `- ${f}`), "", "```json", JSON.stringify(payload, null, 2), "```"].join("\n");
  return { content: [{ type: "text", text }], structuredContent: payload as Record<string, unknown> };
}

/** Tool errors are answers too: the caller needs the reason, not a transport fault. */
function failure(title: string, error: unknown): ToolPayload {
  return {
    content: [{ type: "text", text: `## ${title}\n\n**failed:** ${errorMessage(error)}` }],
    isError: true,
  };
}

export function createServer(config: GuardConfig): McpServer {
  const guard = new GuardService(config);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "instance_info",
    {
      title: "Instance info",
      description:
        "Reachability, configuration and workflow inventory of the monitored n8n instance. Start here: it shows which checks are configured and which are not.",
      inputSchema: {},
    },
    async () => {
      try {
        const info = await guard.instanceInfo();
        const findings = [
          info.reachable ? `${info.url} is reachable (${info.detail})` : `${info.url} is NOT reachable: ${info.detail}`,
          `datastore: ${info.datastore}`,
          info.apiKeyConfigured ? "API key configured" : "no API key: execution and workflow checks are unavailable",
          info.gitRepoConfigured ? "git repository configured" : "no git repository: drift check is unavailable",
        ];
        if (info.workflowCount !== null) findings.push(`${info.workflowCount} workflows, ${info.activeWorkflowCount} active`);
        return render("Instance info", findings, info);
      } catch (error) {
        return failure("Instance info", error);
      }
    },
  );

  server.registerTool(
    "db_health",
    {
      title: "Database health",
      description:
        "Size, per-table breakdown and growth rate of the n8n datastore, plus an estimate of when it hits the critical threshold. Works on SQLite and Postgres. The n8n Public API has no endpoint for this.",
      inputSchema: {},
    },
    async () => {
      try {
        const report = await guard.dbHealth();
        return render(`Database health (${report.severity})`, report.findings, report);
      } catch (error) {
        return failure("Database health", error);
      }
    },
  );

  server.registerTool(
    "stuck_executions",
    {
      title: "Stuck executions",
      description:
        "Executions sitting in `running` past a threshold or far past their own workflow's median runtime. Listing by status is not detection: this compares against a baseline.",
      inputSchema: {
        threshold_minutes: z
          .number()
          .positive()
          .optional()
          .describe("Minutes a run may stay in `running` before it counts as stuck. Defaults to N8N_GUARD_STUCK_MINUTES."),
      },
    },
    async ({ threshold_minutes }) => {
      try {
        const report = await guard.stuckExecutions(threshold_minutes);
        return render("Stuck executions", report.findings, report);
      } catch (error) {
        return failure("Stuck executions", error);
      }
    },
  );

  server.registerTool(
    "retention_report",
    {
      title: "Retention report",
      description:
        "How many execution records are stored, how far back they go, and what pruning to a retention window would free. Read-only: n8n-guard never deletes anything.",
      inputSchema: {
        keep_days: z.number().positive().optional().describe("Retention window to evaluate, in days. Defaults to 30."),
      },
    },
    async ({ keep_days }) => {
      try {
        const report = await guard.retention(keep_days ?? 30);
        return render("Retention report", [...report.findings, report.hint], report);
      } catch (error) {
        return failure("Retention report", error);
      }
    },
  );

  server.registerTool(
    "git_drift",
    {
      title: "Git drift",
      description:
        "Diffs the workflows in the running instance against the JSON exports in a git checkout: live but unexported, exported but deleted, and content that has drifted apart.",
      inputSchema: {},
    },
    async () => {
      try {
        const report = await guard.gitDrift();
        return render("Git drift", report.findings, report);
      } catch (error) {
        return failure("Git drift", error);
      }
    },
  );

  server.registerTool(
    "guard_run",
    {
      title: "Full guard run",
      description:
        "Runs every check in one resilient sweep. Individual steps retry and, if they still fail, are reported as findings while the remaining checks finish. Use this for scheduled monitoring.",
      inputSchema: {
        keep_days: z.number().positive().optional().describe("Retention window used by the retention step. Defaults to 30."),
      },
    },
    async ({ keep_days }) => {
      const report = await guard.fullRun({ keepDays: keep_days ?? 30 });
      const title = report.degraded ? "Guard run (degraded)" : "Guard run";
      return render(title, report.findings, report);
    },
  );

  return server;
}
