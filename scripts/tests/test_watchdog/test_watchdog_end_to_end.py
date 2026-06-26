"""End-to-end: a stale service_health row through the full pipeline.

Two consecutive runs against a stale service produce exactly one
Pushover call (mocked), one `service_health` row for `watchdog-alerts`,
and the cooldown table reflects the notification.

Discord support was removed 2026-05-19; Pushover is the only external
channel now exercised by this end-to-end.
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

    monkeypatch.setenv("PUSHOVER_USER", "u")
    monkeypatch.setenv("PUSHOVER_TOKEN", "t")

    now = datetime(2026, 5, 13, 15, 0, tzinfo=timezone.utc)
    _seed(db_conn, "vcg-scan", "ok", now - timedelta(minutes=30))
    # Seed the other intraday services as fresh.
    for other in ("cri-scan", "orders-sync", "portfolio-sync"):
        _seed(db_conn, other, "ok", now - timedelta(minutes=2))

    pushover_calls = []

    def fake_http_post(url, payload, headers=None):
        if "pushover" in url:
            pushover_calls.append((url, payload))
        return (204, b"")

    with patch("watchdog.notify._http_post", side_effect=fake_http_post):
        # First pass: hysteresis blocks firing.
        report1 = check.check_bucket(bucket="intraday", now=now)
        for outcome in report1.outcomes:
            if outcome.fired:
                notify.dispatch(outcome)

        assert pushover_calls == []

        # Second pass: hysteresis trips, fires.
        report2 = check.check_bucket(bucket="intraday", now=now + timedelta(minutes=5))
        for outcome in report2.outcomes:
            if outcome.fired:
                notify.dispatch(outcome)

        # Exactly one Pushover call referencing vcg-scan.
        assert len(pushover_calls) == 1
        assert "vcg-scan" in pushover_calls[0][1]["title"]

    # service_health 'watchdog-alerts' row written, reflecting DISPATCHER
    # HEALTH (state=ok because the dispatch succeeded). Downstream alert
    # content (vcg-scan, severity, etc.) goes to journalctl, NOT here —
    # see scripts/watchdog/notify.py module docstring.
    rows = db_conn.execute(
        "SELECT service, state, last_error FROM service_health WHERE service='watchdog-alerts'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][1] == "ok", f"dispatcher succeeded, row state must be ok; got {rows[0][1]!r}"
    assert rows[0][2] is None or "vcg-scan" not in (rows[0][2] or ""), (
        f"downstream alert detail must not leak into watchdog-alerts.last_error; "
        f"got {rows[0][2]!r}"
    )

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
