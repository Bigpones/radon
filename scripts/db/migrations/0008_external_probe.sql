-- 0008_external_probe.sql — Tier-3 OFF-BOX health prober results.
--
-- Why a dedicated table: Tier-1 (FastAPI /health) and Tier-2 (the isolated
-- scripts/health_service daemon at :8321/edge-health) both run ON the Hetzner
-- VPS. If the whole box dies — kernel panic, network partition, Hetzner
-- incident — every on-box prober dies WITH it and the last service_health row
-- latches as whatever it was before the box went dark. No on-box observer can
-- record "the box is down" because the observer is also down.
--
-- Tier-3 closes that gap: a prober runs OFF the box (GitHub Actions infra, not
-- on the tailnet) and records reachability of the PUBLIC edge into Turso, which
-- is itself off-box (libsql cloud). It can only reach what the public internet
-- can reach — https://app.radon.run/edge-health/ping (static 200 liveness) and
-- /edge-health/status (the Tier-2 daemon's aggregate). It CANNOT reach the
-- Tailscale FastAPI :8321 or IB Gateway TCP :4001 — that's by design; the
-- edge already aggregates the internal probes, and an off-tailnet runner
-- proving the public edge is reachable is the realistic outermost ring.
--
-- One row per source (UNIQUE(source)) so the table is latest-per-source and an
-- UPSERT keeps it bounded. checked_at is the prober's own wall clock at write
-- time — it doubles as the dead-man's-switch input: a consumer that finds
-- checked_at older than the expected cadence must treat the row as STALE
-- (prober itself is dead / the scheduled workflow stopped firing) rather than
-- reading a latched ok=1 as all-green. See scripts/health_probe/reader.py and
-- the package docstring for the staleness rule.

CREATE TABLE IF NOT EXISTS external_probe (
  source       TEXT    PRIMARY KEY,   -- logical probe identity, e.g. 'github-actions/edge'
  ok           INTEGER NOT NULL,      -- 1 = edge reachable + healthy, 0 = not
  http_status  INTEGER,               -- HTTP status of the aggregate /status GET (NULL on transport error)
  latency_ms   INTEGER,               -- round-trip ms for the slowest probed endpoint (NULL on transport error)
  detail       TEXT,                  -- short machine-readable reason / classification
  checked_at   TEXT    NOT NULL       -- ISO-8601 UTC timestamp of THIS probe (dead-man's-switch input)
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (8, datetime('now'));
