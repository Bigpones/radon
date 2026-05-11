"""End-to-end: a stale service_health row through the full pipeline.

Two consecutive runs against a stale service produce exactly one Discord
call (mocked), one `service_health` row for `watchdog-alerts`, and the
cooldown table reflects the notification.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch


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


def test_stale_intraday_service_pipeline(db_conn, monkeypatch):
    from watchdog import check, notify

    monkeypatch.setenv("DISCORD_WATCHDOG_WEBHOOK_URL", "https://discord.example/x")

    now = datetime(2026, 5, 13, 15, 0, tzinfo=timezone.utc)
    _seed(db_conn, "vcg-scan", "ok", now - timedelta(minutes=30))
    # Seed the other intraday services as fresh.
    for other in ("cri-scan", "orders-sync", "portfolio-sync"):
        _seed(db_conn, other, "ok", now - timedelta(minutes=2))

    discord_calls = []

    def fake_http_post(url, payload, headers=None):
        discord_calls.append((url, payload))
        return (204, b"")

    with patch("watchdog.notify._http_post", side_effect=fake_http_post):
        # First pass: hysteresis blocks firing.
        report1 = check.check_bucket(bucket="intraday", now=now)
        for outcome in report1.outcomes:
            if outcome.fired:
                notify.dispatch(outcome)

        assert discord_calls == []

        # Second pass: hysteresis trips, fires.
        report2 = check.check_bucket(bucket="intraday", now=now + timedelta(minutes=5))
        for outcome in report2.outcomes:
            if outcome.fired:
                notify.dispatch(outcome)

        # Exactly one Discord call referencing vcg-scan.
        assert len(discord_calls) == 1
        assert "vcg-scan" in discord_calls[0][1]["content"]

    # service_health 'watchdog-alerts' row written.
    rows = db_conn.execute(
        "SELECT service, state, last_error FROM service_health WHERE service='watchdog-alerts'"
    ).fetchall()
    assert len(rows) == 1
    assert "vcg-scan" in rows[0][2]

    # Hysteresis row reached threshold + cooldown row stamped post-dispatch.
    hysteresis = db_conn.execute(
        "SELECT consecutive_failures FROM watchdog_cooldowns "
        "WHERE service='vcg-scan' AND kind='stale'"
    ).fetchall()
    assert hysteresis and hysteresis[0][0] >= 2

    cooldown_rows = db_conn.execute(
        "SELECT last_notified_at FROM watchdog_cooldowns "
        "WHERE service='vcg-scan' AND kind LIKE 'severity:%'"
    ).fetchall()
    assert cooldown_rows and cooldown_rows[0][0] is not None
