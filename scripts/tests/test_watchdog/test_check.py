"""Core check logic — per-service decision pipeline.

Each tested path:

 - happy: ok + fresh → no failure recorded.
 - stale: ok + past window → records stale failure (severity ~ market state).
 - error: state == 'error' → records error failure regardless of timestamp.
 - missing row: never-seen service → treated as stale.
 - active ack: returns SKIPPED without writing cooldown rows.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone


def _seed_service_health(db_conn, service: str, state: str, updated_at: datetime, error: dict | None = None):
    db_conn.execute(
        """
        INSERT OR REPLACE INTO service_health
          (service, state, last_attempt_started_at, last_attempt_finished_at,
           last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            service,
            state,
            None,
            updated_at.isoformat().replace("+00:00", "Z"),
            json.dumps(error) if error else None,
            updated_at.isoformat().replace("+00:00", "Z"),
        ),
    )
    db_conn.commit()


class TestCheckOutcomes:
    def test_fresh_ok_row_is_healthy(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "vcg-scan", "ok", now - timedelta(minutes=2))
        outcome = check.check_service(
            service="vcg-scan",
            kind="stale",
            now=now,
            market_state="open",
        )
        assert outcome.status == "healthy"
        assert outcome.fired is False

    def test_stale_ok_row_records_failure(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "vcg-scan", "ok", now - timedelta(minutes=30))
        outcome = check.check_service(
            service="vcg-scan",
            kind="stale",
            now=now,
            market_state="open",
        )
        assert outcome.status == "stale"
        assert outcome.fired is False  # first failure, hysteresis blocks

    def test_two_consecutive_stale_checks_fire(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "vcg-scan", "ok", now - timedelta(minutes=30))
        check.check_service(service="vcg-scan", kind="stale", now=now, market_state="open")
        outcome = check.check_service(
            service="vcg-scan",
            kind="stale",
            now=now + timedelta(minutes=5),
            market_state="open",
        )
        assert outcome.fired is True

    def test_error_state_records_error_failure(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(
            db_conn,
            "cash-flow-sync",
            "error",
            now - timedelta(minutes=1),
            error={"message": "Flex rate limit"},
        )
        check.check_service(service="cash-flow-sync", kind="error", now=now, market_state="closed")
        outcome = check.check_service(
            service="cash-flow-sync",
            kind="error",
            now=now,
            market_state="closed",
        )
        assert outcome.status == "error"
        assert outcome.fired is True
        assert "Flex rate limit" in outcome.message

    def test_missing_service_health_row_is_stale(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        # No row seeded for newsfeed-scraper.
        check.check_service(service="newsfeed-scraper", kind="stale", now=now, market_state="open")
        outcome = check.check_service(
            service="newsfeed-scraper",
            kind="stale",
            now=now + timedelta(minutes=5),
            market_state="open",
        )
        assert outcome.status == "stale"
        assert outcome.fired is True

    def test_active_ack_silences_and_skips_cooldown(self, db_conn):
        from watchdog import ack, check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "vcg-scan", "ok", now - timedelta(minutes=30))
        ack.add_ack(service="vcg-scan", hours=4, now=now)
        outcome = check.check_service(
            service="vcg-scan",
            kind="stale",
            now=now,
            market_state="open",
        )
        assert outcome.status == "acked"
        assert outcome.fired is False
        # Cooldown table should be untouched.
        rows = db_conn.execute(
            "SELECT * FROM watchdog_cooldowns WHERE service='vcg-scan'"
        ).fetchall()
        assert rows == []


class TestSeverityMapping:
    def test_market_hours_intraday_stale_is_p1(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "vcg-scan", "ok", now - timedelta(minutes=30))
        check.check_service(service="vcg-scan", kind="stale", now=now, market_state="open")
        outcome = check.check_service(
            service="vcg-scan",
            kind="stale",
            now=now + timedelta(minutes=5),
            market_state="open",
        )
        assert outcome.severity == "P1"

    def test_continuous_stale_is_p3(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "replica-watchdog", "ok", now - timedelta(minutes=10))
        check.check_service(service="replica-watchdog", kind="stale", now=now, market_state="closed")
        outcome = check.check_service(
            service="replica-watchdog",
            kind="stale",
            now=now + timedelta(minutes=5),
            market_state="closed",
        )
        assert outcome.severity == "P3"

    def test_error_state_is_p2(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        _seed_service_health(db_conn, "cash-flow-sync", "error", now)
        check.check_service(service="cash-flow-sync", kind="error", now=now, market_state="closed")
        outcome = check.check_service(
            service="cash-flow-sync",
            kind="error",
            now=now,
            market_state="closed",
        )
        assert outcome.severity == "P2"
