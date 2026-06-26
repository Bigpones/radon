-- 0006_watchdog_state.sql — watchdog-services cooldown + ack tables.
--
-- The watchdog (scripts/watchdog/) polls service_health on a per-bucket
-- timer cadence and fires notifications when tracked services go silent
-- or error past hysteresis. Two pieces of state live here:
--
--   watchdog_cooldowns — per (service, kind) record of consecutive
--   failures + last-notification timestamp. Hysteresis requires 2
--   consecutive failed checks before firing; cooldown suppresses
--   repeat pings inside a 1h window. Recovery (first healthy check)
--   resets `consecutive_failures` to 0.
--
--   watchdog_acks — operator silences via the CLI (`radon-watchdog ack
--   <service>`). An active ack (`expires_at > now()`) makes the check
--   loop skip the service silently. `clear` removes the row.
--
-- Both tables key on `service`; `watchdog_cooldowns` also keys on `kind`
-- so we can track stale-vs-error independently per service.

CREATE TABLE IF NOT EXISTS watchdog_cooldowns (
  service              TEXT    NOT NULL,
  kind                 TEXT    NOT NULL,                  -- 'stale' | 'error'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_notified_at     TEXT,
  last_outcome         TEXT,
  PRIMARY KEY (service, kind)
);

CREATE TABLE IF NOT EXISTS watchdog_acks (
  service     TEXT    PRIMARY KEY,
  acked_at    TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  reason      TEXT
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (6, datetime('now'));
