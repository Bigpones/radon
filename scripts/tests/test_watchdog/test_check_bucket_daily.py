"""The daily bucket fires regardless of hour.

cash-flow-sync runs ~once per day, flex-token-check ~once per day, so
their 25h freshness window is what catches actual failure. The watchdog
timer fires every hour and we expect the bucket to always run.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone


def _seed(db_conn, service: str, state: str, updated_at: datetime, error: dict | None = None):
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


class TestDailyBucket:
    def test_daily_runs_at_midnight(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 13, 0, 0, tzinfo=timezone.utc)
        _seed(db_conn, "cash-flow-sync", "ok", now - timedelta(hours=22))
        report = check.check_bucket(bucket="daily", now=now)
        assert report.ran is True

    def test_daily_runs_during_market_hours(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 13, 15, 0, tzinfo=timezone.utc)
        _seed(db_conn, "cash-flow-sync", "ok", now - timedelta(hours=22))
        report = check.check_bucket(bucket="daily", now=now)
        assert report.ran is True

    def test_daily_fires_when_cash_flow_silent_for_26h(self, db_conn):
        from watchdog import check

        # cash-flow-sync window is 25h. Past 26h is stale.
        now = datetime(2026, 5, 13, 15, 0, tzinfo=timezone.utc)
        _seed(db_conn, "cash-flow-sync", "ok", now - timedelta(hours=26))
        _seed(db_conn, "flex-token-check", "ok", now - timedelta(hours=22))
        check.check_bucket(bucket="daily", now=now)
        report = check.check_bucket(bucket="daily", now=now + timedelta(hours=1))
        fired = [o for o in report.outcomes if o.fired]
        assert any(o.service == "cash-flow-sync" for o in fired)


class TestErrorBucket:
    def test_error_bucket_runs_always(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 4, 0, tzinfo=timezone.utc)
        _seed(db_conn, "vcg-scan", "ok", now)
        report = check.check_bucket(bucket="error", now=now)
        assert report.ran is True

    def test_error_bucket_only_alerts_on_error_state(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 4, 0, tzinfo=timezone.utc)
        _seed(db_conn, "vcg-scan", "ok", now - timedelta(days=2))
        check.check_bucket(bucket="error", now=now)
        report = check.check_bucket(bucket="error", now=now + timedelta(minutes=5))
        fired = [o for o in report.outcomes if o.fired]
        # vcg-scan is stale but bucket only watches errors → no fire.
        assert fired == []

    def test_error_bucket_fires_on_persistent_error(self, db_conn):
        from watchdog import check

        now = datetime(2026, 5, 11, 4, 0, tzinfo=timezone.utc)
        _seed(
            db_conn,
            "cash-flow-sync",
            "error",
            now,
            error={"message": "Flex throttled"},
        )
        check.check_bucket(bucket="error", now=now)
        report = check.check_bucket(bucket="error", now=now + timedelta(minutes=5))
        fired = [o for o in report.outcomes if o.fired]
        assert any(o.service == "cash-flow-sync" for o in fired)
