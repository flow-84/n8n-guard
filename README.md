# n8n-guard

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
npm install -g n8n-guard
```

Requires Node.js 22 or newer (it uses the built-in `node:sqlite`).

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
the server with. It seeds one
workflow that matches its export, one that was never exported, and one export
whose workflow does not exist, so `git_drift` has something real to find.

```bash
export N8N_URL=http://localhost:5678
export N8N_API_KEY=...            # printed by the script
export N8N_SQLITE_PATH=$PWD/.n8n-demo/database.sqlite
export N8N_GIT_REPO_PATH=$PWD/.n8n-demo-exports
npm start
```

Use `N8N_DEMO_PORT=5679 docker compose up -d` if port 5678 is already taken by
an instance you care about.

## Tests

```bash
npm test              # unit tests, no instance required
npm run test:integration   # against the compose instance above
```

The integration suite skips the API-backed cases when `N8N_API_KEY` is unset, so
it stays runnable on a bare `docker compose up`.

## License

MIT
