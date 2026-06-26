-- 0005_backfill_naive_scan_time.sql
-- Backfill: Python scan writers historically emitted naive ISO timestamps
-- (`datetime.now().isoformat()`) on the Hetzner VPS, which runs UTC.
-- JS `new Date()` parses naive ISO strings as *local* time, shifting the
-- resulting instant by the user's TZ offset and producing wrong-day
-- filtering / premature staleness in the dashboard.
--
-- Hetzner is UTC, so every already-persisted naive timestamp is exactly
-- correct UTC — the fix is purely to make the offset explicit by appending
-- 'Z'. Going forward, the writers themselves emit `+00:00`-suffixed strings
-- (commit "fix(scans): emit timezone-aware UTC scan_time").
--
-- Scope: only tables whose `scan_time` (or `taken_at`) column is a full ISO
-- timestamp. Tables that key on an ET trading-date string ("2026-05-09")
-- are intentionally excluded — JS parses date-only strings as UTC anyway,
-- so they don't have the bug, and naively appending 'Z' would produce
-- invalid ISO ("2026-05-09Z") and could collide with an existing date row.
-- Excluded tables: discover_snapshots, discover_sp500_snapshots,
-- flow_analysis_snapshots, oi_changes.
--
-- The WHERE clause is doubly conservative: only rows that LOOK like a
-- timestamp (contain 'T') AND are NOT already tz-aware get updated.
--   - require 'T' (filters out date-only strays)
--   - skip rows ending in 'Z'
--   - skip rows containing '+' (e.g. "+00:00", "+02:00")
--   - skip rows ending in a "-HH:MM" trailer ("-04:00", "-05:00")
--     using `_` single-character glob match.
-- Naive ISO strings ("2026-05-09T01:58:36.144211") match the 'T' filter
-- and none of the tz-aware ones, so they get a 'Z' appended.

UPDATE scanner_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time LIKE '%T%'
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE vcg_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time LIKE '%T%'
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE gex_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time LIKE '%T%'
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

-- cri_snapshots uses `taken_at` (not `scan_time`) — column verified against
-- 0001_init.sql.
UPDATE cri_snapshots
SET taken_at = taken_at || 'Z'
WHERE taken_at IS NOT NULL
  AND taken_at LIKE '%T%'
  AND taken_at NOT LIKE '%Z'
  AND taken_at NOT LIKE '%+%'
  AND taken_at NOT LIKE '%-__:__';

-- service_health: every TEXT timestamp column.  `updated_at` was already
-- emitted via `_now_iso()` (Z-suffixed) since the writer landed, but
-- `last_attempt_started_at` / `last_attempt_finished_at` were forwarded
-- from the scan scripts and so could be naive. Backfill all three
-- defensively.
UPDATE service_health
SET last_attempt_started_at = last_attempt_started_at || 'Z'
WHERE last_attempt_started_at IS NOT NULL
  AND last_attempt_started_at LIKE '%T%'
  AND last_attempt_started_at NOT LIKE '%Z'
  AND last_attempt_started_at NOT LIKE '%+%'
  AND last_attempt_started_at NOT LIKE '%-__:__';

UPDATE service_health
SET last_attempt_finished_at = last_attempt_finished_at || 'Z'
WHERE last_attempt_finished_at IS NOT NULL
  AND last_attempt_finished_at LIKE '%T%'
  AND last_attempt_finished_at NOT LIKE '%Z'
  AND last_attempt_finished_at NOT LIKE '%+%'
  AND last_attempt_finished_at NOT LIKE '%-__:__';

UPDATE service_health
SET updated_at = updated_at || 'Z'
WHERE updated_at IS NOT NULL
  AND updated_at LIKE '%T%'
  AND updated_at NOT LIKE '%Z'
  AND updated_at NOT LIKE '%+%'
  AND updated_at NOT LIKE '%-__:__';

-- Date-only strays: tables that key on YYYY-MM-DD occasionally accumulated
-- malformed "YYYY-MM-DDZ" rows from older buggy writers. Rename them back
-- to plain dates if the plain-date row doesn't already exist; otherwise
-- drop the malformed copy.
UPDATE discover_snapshots
SET scan_time = substr(scan_time, 1, length(scan_time) - 1)
WHERE scan_time LIKE '____-__-__Z'
  AND substr(scan_time, 1, length(scan_time) - 1) NOT IN
      (SELECT scan_time FROM discover_snapshots);

DELETE FROM discover_snapshots WHERE scan_time LIKE '____-__-__Z';

UPDATE flow_analysis_snapshots
SET scan_time = substr(scan_time, 1, length(scan_time) - 1)
WHERE scan_time LIKE '____-__-__Z'
  AND substr(scan_time, 1, length(scan_time) - 1) NOT IN
      (SELECT scan_time FROM flow_analysis_snapshots);

DELETE FROM flow_analysis_snapshots WHERE scan_time LIKE '____-__-__Z';

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (5, datetime('now'));
