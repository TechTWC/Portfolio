PRAGMA foreign_keys = ON;

-- A physical row ID identifies one copy inside one dataset. transaction_id is
-- the logical identity that survives safe corrections across revisions.
ALTER TABLE transactions ADD COLUMN transaction_id TEXT;
UPDATE transactions
SET transaction_id = (
  SELECT earliest.id
  FROM transactions earliest
  JOIN portfolio_datasets earliest_dataset ON earliest_dataset.id = earliest.dataset_id
  WHERE earliest.user_id = transactions.user_id
    AND earliest.row_hash = transactions.row_hash
  ORDER BY earliest_dataset.revision, earliest.id
  LIMIT 1
)
WHERE transaction_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dataset_transaction_id
  ON transactions(dataset_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_transaction_id
  ON transactions(user_id, transaction_id, trade_date);

CREATE TRIGGER IF NOT EXISTS trg_transactions_require_transaction_id
BEFORE INSERT ON transactions
WHEN NEW.transaction_id IS NULL OR length(trim(NEW.transaction_id)) = 0
BEGIN
  SELECT RAISE(ABORT, 'transaction_id is required');
END;

-- Rebuild the valuation relationship so every new snapshot records the exact
-- transaction dataset used to calculate it. Existing snapshots are bound to
-- the ACTIVE dataset used by the old application at migration time, which
-- preserves their pre-migration output from this point forward.
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
  transaction_dataset_id TEXT,
  transaction_revision INTEGER CHECK (transaction_revision > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_dataset_id) REFERENCES portfolio_datasets(id) ON DELETE RESTRICT,
  UNIQUE (user_id, revision),
  UNIQUE (user_id, file_hash, parser_version, transaction_dataset_id)
);

INSERT INTO valuation_snapshots_new (
  id, user_id, revision, status, valuation_date, filename, file_hash,
  parser_version, mark_count, earliest_mark_date, latest_mark_date,
  validation_json, transaction_dataset_id, transaction_revision,
  created_at, activated_at
)
SELECT
  snapshot.id,
  snapshot.user_id,
  snapshot.revision,
  snapshot.status,
  snapshot.valuation_date,
  snapshot.filename,
  snapshot.file_hash,
  snapshot.parser_version,
  snapshot.mark_count,
  snapshot.earliest_mark_date,
  snapshot.latest_mark_date,
  snapshot.validation_json,
  state.active_dataset_id,
  dataset.revision,
  snapshot.created_at,
  snapshot.activated_at
FROM valuation_snapshots snapshot
LEFT JOIN portfolio_state state ON state.user_id = snapshot.user_id
LEFT JOIN portfolio_datasets dataset ON dataset.id = state.active_dataset_id;

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
CREATE INDEX IF NOT EXISTS idx_valuation_snapshots_transaction_dataset
  ON valuation_snapshots(user_id, transaction_dataset_id, transaction_revision);
CREATE INDEX IF NOT EXISTS idx_valuation_marks_snapshot_date
  ON valuation_marks(snapshot_id, mark_date, source_row_number);
CREATE INDEX IF NOT EXISTS idx_valuation_marks_user_key
  ON valuation_marks(user_id, mark_type, ticker, currency, mark_date);

CREATE TRIGGER IF NOT EXISTS trg_valuation_snapshots_require_transaction_lineage
BEFORE INSERT ON valuation_snapshots
WHEN NEW.transaction_dataset_id IS NULL
  OR NEW.transaction_revision IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM portfolio_datasets dataset
    WHERE dataset.id = NEW.transaction_dataset_id
      AND dataset.user_id = NEW.user_id
      AND dataset.revision = NEW.transaction_revision
  )
BEGIN
  SELECT RAISE(ABORT, 'valid transaction lineage is required');
END;
