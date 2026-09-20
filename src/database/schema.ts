export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  accessible INTEGER NOT NULL,
  equipment TEXT NOT NULL,          -- JSON array
  windows TEXT NOT NULL,            -- JSON array of TimeWindow
  turnover_minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 场地版本快照：每次影响活动安排的变更都留下完整快照，作为确认依据可查
CREATE TABLE IF NOT EXISTS venue_versions (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,           -- JSON：该版本场地完整属性
  change_reason TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE (venue_id, version)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_name TEXT,
  title TEXT NOT NULL,
  attendees INTEGER NOT NULL,
  requires_accessible INTEGER NOT NULL,
  required_equipment TEXT NOT NULL, -- JSON array
  audience_groups TEXT NOT NULL,    -- JSON array
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_version INTEGER,            -- 确认时所依据的场地版本
  status TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 幂等：同一负责人同一 Idempotency-Key 只会产生一条预约，重复请求不会双重占用
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idem
  ON bookings (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_venue_time ON bookings (venue_id, start, end);

CREATE TABLE IF NOT EXISTS booking_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,            -- JSON
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_booking ON booking_events (booking_id);

CREATE TABLE IF NOT EXISTS handovers (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  out_booking_id TEXT NOT NULL,
  in_booking_id TEXT NOT NULL,
  cleanup_items TEXT NOT NULL,      -- JSON array of CleanupItem
  out_confirmed_by TEXT,
  out_confirmed_at TEXT,
  in_confirmed_by TEXT,
  in_confirmed_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (out_booking_id, in_booking_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  type TEXT NOT NULL,               -- FIRE_CAPACITY | SPECIAL_ACCESS
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closures (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  from_ts TEXT NOT NULL,
  to_ts TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closure_impacts (
  id TEXT PRIMARY KEY,
  closure_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- RELOCATED | UNABLE | MANUAL_REQUIRED
  to_venue_id TEXT,
  reasons TEXT NOT NULL,            -- JSON array
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  audience_group TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_booking ON notifications (booking_id);
`;
