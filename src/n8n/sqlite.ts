import { createRequire } from "node:module";

/**
 * `node:sqlite` is a Node builtin, but bundlers still try to resolve it from
 * node_modules and fail. Going through createRequire hands it to Node directly.
 */
const nodeRequire = createRequire(import.meta.url);

export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export function openSqlite(path: string, options: { readOnly?: boolean } = {}): SqliteDatabase {
  let DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  try {
    ({ DatabaseSync } = nodeRequire("node:sqlite"));
  } catch {
    throw new Error("node:sqlite is unavailable; n8n-guard needs Node.js 22 or newer for SQLite support");
  }
  return new DatabaseSync(path, options);
}
