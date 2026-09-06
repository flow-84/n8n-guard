# Submission material

Everything needed to record the demo video, publish the announcement and fill in
the submission form. Every claim below is backed by the code in this repository
as of the commit this file ships with. Nothing here describes planned work.

## 1. Demo video script (screen recording, 2:00 maximum)

### What has to be ready before the recording starts

Do all of this before pressing record. None of it is on camera.

1. Build and start the throwaway instance:
   ```bash
   npm install && npm run build
   docker compose up -d
   ./scripts/demo-setup.sh
   ```
   The script prints the API key and the environment block. It seeds two live
   workflows (`In sync`, `Never exported`) and two exports, one of which was
   deliberately drifted and one whose workflow does not exist live. So
   `git_drift` has three real findings without any staging during the recording.
2. Put the configuration into the MCP client, not into a shell. Paste the values
   `demo-setup.sh` printed into the client config (Claude Desktop:
   `~/Library/Application Support/Claude/claude_desktop_config.json`) and restart
   the client:
   ```json
   {
     "mcpServers": {
       "n8n-guard": {
         "command": "node",
         "args": ["/absolute/path/to/n8n-guard/dist/index.js"],
         "env": {
           "N8N_URL": "http://localhost:5678",
           "N8N_API_KEY": "<the key demo-setup.sh printed>",
           "N8N_SQLITE_PATH": "/absolute/path/to/n8n-guard/.n8n-demo/database.sqlite",
           "N8N_GIT_REPO_PATH": "/absolute/path/to/n8n-guard/.n8n-demo-exports"
         }
       }
     }
   }
   ```
   The client reads the key from that file, so the key never has to be typed in a
   terminal and cannot end up on screen. Confirm it works by calling
   `instance_info` once before recording: it must answer `reachable`.
3. Produce a baseline and a genuinely stuck run:
   - In the n8n UI, execute `Never exported` three times. Those finished runs are
     what the median baseline is derived from.
   - Then edit its HTTP Request node: URL `http://10.255.255.1/hang` (an
     unroutable address, so the request never answers) and set the node option
     Timeout to `3600000` ms. Save, execute manually once, leave it running.
   - Wait about three minutes before recording. The run then sits in `running`
     far past its own median, which is what `stuck_executions` is built to catch.
4. Prepare exactly the three surfaces that get recorded, and nothing else:
   - **Browser** with the n8n UI, on the Overview page.
   - **MCP client** with the n8n-guard server connected.
   - **One terminal window** for the single command at 1:10. Open a new window,
     run `cd /path/to/n8n-guard`, then `clear`. That window is now empty, holds
     no API key and shows no earlier commands. Do not reuse the window that ran
     `demo-setup.sh`: its scrollback and its history contain the key.
   Then hide notifications, close every other window, and check the n8n UI itself
   for the key: Settings, n8n API shows the key label only, never the value.

### Timeline

| Time | On screen | What is said or typed | What the viewer sees |
|---|---|---|---|
| 0:00 - 0:08 | n8n UI, Overview | nothing typed | Two workflows, no error banner, no warning. The instance looks healthy. |
| 0:08 - 0:16 | n8n UI, Executions list | nothing typed | A run sitting in `running`. It looks exactly like a healthy long job. Caption: "The UI cannot tell you this one is never coming back." |
| 0:16 - 0:24 | n8n UI, Settings, n8n API | nothing typed | Caption: "The Public API has no endpoint for database size, no baseline for a stuck run, and no idea what git holds." |
| 0:24 - 0:40 | MCP client | Call `stuck_executions` with `threshold_minutes: 1` | Summary lines: `1 of 1 running executions are stuck`, and the reason line naming both the threshold and the multiple of that workflow's own median. |
| 0:40 - 0:58 | MCP client | Call `git_drift` | `3 differences across 2 live and 2 exported workflows`, broken down into `content_drift`, `missing_in_git`, `missing_in_instance`, each with the file it came from. |
| 0:58 - 1:10 | MCP client | Call `guard_run` | All six checks complete: instance, datastore, db_health, retention, stuck_executions, git_drift. One call, one report. |
| 1:10 - 1:20 | The prepared empty terminal | `docker compose stop n8n` | The instance is now down. This is the incident, not a reason to stop monitoring. |
| 1:20 - 1:45 | MCP client | Call `guard_run` again | Header reads `## Guard run (degraded)`. Findings name `stuck_executions failed after 3 attempt(s)` and `git_drift failed after 2 attempt(s)`, then `4 of 6 checks completed despite the failures above`. Disk and retention answers are still there, read straight from the SQLite file. |
| 1:45 - 1:54 | MCP client, scrolled to the JSON payload | nothing typed | The per-step array: `attempts`, `durationMs`, `status` per step. The retries are in the payload, not in a slide. |
| 1:54 - 2:00 | Same terminal or the README | nothing typed | Closing card: `github.com/flow-84/n8n-guard`, "read-only, six checks, MIT". |

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
guard_run is the background process. It runs six checks in one sweep and is built so that a failing step does not end the run.

How it recovers, in the code: src/guard/runner.ts runs every step in isolation. A step declares its own retry count and is retried with backoff. If it still fails, the error is turned into a finding and the sweep continues with the next step. A step that declares a dependency on a step that did not succeed is skipped with the reason attached instead of crashing on missing input. The report carries per-step status, attempt count and duration, and is flagged degraded whenever anything failed or was skipped.

What that looks like when the n8n API is gone: instance, datastore, db_health and retention still complete out of the datastore file, stuck_executions fails after 3 attempts, git_drift fails after 2, and the report says "4 of 6 checks completed despite the failures above" rather than returning nothing.

Proof that runs without our instance: test/unit/serviceRecovery.test.ts builds a real n8n-shaped SQLite database in a temp directory and points the API at 127.0.0.1:9, a port that reliably refuses connections. It asserts that the datastore, db_health and retention steps come back ok, that the API-backed steps are reported as failed after their retries, and that the failures appear in the findings instead of being swallowed. test/unit/runner.test.ts covers the step engine itself, including skip on failed dependency.

Reproduce: npm install && npm test. 56 unit tests across 7 files, all passing on Node 22 or newer.

In the demo video: 1:10 stops the n8n container, 1:20 shows the same guard_run coming back degraded with the numbers above.
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
