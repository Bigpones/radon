-- 0009_gamma_rotation_gap.sql
-- Stores SPY/TLT Gamma Rotation Gap snapshots as a Turso-backed regime feed.

CREATE TABLE IF NOT EXISTS gamma_rotation_snapshots (
  scan_time TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (9, datetime('now'));
