PRAGMA foreign_keys = OFF;

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

INSERT INTO valuation_snapshots_new (
  id, user_id, revision, status, valuation_date, filename, file_hash,
  parser_version, mark_count, earliest_mark_date, latest_mark_date,
  validation_json, created_at, activated_at
)
SELECT
  id, user_id, revision, status, valuation_date, filename, file_hash,
  parser_version, mark_count, earliest_mark_date, latest_mark_date,
  validation_json, created_at, activated_at
FROM valuation_snapshots;

DROP TABLE valuation_snapshots;
ALTER TABLE valuation_snapshots_new RENAME TO valuation_snapshots;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_valuation_per_user
  ON valuation_snapshots(user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_valuation_snapshots_user_status
  ON valuation_snapshots(user_id, status, revision DESC);

PRAGMA foreign_keys = ON;
