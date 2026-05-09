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
-- The WHERE clause is conservative: only rows that are NOT already tz-aware
-- get updated.
--   - skip rows ending in 'Z'
--   - skip rows containing '+' (e.g. "+00:00", "+02:00")
--   - skip rows ending in a "-HH:MM" trailer ("-04:00", "-05:00")
--     using `_` single-character glob match.
-- Naive ISO strings ("2026-05-09T01:58:36.144211") match none of those
-- patterns and get a 'Z' appended.

UPDATE discover_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE discover_sp500_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE scanner_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE flow_analysis_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE vcg_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

UPDATE gex_snapshots
SET scan_time = scan_time || 'Z'
WHERE scan_time IS NOT NULL
  AND scan_time NOT LIKE '%Z'
  AND scan_time NOT LIKE '%+%'
  AND scan_time NOT LIKE '%-__:__';

-- cri_snapshots uses `taken_at` (not `scan_time`) — column verified against
-- 0001_init.sql.
UPDATE cri_snapshots
SET taken_at = taken_at || 'Z'
WHERE taken_at IS NOT NULL
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
  AND last_attempt_started_at NOT LIKE '%Z'
  AND last_attempt_started_at NOT LIKE '%+%'
  AND last_attempt_started_at NOT LIKE '%-__:__';

UPDATE service_health
SET last_attempt_finished_at = last_attempt_finished_at || 'Z'
WHERE last_attempt_finished_at IS NOT NULL
  AND last_attempt_finished_at NOT LIKE '%Z'
  AND last_attempt_finished_at NOT LIKE '%+%'
  AND last_attempt_finished_at NOT LIKE '%-__:__';

UPDATE service_health
SET updated_at = updated_at || 'Z'
WHERE updated_at IS NOT NULL
  AND updated_at NOT LIKE '%Z'
  AND updated_at NOT LIKE '%+%'
  AND updated_at NOT LIKE '%-__:__';

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (5, datetime('now'));
