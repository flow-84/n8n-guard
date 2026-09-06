import { stat } from "node:fs/promises";
import path from "node:path";
import type { GuardConfig } from "../config.js";
import { openSqlite } from "./sqlite.js";

export type DatastoreKind = "sqlite" | "postgres";

export interface TableStat {
  table: string;
  rows: number;
  /** Bytes on disk. `null` when the engine cannot report it (SQLite without the dbstat module). */
  bytes: number | null;
}

export interface DatastoreStats {
  kind: DatastoreKind;
  /** Total size of the n8n datastore in bytes. */
  totalBytes: number;
  /** Extra files counted into `totalBytes` (SQLite WAL/SHM), for transparency. */
  components: { name: string; bytes: number }[];
  tables: TableStat[];
  executionCount: number;
  oldestExecutionAt: string | null;
  newestExecutionAt: string | null;
  /** Execution rows grouped by age bucket, for retention decisions. */
  executionsOlderThanDays: Record<string, number>;
}

export class DatastoreError extends Error {}

/** Tables worth measuring. Missing ones are skipped, n8n schemas differ across versions. */
const INTERESTING_TABLES = [
  "execution_entity",
  "execution_data",
  "execution_metadata",
  "execution_annotation",
  "workflow_entity",
  "workflow_history",
  "credentials_entity",
  "webhook_entity",
  "insights_raw",
];

export const RETENTION_BUCKETS = [7, 30, 90, 365];

export function resolveDatastoreKind(config: GuardConfig): DatastoreKind {
  if (config.postgresUrl) return "postgres";
  if (config.sqlitePath) return "sqlite";
  throw new DatastoreError(
    "no datastore configured: set N8N_SQLITE_PATH (SQLite) or N8N_POSTGRES_URL (Postgres)",
  );
}

export async function readDatastoreStats(config: GuardConfig): Promise<DatastoreStats> {
  return resolveDatastoreKind(config) === "postgres"
    ? readPostgresStats(config.postgresUrl!)
    : readSqliteStats(config.sqlitePath!);
}

function bucketCutoffs(now = Date.now()): { days: number; iso: string; epochMs: number }[] {
  return RETENTION_BUCKETS.map((days) => {
    const epochMs = now - days * 86_400_000;
    return { days, iso: new Date(epochMs).toISOString(), epochMs };
  });
}

async function readSqliteStats(sqlitePath: string): Promise<DatastoreStats> {
  let main: number;
  try {
    main = (await stat(sqlitePath)).size;
  } catch (error) {
    throw new DatastoreError(`cannot read ${sqlitePath}: ${(error as Error).message}`);
  }

  const components = [{ name: path.basename(sqlitePath), bytes: main }];
  for (const suffix of ["-wal", "-shm"]) {
    const size = await stat(sqlitePath + suffix).then((s) => s.size).catch(() => null);
    if (size !== null) components.push({ name: path.basename(sqlitePath) + suffix, bytes: size });
  }

  const db = openSqlite(sqlitePath, { readOnly: true });
  try {
    const present = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)),
    );

    // dbstat is an optional SQLite module; without it we still report row counts.
    let perTableBytes: Map<string, number> | null = null;
    try {
      const rows = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all();
      perTableBytes = new Map(rows.map((r) => [String(r.name), Number(r.bytes)]));
    } catch {
      perTableBytes = null;
    }

    const tables: TableStat[] = [];
    for (const table of INTERESTING_TABLES) {
      if (!present.has(table)) continue;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number } | undefined;
      tables.push({ table, rows: Number(row?.n ?? 0), bytes: perTableBytes?.get(table) ?? null });
    }

    let executionCount = 0;
    let oldestExecutionAt: string | null = null;
    let newestExecutionAt: string | null = null;
    const executionsOlderThanDays: Record<string, number> = {};

    if (present.has("execution_entity")) {
      const agg = db
        .prepare(`SELECT COUNT(*) AS n, MIN("startedAt") AS oldest, MAX("startedAt") AS newest FROM execution_entity`)
        .get() as { n: number; oldest: string | null; newest: string | null } | undefined;
      executionCount = Number(agg?.n ?? 0);
      oldestExecutionAt = normalizeTimestamp(agg?.oldest ?? null);
      newestExecutionAt = normalizeTimestamp(agg?.newest ?? null);

      // n8n has stored startedAt as ISO text and as epoch millis across versions.
      // SQLite sorts every integer before every string, so a text-only comparison
      // would count all numeric rows as older than any cutoff.
      const counter = db.prepare(`
        SELECT COUNT(*) AS n FROM execution_entity
        WHERE CASE typeof("startedAt")
          WHEN 'integer' THEN "startedAt" < ?
          WHEN 'real' THEN "startedAt" < ?
          ELSE "startedAt" < ?
        END`);
      for (const { days, iso, epochMs } of bucketCutoffs()) {
        const hit = counter.get(epochMs, epochMs, iso) as { n: number } | undefined;
        executionsOlderThanDays[String(days)] = Number(hit?.n ?? 0);
      }
    }

    return {
      kind: "sqlite",
      totalBytes: components.reduce((sum, c) => sum + c.bytes, 0),
      components,
      tables,
      executionCount,
      oldestExecutionAt,
      newestExecutionAt,
      executionsOlderThanDays,
    };
  } finally {
    db.close();
  }
}

async function readPostgresStats(connectionString: string): Promise<DatastoreStats> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
  } catch (error) {
    throw new DatastoreError(`cannot connect to Postgres: ${(error as Error).message}`);
  }

  try {
    const total = await client.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
    const present = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()",
    );
    const names = new Set(present.rows.map((r) => r.tablename));

    const tables: TableStat[] = [];
    for (const table of INTERESTING_TABLES) {
      if (!names.has(table)) continue;
      const result = await client.query<{ rows: string; bytes: string }>(
        `SELECT (SELECT COUNT(*) FROM "${table}")::text AS rows, pg_total_relation_size($1)::text AS bytes`,
        [table],
      );
      const row = result.rows[0];
      tables.push({ table, rows: Number(row?.rows ?? 0), bytes: Number(row?.bytes ?? 0) });
    }

    let executionCount = 0;
    let oldestExecutionAt: string | null = null;
    let newestExecutionAt: string | null = null;
    const executionsOlderThanDays: Record<string, number> = {};

    if (names.has("execution_entity")) {
      const agg = await client.query<{ n: string; oldest: Date | null; newest: Date | null }>(
        `SELECT COUNT(*)::text AS n, MIN("startedAt") AS oldest, MAX("startedAt") AS newest FROM execution_entity`,
      );
      const row = agg.rows[0];
      executionCount = Number(row?.n ?? 0);
      oldestExecutionAt = row?.oldest ? new Date(row.oldest).toISOString() : null;
      newestExecutionAt = row?.newest ? new Date(row.newest).toISOString() : null;

      for (const { days, iso } of bucketCutoffs()) {
        const hit = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM execution_entity WHERE "startedAt" < $1`,
          [iso],
        );
        executionsOlderThanDays[String(days)] = Number(hit.rows[0]?.n ?? 0);
      }
    }

    return {
      kind: "postgres",
      totalBytes: Number(total.rows[0]?.bytes ?? 0),
      components: [{ name: "database", bytes: Number(total.rows[0]?.bytes ?? 0) }],
      tables,
      executionCount,
      oldestExecutionAt,
      newestExecutionAt,
      executionsOlderThanDays,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** SQLite stores timestamps as text or epoch millis depending on the n8n version. */
function normalizeTimestamp(value: string | number | null): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
