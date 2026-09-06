/**
 * Every setting comes from the environment. n8n-guard never assumes a host,
 * container name, file path or account: it runs against whatever self-hosted
 * instance the operator points it at.
 */
export interface GuardConfig {
  /** Base URL of the n8n instance, e.g. http://localhost:5678 */
  n8nUrl: string;
  /** Public API key (Settings -> n8n API). Optional: without it API checks degrade. */
  n8nApiKey: string | undefined;
  /** Absolute path to database.sqlite when n8n runs on SQLite. */
  sqlitePath: string | undefined;
  /** Postgres connection string when n8n runs on Postgres. */
  postgresUrl: string | undefined;
  /** Path to a git checkout holding exported workflow JSON. */
  gitRepoPath: string | undefined;
  /** An execution running longer than this is reported as stuck. */
  stuckThresholdMinutes: number;
  /** Warn when the n8n datastore grows past this size. */
  dbWarnBytes: number;
  /** Treat the datastore as critical past this size. */
  dbCriticalBytes: number;
  /** Per-request timeout for the n8n API, in milliseconds. */
  requestTimeoutMs: number;
}

export class ConfigError extends Error {}

function num(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function trimmed(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const n8nUrl = trimmed(env.N8N_URL) ?? "http://localhost:5678";
  try {
    new URL(n8nUrl);
  } catch {
    throw new ConfigError(`N8N_URL is not a valid URL: ${JSON.stringify(n8nUrl)}`);
  }

  return {
    n8nUrl: n8nUrl.replace(/\/+$/, ""),
    n8nApiKey: trimmed(env.N8N_API_KEY),
    sqlitePath: trimmed(env.N8N_SQLITE_PATH),
    postgresUrl: trimmed(env.N8N_POSTGRES_URL),
    gitRepoPath: trimmed(env.N8N_GIT_REPO_PATH),
    stuckThresholdMinutes: num(env.N8N_GUARD_STUCK_MINUTES, 15, "N8N_GUARD_STUCK_MINUTES"),
    dbWarnBytes: num(env.N8N_GUARD_DB_WARN_BYTES, 1024 ** 3, "N8N_GUARD_DB_WARN_BYTES"),
    dbCriticalBytes: num(env.N8N_GUARD_DB_CRITICAL_BYTES, 4 * 1024 ** 3, "N8N_GUARD_DB_CRITICAL_BYTES"),
    requestTimeoutMs: num(env.N8N_GUARD_TIMEOUT_MS, 15_000, "N8N_GUARD_TIMEOUT_MS"),
  };
}
