/**
 * Trigger one guard_run on Render and print the run's outcome.
 *
 * Usage:
 *   RENDER_API_KEY=... N8N_GUARD_WORKFLOW_SLUG=<workflow-slug> \
 *     npm run workflow:trigger -- [--keep-days 30] [--demo-retry 20]
 *
 * `--demo-retry <seconds>` makes the run start with the flaky_probe task, which
 * fails until that many seconds have passed. The retries are Render's, so the
 * attempts show up in the task's run history.
 */
import { Render } from "@renderinc/sdk";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const token = process.env.RENDER_API_KEY;
  if (!token) throw new Error("RENDER_API_KEY is not set");
  const slug = process.env.N8N_GUARD_WORKFLOW_SLUG;
  if (!slug) throw new Error("N8N_GUARD_WORKFLOW_SLUG is not set (the workflow's slug in Render)");

  const input: Record<string, number> = {};
  const keepDays = flag("keep-days");
  if (keepDays) input.keepDays = Number(keepDays);
  const demoRetry = flag("demo-retry");
  if (demoRetry) input.demoRetrySeconds = Number(demoRetry);

  const client = new Render({ token });
  const started = await client.workflows.startTask(`${slug}/guard_run`, [input]);
  console.log(`task run: ${started.taskRunId}`);

  const details = await started.get();
  console.log(JSON.stringify(details, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
