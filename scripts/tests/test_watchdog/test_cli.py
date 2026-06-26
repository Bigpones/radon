"""CLI smoke tests for `python -m scripts.watchdog`.

The CLI is a thin wrapper around watchdog.ack and watchdog.check. These
tests drive `main()` directly so they don't spawn a subprocess.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def test_ack_command_silences_service(db_conn, capsys):
    from watchdog.__main__ import main

    rc = main(["ack", "vcg-scan", "--hours", "4", "--reason", "manual silence"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "vcg-scan" in out
    assert "acked" in out.lower()
    rows = db_conn.execute("SELECT service, reason FROM watchdog_acks").fetchall()
    assert rows == [("vcg-scan", "manual silence")]


def test_clear_command_removes_ack(db_conn, capsys):
    from watchdog.__main__ import main

    main(["ack", "vcg-scan", "--hours", "4"])
    rc = main(["clear", "vcg-scan"])
    assert rc == 0
    rows = db_conn.execute("SELECT service FROM watchdog_acks").fetchall()
    assert rows == []


def test_status_command_lists_active(db_conn, capsys):
    from watchdog.__main__ import main

    main(["ack", "vcg-scan", "--hours", "4", "--reason", "planned outage"])
    rc = main(["status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "vcg-scan" in out
    assert "planned outage" in out


def test_status_empty(db_conn, capsys):
    from watchdog.__main__ import main

    rc = main(["status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "no active acks" in out


def test_bucket_command_runs(db_conn, capsys, monkeypatch):
    from watchdog.__main__ import main

    # Force market closed so intraday is a no-op (deterministic, no
    # external HTTP).
    monkeypatch.setenv("TZ", "UTC")
    rc = main(["--bucket", "continuous"])
    assert rc == 0


def test_bucket_intraday_no_op_off_hours(db_conn, capsys):
    """The intraday bucket may run on the CLI at any time; the
    `_intraday_timer_window_active` gate inside check.check_bucket
    must short-circuit when ET is closed.
    """
    from watchdog import check

    # 03:00 UTC Sunday — closed everywhere.
    sunday_3am_utc = datetime(2026, 5, 10, 3, 0, tzinfo=timezone.utc)
    report = check.check_bucket(bucket="intraday", now=sunday_3am_utc)
    assert report.ran is False
