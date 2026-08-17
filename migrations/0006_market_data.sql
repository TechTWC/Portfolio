PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_data_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'ARCHIVED', 'FAILED')),
  provider TEXT NOT NULL,
  data_version TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL DEFAULT 'SPY',
  transaction_dataset_id TEXT NOT NULL,
  transaction_revision INTEGER NOT NULL CHECK (transaction_revision > 0),
  instrument_count INTEGER NOT NULL CHECK (instrument_count > 0),
  bar_count INTEGER NOT NULL CHECK (bar_count > 0),
  earliest_bar_date TEXT,
  latest_bar_date TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_dataset_id) REFERENCES portfolio_datasets(id) ON DELETE RESTRICT,
  UNIQUE (user_id, revision)
);

CREATE TABLE IF NOT EXISTS market_state (
  user_id TEXT PRIMARY KEY,
  active_run_id TEXT,
  market_revision INTEGER NOT NULL DEFAULT 0 CHECK (market_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (active_run_id) REFERENCES market_data_runs(id) ON DELETE SET NULL
);

-- A refresh inserts and removes one guard inside the same D1 batch that publishes
-- market data (and, when required, its matching valuation).  The NOT NULL proof
-- deliberately aborts the transaction when any optimistic-version predicate is
-- false, so no half-published ACTIVE state can escape the batch.
CREATE TABLE IF NOT EXISTS activation_guards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  proof INTEGER NOT NULL CHECK (proof = 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO market_state (user_id, market_revision)
SELECT id, 0 FROM users
;

CREATE TABLE IF NOT EXISTS market_data_instruments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('SECURITY', 'FX', 'BENCHMARK')),
  ticker TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  exchange_timezone TEXT NOT NULL,
  bar_count INTEGER NOT NULL CHECK (bar_count > 0),
  earliest_bar_date TEXT NOT NULL,
  latest_bar_date TEXT NOT NULL,
  latest_raw_close REAL NOT NULL CHECK (latest_raw_close > 0),
  series_hash TEXT NOT NULL,
  bars_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES market_data_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (run_id, instrument_type, ticker, currency)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_market_run_per_user
  ON market_data_runs(user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_market_runs_user_revision
  ON market_data_runs(user_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_market_instruments_user_run
  ON market_data_instruments(user_id, run_id, instrument_type, ticker, currency);
