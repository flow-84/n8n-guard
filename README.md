# n8n-guard

[![npm](https://img.shields.io/npm/v/n8n-guard.svg)](https://www.npmjs.com/package/n8n-guard)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.flow--84%2Fn8n--guard-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=n8n-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

An MCP server for the operational layer *underneath* the n8n Public API.

Every n8n MCP server on the registry today is a wrapper around the same public
endpoints: list workflows, list executions, create, activate, delete. That is
useful for building workflows. It is close to useless for keeping a self-hosted
instance alive, because the things that actually take an instance down are not
in that API at all.

n8n-guard answers the four questions the API cannot:

1. **How big is the datastore, and when does it become a problem?** The Public
   API has no endpoint for database size. n8n-guard reads the SQLite file or
   queries Postgres directly, breaks the size down per table, derives the growth
   rate, and tells you how many days of headroom are left.
2. **Which executions are stuck?** Listing executions by status is not
   detection. A run sitting in `running` looks identical to a healthy long job
   until you compare it against what that workflow normally takes. n8n-guard
   builds a per-workflow median from finished runs and flags the outliers.
3. **What is retention costing?** How many execution records are stored, how far
   back they reach, and what a given retention window would free.
4. **Has the instance drifted from git?** Existing servers diff one API object
   against another. n8n-guard diffs the running instance against the JSON
   exports in a repository: live but never exported, exported but deleted,
   and content that quietly diverged.

It is strictly read-only. n8n-guard never writes to your instance, never deletes
executions, and never activates or edits a workflow. It reports; you decide.

## Install

```bash
npx -y n8n-guard
```

Requires Node.js 22 or newer (it uses the built-in `node:sqlite`). For a
permanent install use `npm install -g n8n-guard`.

### Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "n8n-guard": {
      "command": "n8n-guard",
      "env": {
        "N8N_URL": "https://n8n.example.com",
        "N8N_API_KEY": "n8n_api_...",
        "N8N_SQLITE_PATH": "/var/lib/n8n/.n8n/database.sqlite",
        "N8N_GIT_REPO_PATH": "/srv/workflow-exports"
      }
    }
  }
}
```

## Configuration

Everything is an environment variable. There are no hardcoded hosts, paths,
container names or accounts, so the server runs against any self-hosted
instance.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `N8N_URL` | no | `http://localhost:5678` | Base URL of the instance |
| `N8N_API_KEY` | for execution and workflow checks | none | Public API key (Settings, n8n API) |
| `N8N_SQLITE_PATH` | for datastore checks on SQLite | none | Path to `database.sqlite` |
| `N8N_POSTGRES_URL` | for datastore checks on Postgres | none | Connection string, takes precedence over SQLite |
| `N8N_GIT_REPO_PATH` | for the drift check | none | Checkout holding exported workflow JSON |
| `N8N_GUARD_STUCK_MINUTES` | no | `15` | Minutes in `running` before a run counts as stuck |
| `N8N_GUARD_DB_WARN_BYTES` | no | `1073741824` (1 GB) | Datastore warning threshold |
| `N8N_GUARD_DB_CRITICAL_BYTES` | no | `4294967296` (4 GB) | Datastore critical threshold |
| `N8N_GUARD_TIMEOUT_MS` | no | `15000` | Per-request API timeout |

Partial configuration is a supported mode, not an error. With only `N8N_URL` and
`N8N_SQLITE_PATH` you still get disk and retention answers; the API-backed checks
report that they are unconfigured and the rest of the run continues.

## Tools

| Tool | What it does |
|---|---|
| `instance_info` | Reachability, configured datastore, workflow inventory. Shows which checks are usable. |
| `db_health` | Datastore size, per-table breakdown, growth rate, projected days until the critical threshold. |
| `stuck_executions` | Runs stuck in `running`, judged against the absolute threshold and each workflow's own median. |
| `retention_report` | Execution count, age span, and what pruning to a retention window would free. |
| `git_drift` | Live workflows against the repository exports: missing, deleted, drifted, duplicated. |
| `guard_run` | All of the above in one resilient sweep. This is the one to schedule. |

## Example call

Point the server at an instance and let your client call a tool. Every tool
answers with a readable summary first and the full structured payload after it:

```
## Retention report
- 200 execution records spanning 8.3 days (24.1/day)
- nothing older than 30 days, retention is already tight
- n8n-guard never deletes. To act on this, set EXECUTIONS_DATA_PRUNE=true and
  EXECUTIONS_DATA_MAX_AGE=720 (hours) on the n8n instance, then restart it.
```

followed by the structured payload the summary was derived from:

```json
{
  "executionCount": 200,
  "oldestExecutionAt": "2026-08-28T23:43:28.651Z",
  "spanDays": 8.29,
  "executionsPerDay": 24.12,
  "buckets": [
    { "olderThanDays": 7, "rows": 32, "share": 0.16, "estimatedBytes": 3277 },
    { "olderThanDays": 30, "rows": 0, "share": 0, "estimatedBytes": 0 }
  ]
}
```

`guard_run` wraps all six checks. With only a datastore configured it reports
the gap instead of aborting:

```
## Guard run (degraded)
- stuck_executions failed after 3 attempt(s): N8N_API_KEY is not set, so the n8n Public API cannot be queried
- git_drift failed after 2 attempt(s): N8N_GIT_REPO_PATH is not set, so there is nothing to diff the instance against
- 4 of 6 checks completed despite the failures above
```

## Recovery: `guard_run` survives a partial outage

A monitoring run that aborts on the first unreachable dependency is worthless
precisely when it matters. The API being down *is* the incident, and it is no
reason to stop looking at the disk.

`guard_run` isolates every step. A failing step is retried with backoff, and if
it still fails it becomes a finding while the remaining checks run to completion.
Steps that depend on a failed step are skipped with the reason attached rather
than crashing on missing input. The report says so plainly:

```
## Guard run (degraded)
- stuck_executions failed after 3 attempt(s): cannot reach http://n8n.internal:5678: fetch failed
- git_drift skipped: depends on instance, which failed
- 4 of 6 checks completed despite the failures above
```

This behaviour is covered by tests in `test/unit/runner.test.ts` and
`test/unit/serviceRecovery.test.ts`, the latter running a real SQLite datastore
against a deliberately dead API endpoint.

## Render Workflows

The same sweep also runs as a [Render Workflow](https://render.com/docs/workflows):
one Render task per check, with ordering, retries and backoff declared in the
task definitions and executed by Render rather than by the in-process runner.
Deploy steps, the task table and how to trigger a run (including a deliberate
failure that demonstrates the retry path) are in
[`docs/render-workflow.md`](docs/render-workflow.md).

## Try it on a throwaway instance

The compose file starts a fresh n8n you can safely point the server at. The data
directory is bind-mounted, which is exactly how n8n-guard reads a real
deployment.

```bash
git clone https://github.com/flow-84/n8n-guard && cd n8n-guard
npm install && npm run build

docker compose up -d
./scripts/demo-setup.sh     # owner, API key, workflows, and a drifted export folder
```

The script generates the owner password, keeps it in the gitignored
`.n8n-demo-credentials`, and prints it along with the environment block to run
the server with. It seeds one workflow that matches its export, one that was
never exported, one that points at a sink container so a run can hang, and one
export whose workflow does not exist, so `git_drift` and `stuck_executions`
have something real to find.

```bash
export N8N_URL=http://localhost:5679
export N8N_API_KEY=...            # printed by the script
export N8N_SQLITE_PATH=$PWD/.n8n-demo/database.sqlite
export N8N_GIT_REPO_PATH=$PWD/.n8n-demo-exports
npm start
```

The instance publishes on 5679, not on n8n's default 5678, so it cannot collide
with an instance you care about. Set `N8N_DEMO_PORT` to move it, and pass the
same value to `demo-setup.sh`, the integration tests and `N8N_URL`.

## Tests

```bash
npm test              # unit tests, no instance required
npm run test:integration   # against the compose instance above
```

The integration suite skips the API-backed cases when `N8N_API_KEY` is unset, so
it stays runnable on a bare `docker compose up`.

## License

MIT
