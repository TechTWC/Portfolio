-- Forward migration for deployments that already recorded the original 0003.
-- Rebuild every table in the relationship so D1 never applies cascade actions.
CREATE TABLE valuation_state_backup AS SELECT * FROM valuation_state;
CREATE TABLE valuation_marks_backup AS SELECT * FROM valuation_marks;

DROP TABLE valuation_marks;
DROP TABLE valuation_state;

CREATE TABLE valuation_snapshots_new (
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
  UNIQUE (user_id, file_hash, parser_version)
);

INSERT INTO valuation_snapshots_new SELECT * FROM valuation_snapshots;
DROP TABLE valuation_snapshots;
ALTER TABLE valuation_snapshots_new RENAME TO valuation_snapshots;

CREATE TABLE valuation_state (
  user_id TEXT PRIMARY KEY,
  active_snapshot_id TEXT,
  valuation_revision INTEGER NOT NULL DEFAULT 0 CHECK (valuation_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (active_snapshot_id) REFERENCES valuation_snapshots(id) ON DELETE SET NULL
);

CREATE TABLE valuation_marks (
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

INSERT INTO valuation_state SELECT * FROM valuation_state_backup;
INSERT INTO valuation_marks SELECT * FROM valuation_marks_backup;
DROP TABLE valuation_state_backup;
DROP TABLE valuation_marks_backup;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_valuation_per_user
  ON valuation_snapshots(user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_valuation_snapshots_user_status
  ON valuation_snapshots(user_id, status, revision DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_marks_snapshot_date
  ON valuation_marks(snapshot_id, mark_date, source_row_number);
CREATE INDEX IF NOT EXISTS idx_valuation_marks_user_key
  ON valuation_marks(user_id, mark_type, ticker, currency, mark_date);
