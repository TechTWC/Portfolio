PRAGMA foreign_keys = ON;

-- MCP business tools are read-only. This append-only table stores only
-- invocation metadata required for traceability; it never stores tool payloads,
-- tokens, secrets, or transaction rows.
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  authenticated_email TEXT NOT NULL,
  tool TEXT NOT NULL,
  target TEXT,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  returned_row_count INTEGER NOT NULL CHECK (returned_row_count >= 0),
  error_code TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_user_timestamp
  ON mcp_audit_log(user_id, timestamp DESC);
