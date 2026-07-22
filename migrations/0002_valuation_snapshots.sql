PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS valuation_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'ARCHIVED', 'REJECTED')),
  valuation_date TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  mark_count INTEGER NOT NULL CHECK (mark_count > 0),
  earliest_mark_date TEXT,
  latest_mark_date TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, revision),
  UNIQUE (user_id, file_hash)
);

CREATE TABLE IF NOT EXISTS valuation_state (
  user_id TEXT PRIMARY KEY,
  active_snapshot_id TEXT,
  valuation_revision INTEGER NOT NULL DEFAULT 0 CHECK (valuation_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (active_snapshot_id) REFERENCES valuation_snapshots(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS valuation_marks (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
  mark_date TEXT NOT NULL,
  mark_type TEXT NOT NULL CHECK (mark_type IN ('PRICE', 'FX')),
  ticker TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  value REAL NOT NULL CHECK (value > 0),
  source TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  row_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (snapshot_id) REFERENCES valuation_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (snapshot_id, source_row_number),
  UNIQUE (snapshot_id, row_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_valuation_per_user
  ON valuation_snapshots(user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_valuation_snapshots_user_status
  ON valuation_snapshots(user_id, status, revision DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_marks_snapshot_date
  ON valuation_marks(snapshot_id, mark_date, source_row_number);
CREATE INDEX IF NOT EXISTS idx_valuation_marks_user_key
  ON valuation_marks(user_id, mark_type, ticker, currency, mark_date);
