"""CLI ack / status / clear behaviour."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


class TestAckInsert:
    def test_ack_writes_row_with_expiry(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="vcg-scan", hours=4, reason="manual silence", now=now)
        row = db_conn.execute(
            "SELECT service, expires_at, reason FROM watchdog_acks"
        ).fetchone()
        assert row[0] == "vcg-scan"
        assert row[2] == "manual silence"
        # Expiry should be 4h from now (with Z suffix):
        expected = (now + timedelta(hours=4)).isoformat().replace("+00:00", "Z")
        assert row[1] == expected

    def test_ack_replaces_existing(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="vcg-scan", hours=4, now=now)
        ack.add_ack(service="vcg-scan", hours=8, now=now)
        rows = db_conn.execute(
            "SELECT service FROM watchdog_acks WHERE service='vcg-scan'"
        ).fetchall()
        assert len(rows) == 1


class TestAckActive:
    def test_unacked_service_is_not_silenced(self, db_conn):
        from watchdog import ack

        assert ack.is_acked(service="vcg-scan", now=datetime.now(timezone.utc)) is False

    def test_active_ack_silences(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="vcg-scan", hours=4, now=now)
        assert ack.is_acked(
            service="vcg-scan",
            now=now + timedelta(hours=2),
        ) is True

    def test_expired_ack_does_not_silence(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="vcg-scan", hours=4, now=now)
        assert ack.is_acked(
            service="vcg-scan",
            now=now + timedelta(hours=5),
        ) is False


class TestAckClear:
    def test_clear_removes_row(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="vcg-scan", hours=4, now=now)
        ack.clear_ack(service="vcg-scan")
        rows = db_conn.execute("SELECT service FROM watchdog_acks").fetchall()
        assert rows == []

    def test_clear_nonexistent_is_noop(self, db_conn):
        from watchdog import ack

        ack.clear_ack(service="never-existed")  # must not raise


class TestAckStatus:
    def test_status_returns_only_active_acks(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="active-svc", hours=4, now=now)
        ack.add_ack(service="expired-svc", hours=1, now=now - timedelta(hours=3))
        active = ack.list_active_acks(now=now)
        services = {row["service"] for row in active}
        assert "active-svc" in services
        assert "expired-svc" not in services

    def test_status_includes_expiry_and_reason(self, db_conn):
        from watchdog import ack

        now = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)
        ack.add_ack(service="vcg-scan", hours=4, reason="planned outage", now=now)
        active = ack.list_active_acks(now=now)
        assert active[0]["reason"] == "planned outage"
        assert "expires_at" in active[0]
