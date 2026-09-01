PRAGMA foreign_keys = ON;

-- Append-only operational audit for Cloudflare Cron refreshes. It stores no
-- prices, transaction rows, OAuth tokens or secrets.
CREATE TABLE IF NOT EXISTS market_refresh_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('SCHEDULED')),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  market_revision_before INTEGER NOT NULL DEFAULT 0 CHECK (market_revision_before >= 0),
  market_revision_after INTEGER CHECK (market_revision_after >= 0),
  valuation_revision_before INTEGER NOT NULL DEFAULT 0 CHECK (valuation_revision_before >= 0),
  valuation_revision_after INTEGER CHECK (valuation_revision_after >= 0),
  latest_bar_date TEXT,
  reason_code TEXT,
  reason_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_market_refresh_jobs_user_scheduled
  ON market_refresh_jobs(user_id, scheduled_for DESC);
