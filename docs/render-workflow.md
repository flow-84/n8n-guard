# n8n-guard on Render Workflows

The guard sweep runs as a real [Render Workflow](https://render.com/docs/workflows):
every check is a separate Render task with its own compute, its own retry policy
and its own entry in the run history. Ordering and retries are declared in the
task definitions (`src/workflow/tasks.ts`) and executed by Render. The in-process
step runner (`src/guard/runner.ts`) stays for the local MCP path only.

## Tasks

| Task | Role | Retry policy |
|---|---|---|
| `guard_run` | entry point, fans the checks out and assembles the report | none (children carry theirs) |
| `instance` | reach the n8n instance, read the workflow inventory | 2 retries, 1s, x2 |
| `datastore` | size and row counts of the n8n datastore | 1 retry, 1s |
| `db_health` | judge size and growth against thresholds | 1 retry, 1s |
| `retention` | what pruning old executions would free | 1 retry, 1s |
| `stuck_executions` | executions stuck in `running` vs their own baseline | 2 retries, 1s, x2 |
| `git_drift` | live workflows vs the JSON exports in git | 1 retry, 1s |
| `flaky_probe` | deliberate failure, on demand, to demonstrate the retry path | 3 retries, 5s, x2 |

`guard_run` starts `instance`, `datastore`, `stuck_executions` and `git_drift` in
parallel, then `db_health` and `retention` once the datastore stats exist. A task
that exhausts its Render retries becomes a finding, not an abort: the API being
down is the incident, not a reason to stop looking at the disk.

Every check is read-only, so a retry cannot duplicate an action.

## Deploying

1. Render Dashboard → **New > Workflow**, link `flow-84/n8n-guard`.
2. **Language**: Node. **Build Command**: `npm install && npm run build`.
   **Start Command**: `npm run start:workflow`.
3. Environment variables (same set the MCP server uses):
   `N8N_URL`, `N8N_API_KEY`, and `N8N_SQLITE_PATH` or `N8N_POSTGRES_URL`,
   optionally `N8N_GIT_REPO_PATH`, `N8N_GUARD_STUCK_MINUTES`,
   `N8N_GUARD_DB_WARN_BYTES`, `N8N_GUARD_DB_CRITICAL_BYTES`.
4. **Deploy Workflow**. The tasks above register on start.

## Running

From the dashboard: Tasks → `guard_run` → **Start Task**, input `[{}]`.

From the API, including the retry demonstration:

```bash
RENDER_API_KEY=rnd_... N8N_GUARD_WORKFLOW_SLUG=<workflow-slug> \
  npm run workflow:trigger -- --keep-days 30 --demo-retry 20
```

`--demo-retry 20` prepends the `flaky_probe` task, which throws for the first 20
seconds. Render retries it after 5s and 10s; the attempt history on that task's
run page is the proof that ordering and retries are Render's, not the guard's.
