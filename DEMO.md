# Submission material

Everything needed to record the demo video, publish the announcement and fill in
the submission form. Every claim below is backed by the code in this repository
as of the commit this file ships with. Nothing here describes planned work.

## 1. Demo video script (screen recording, 2:00 maximum)

### Recording it: one command

```bash
./scripts/record-demo.sh
```

It builds, starts the throwaway compose instance on port 5679, seeds it, starts
the run that hangs, waits until that run is really visible as `running`, opens a
Terminal window of its own and records only that window while
`scripts/demo-play.mjs` drives the MCP server over stdio in the order below.
Afterwards it stops the instance, deletes the file holding the API key and
prints the path and length of the recording. The key is never on screen.

macOS has to allow screen recording for the app the script runs in
(System Settings > Privacy & Security > Screen & System Audio Recording).
Without it the script stops before recording and says so.

The section below is the content the script plays and the fallback for
recording by hand.

### What has to be ready before the recording starts

Do all of this before pressing record. None of it is on camera.

1. Build and start the throwaway instance:
   ```bash
   npm install && npm run build
   docker compose up -d
   ./scripts/demo-setup.sh
   ```
   The script prints the API key and the environment block. It seeds the live
   workflows and two exports, one of which was deliberately drifted and one
   whose workflow does not exist live. So `git_drift` has real findings without
   any staging during the recording.
2. Register the server in the MCP client you will record, with exactly the
   variables `demo-setup.sh` printed. Do not export the key in a shell you
   record: it would then sit in that window's history.
3. Start the run that hangs:
   ```bash
   ./scripts/demo-stuck-run.sh
   ```
   It starts one execution against a TCP sink that never answers, so the run
   sits in `running` for about an hour. Wait a minute after it, then
   `stuck_executions` reports it. If more than an hour passes before you record,
   run the script again.
4. Two windows only: the browser with the n8n UI, and the MCP client. Close
   everything else, hide notifications, and make sure no API key is readable on
   screen.

### Timeline

| Time | On screen | What is said or typed | What the viewer sees |
|---|---|---|---|
| 0:00 - 0:08 | n8n UI, Overview | nothing typed | Three workflows, no error banner, no warning. The instance looks healthy. |
| 0:08 - 0:16 | n8n UI, Executions list | nothing typed | A run sitting in `running`. It looks exactly like a healthy long job. Caption: "The UI cannot tell you this one is never coming back." |
| 0:16 - 0:24 | n8n UI, Settings, n8n API | nothing typed | Caption: "The Public API has no endpoint for database size, no baseline for a stuck run, and no idea what git holds." |
| 0:24 - 0:40 | MCP client | Call `stuck_executions` with `threshold_minutes: 1` | Summary lines: `1 of 1 running executions are stuck`, and the reason line naming both the threshold and the multiple of that workflow's own median. |
| 0:40 - 0:58 | MCP client | Call `git_drift` | `4 differences across 3 live and 2 exported workflows`, broken down into `content_drift`, `missing_in_git`, `missing_in_instance`, each with the file it came from. |
| 0:58 - 1:10 | MCP client | Call `guard_run` | All six checks complete: instance, datastore, db_health, retention, stuck_executions, git_drift. One call, one report. |
| 1:10 - 1:20 | Terminal, second window | `docker compose stop n8n` | The instance is now down. This is the incident, not a reason to stop monitoring. |
| 1:20 - 1:45 | MCP client | Call `guard_run` again | Header reads `## Guard run (degraded)`. Findings name `stuck_executions failed after 3 attempt(s)` and `git_drift failed after 2 attempt(s)`, then `4 of 6 checks completed despite the failures above`. Disk and retention answers are still there, read straight from the SQLite file. |
| 1:45 - 1:54 | MCP client, scrolled to the JSON payload | nothing typed | The per-step array: `attempts`, `durationMs`, `status` per step. The retries are in the payload, not in a slide. |
| 1:54 - 2:00 | Terminal or README | nothing typed | Closing card: `github.com/flow-84/n8n-guard`, "read-only, six checks, MIT". |

### Rules for the recording

- No intro, no talking head at the start, no logo animation. The first five
  seconds are the instance that looks fine while it is not.
- Say the numbers that are on screen, never a number that is not.
- If the stuck run finished early during the recording, redo the preparation
  step. Do not narrate a finding that is not visible.
- Total length must stay under 2:00. The table above adds up to 2:00 exactly, so
  cut the 0:16 caption first if you run over.

## 2. X post draft

The video goes into this post. There is no separate video field. `@nerdconf_ar`
has to be tagged in the post or in a comment underneath it.

**Main post:**

```
Self-hosted n8n does not fall over because of the things its API can show you.

It falls over on the SQLite file nobody watched, a run stuck in "running" that looks like a slow job, and workflows that quietly drifted away from the git exports.

n8n-guard is an MCP server for that layer. Six read-only checks, one sweep.

The part I care about: stop the n8n container mid-run and the sweep does not abort. The API checks retry, then become findings, while the disk and retention checks finish from the database file. Degraded, named, still useful.

Built for the Workflows track. Written with Claude.

github.com/flow-84/n8n-guard
```

**Comment underneath the post (carries the tag):**

```
Built at the Burning Token hackathon, Workflows track. @nerdconf_ar
```

**Short variant if the main post has to fit 280 characters:**

```
n8n-guard: an MCP server for the operational layer under the n8n Public API. Datastore size, executions stuck against their own baseline, retention, git drift. Read-only. Kill the API mid-sweep and the disk checks still finish.

github.com/flow-84/n8n-guard @nerdconf_ar
```

Checks before posting: the video is attached to the post itself, the tag is in
the post or the first comment, the repository is public, and every sentence
above matches what the video shows.

## 3. Submission form fields

Fields are the ones the platform lists as required: oneliner, what it is and for
whom, public project URL, X post with the demo video, challenges, evidence per
challenge, and which AI was used. Copy the blocks below into the form.

**Name**

```
n8n-guard
```

**Oneliner**

```
An MCP server for the operational layer underneath the n8n Public API: datastore size, stuck executions, retention and git drift.
```

**What it is and for whom**

```
n8n-guard is a read-only MCP server for people who run a self-hosted n8n instance and are on the hook when it stops working.

Every n8n MCP server on the registry today wraps the same Public API: list workflows, list executions, create, activate, delete. That is fine for building workflows and close to useless for keeping an instance alive, because the four things that actually take an instance down are not in that API.

n8n-guard answers them: how large the datastore is and how many days of headroom are left (it reads the SQLite file or queries Postgres directly, per table), which executions are stuck when judged against the median runtime of their own workflow rather than a flat timeout, what retention is costing and what a given window would free, and where the running instance has drifted from the workflow JSON in a git checkout.

Six tools: instance_info, db_health, stuck_executions, retention_report, git_drift, guard_run. Everything is configured through environment variables, so it runs against any instance with no hardcoded host, path or account. It never writes to the instance: no deletes, no activations, no edits. It reports, the operator decides.
```

**Public project URL**

```
https://github.com/flow-84/n8n-guard
```

Verified reachable without a login. If the npm publication lands before the
submission is sent, use `https://www.npmjs.com/package/n8n-guard` instead and
leave the repository in the GitHub field.

**X post**

```
<URL of the post from section 2, with the demo video attached>
```

**GitHub (optional)**

```
https://github.com/flow-84/n8n-guard
```

**Challenge**

```
Workflows - Render (render): build a background process that completes a task and recovers when a step fails.
```

**Evidence for that challenge**

```
Technology: Render Workflows. guard_run is deployed as the Render Workflow "n8n-guard" (workflow wfl-daj4mh95efls73fiv63g, version wfv-daj4mhh5efls73fiv6a0, built from main at cae91bc, region frankfurt).

Role: every guard check is its own Render task (instance, datastore, db_health, retention, stuck_executions, git_drift, plus flaky_probe). guard_run fans them out with ctx.run: four in parallel, db_health and retention after the datastore stats. Ordering, retries and backoff are declared in the task definitions in src/workflow/tasks.ts and executed by Render, not by our own runner. A task that exhausts its Render retries becomes a finding, the run still completes.

Recorded run: task run trn-09d4gdaj4nadg1s2s739dk3ng, started 2026-09-13T07:07:21Z, completed 2026-09-13T07:08:06Z, status completed. flaky_probe (trn-09d4gdaj4nb0a21bg00afql4g) failed three times on purpose and succeeded on attempt 4 after Render's 5s/10s/20s backoff. stuck_executions took 3 attempts and datastore and git_drift 2 each before Render gave up; the report came back degraded with "2 of 7 checks completed despite the failures above" instead of aborting. All checks are read-only, so no retry can duplicate an action.

Verify: in the Render dashboard open Workflows > n8n-guard > task runs, or, with a Render API key of the workflow owner as Bearer token (without it the API returns 401), GET https://api.render.com/v1/task-runs?rootTaskRunId=trn-09d4gdaj4nadg1s2s739dk3ng to see every subtask with its attempt history. Reproduce: npm run workflow:trigger -- --keep-days 30 --demo-retry 20 (docs/render-workflow.md).
```

**Which AI was used to build it**

```
Claude (Anthropic), driven through Claude Code. The work was split into issues on a self-hosted Multica board and executed by Claude agents: one planning the packages, one implementing each package on its own branch, one reviewing the pull requests. The design decisions, the scope cuts and the acceptance of every pull request were human.
```

## Open before submitting

- The npm package is not published yet, so `npx -y n8n-guard` in the README does
  not work at the time of writing. Either publish first or keep the GitHub
  repository as the public URL.
- No project exists on the hackathon platform for this submission yet, so the
  form cannot be filled in from here. Create it, then transfer the blocks above.
