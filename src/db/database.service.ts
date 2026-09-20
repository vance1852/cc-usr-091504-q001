import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';

export const DB_FILE = 'DB_FILE';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff','approver'))
);

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  current_version_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venue_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  version INTEGER NOT NULL,
  fire_capacity INTEGER NOT NULL,
  wheelchair_accessible INTEGER NOT NULL,
  accessibility_note TEXT NOT NULL DEFAULT '',
  fixed_equipment TEXT NOT NULL DEFAULT '[]',
  weekly_availability TEXT NOT NULL DEFAULT '[]',
  clearing_minutes INTEGER NOT NULL,
  change_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (venue_id, version)
);

CREATE TABLE IF NOT EXISTS venue_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  expected_attendees INTEGER NOT NULL,
  requires_wheelchair INTEGER NOT NULL DEFAULT 0,
  required_equipment TEXT NOT NULL DEFAULT '[]',
  special_access_note TEXT,
  audience_groups TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  venue_version_id INTEGER NOT NULL REFERENCES venue_versions(id),
  venue_snapshot TEXT NOT NULL,
  venue_name TEXT NOT NULL DEFAULT '',
  clearing_minutes INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('pending_approval','held','confirmed','rejected','cancelled')),
  conflict_report TEXT,
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  replacement_of TEXT,
  UNIQUE (venue_id, start_at, activity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idem
  ON bookings(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_venue_time
  ON bookings(venue_id, start_at, end_at, status);

CREATE TABLE IF NOT EXISTS booking_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  type TEXT NOT NULL CHECK (type IN ('fire_capacity','special_access')),
  approver_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (booking_id, type)
);

CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  predecessor_booking_id TEXT NOT NULL REFERENCES bookings(id),
  successor_booking_id TEXT NOT NULL REFERENCES bookings(id),
  predecessor_confirmed_by TEXT,
  predecessor_confirmed_at TEXT,
  successor_confirmed_by TEXT,
  successor_confirmed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','voided')),
  created_at TEXT NOT NULL,
  UNIQUE (predecessor_booking_id, successor_booking_id)
);

CREATE TABLE IF NOT EXISTS cleanup_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  due_at TEXT NOT NULL,
  clear_by_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','done')),
  assignee_group TEXT NOT NULL,
  done_by TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT,
  venue_id TEXT NOT NULL,
  person_id TEXT,
  audience_group TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_venue ON notifications(venue_id, status);

CREATE TABLE IF NOT EXISTS closure_impacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  closure_id INTEGER NOT NULL REFERENCES venue_closures(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('immovable','alternatives_ready','no_alternative')),
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  closure_id INTEGER NOT NULL REFERENCES venue_closures(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  venue_version_id INTEGER NOT NULL REFERENCES venue_versions(id),
  requires_approval TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','void')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
`;

/** 数据库行的通用形状（SQLite 返回 null 原型对象） */
export type Row = Record<string, unknown>;

@Injectable()
export class DatabaseService implements OnModuleInit {
  private db!: DatabaseSync;

  constructor(@Inject(DB_FILE) private readonly file: string) {}

  onModuleInit(): void {
    this.open();
  }

  open(): void {
    if (this.db) return;
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  run(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).run(...(params as never[]));
  }

  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** 执行 INSERT 并返回自增主键 */
  insert(sql: string, ...params: unknown[]): number {
    const res = this.db
      .prepare(sql)
      .run(...(params as never[])) as unknown as { lastInsertRowid: number | bigint };
    return Number(res.lastInsertRowid);
  }

  /** 在单个 SQLite 事务中执行工作，抛错自动回滚 */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
