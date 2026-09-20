/**
 * SQLite 驱动适配层。
 *
 * 使用 Node 22 内置的 node:sqlite（DatabaseSync），无需原生编译即可获得
 * 真正的 SQLite 持久化。接口与 better-sqlite3 的最小子集对齐，便于替换。
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function openDatabase(path: string): SqliteConnection {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path);
}

/** 判断是否为 SQLite UNIQUE 约束冲突（用于幂等键并发回读） */
export function isUniqueViolation(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? '');
  return /UNIQUE constraint failed/.test(msg);
}
