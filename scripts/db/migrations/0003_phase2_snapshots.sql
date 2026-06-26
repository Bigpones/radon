-- 0003_phase2_snapshots.sql
-- Phase 2 of the Turso source-of-truth migration. Adds tables for the
-- 5 JSON-only files that had no DB equivalent before this commit:
--   - scanner_snapshots       (scanner.json)
--   - flow_analysis_snapshots (flow_analysis.json)
--   - performance_snapshots   (performance.json)
--   - nav_history             (nav_history_ib.json)
--   - twr_history             (ib_twr_series.json)
--   - option_close_cache      (data/option_close_cache.json — Node writer)
-- Plus extends discover_snapshots with a `scope` column so we can
-- collapse data/discover.json + data/discover_sp500.json into one table.
--
-- Every CREATE uses IF NOT EXISTS so this migration is idempotent. The
-- migrate.{py,ts} runner additionally records the version into
-- schema_migrations after successful apply.

CREATE TABLE IF NOT EXISTS scanner_snapshots (
  scan_time TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flow_analysis_snapshots (
  scan_time TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS performance_snapshots (
  taken_at TEXT PRIMARY KEY,
  payload  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nav_history (
  date     TEXT PRIMARY KEY,
  net_liq  REAL NOT NULL,
  daily_pnl REAL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twr_history (
  date    TEXT PRIMARY KEY,
  twr     REAL NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS option_close_cache (
  symbol     TEXT NOT NULL,
  expiry     TEXT NOT NULL,
  strike     REAL NOT NULL,
  right      TEXT NOT NULL,
  close_date TEXT NOT NULL,
  close_price REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (symbol, expiry, strike, right, close_date)
);

CREATE INDEX IF NOT EXISTS option_close_cache_recorded_at_idx
  ON option_close_cache (recorded_at DESC);

-- discover_sp500_snapshots — sibling to discover_snapshots for the S&P
-- 500 scope of discover.py output. Kept as a separate table (rather than
-- ALTER TABLE ADD COLUMN scope on discover_snapshots) to avoid the
-- partial-migration replay risk that ALTER TABLE carries in SQLite.
CREATE TABLE IF NOT EXISTS discover_sp500_snapshots (
  scan_time TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (3, datetime('now'));
