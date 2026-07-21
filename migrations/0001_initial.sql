PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_datasets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'ARCHIVED', 'REJECTED')),
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  earliest_date TEXT,
  latest_date TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, revision),
  UNIQUE (user_id, file_hash)
);

CREATE TABLE IF NOT EXISTS portfolio_state (
  user_id TEXT PRIMARY KEY,
  active_dataset_id TEXT,
  cloud_revision INTEGER NOT NULL DEFAULT 0 CHECK (cloud_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (active_dataset_id) REFERENCES portfolio_datasets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
  trade_date TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('SECURITY', 'FX_BUY', 'FX_SELL', 'CASH_IN', 'CASH_OUT')),
  ticker TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  amount_foreign REAL NOT NULL DEFAULT 0,
  fx_rate REAL,
  fee REAL NOT NULL DEFAULT 0,
  budget_waterline REAL,
  budget_balance REAL,
  note TEXT NOT NULL DEFAULT '',
  row_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dataset_id) REFERENCES portfolio_datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (dataset_id, source_row_number),
  UNIQUE (dataset_id, row_hash)
);

CREATE TABLE IF NOT EXISTS portfolio_settings (
  user_id TEXT PRIMARY KEY,
  base_currency TEXT NOT NULL DEFAULT 'TWD',
  benchmark TEXT NOT NULL DEFAULT 'SPY',
  accounting_mode TEXT NOT NULL DEFAULT 'ACTUAL_INVESTED',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_dataset_per_user
  ON portfolio_datasets(user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_datasets_user_status
  ON portfolio_datasets(user_id, status, revision DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_dataset_date
  ON transactions(dataset_id, trade_date, source_row_number);
CREATE INDEX IF NOT EXISTS idx_transactions_user_ticker
  ON transactions(user_id, ticker, trade_date);
