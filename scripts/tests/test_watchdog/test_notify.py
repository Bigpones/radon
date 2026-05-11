"""Notification channel dispatch.

Channels are pluggable; each is disabled when its env vars are unset.
Tests mock urllib so no live HTTP is made — the watchdog must be safe
to import + run in CI without network access.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def sample_alert():
    from watchdog.check import CheckOutcome

    return CheckOutcome(
        service="vcg-scan",
        kind="stale",
        status="stale",
        severity="P1",
        fired=True,
        message="silent for 23m (window 15m) — market open",
        consecutive_failures=2,
        now=datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc),
    )


class TestChannelGating:
    def test_discord_disabled_without_webhook(self, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.delenv("DISCORD_WATCHDOG_WEBHOOK_URL", raising=False)
        channels = notify.enabled_channels()
        assert "discord" not in channels

    def test_pushover_disabled_without_creds(self, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.delenv("PUSHOVER_USER", raising=False)
        monkeypatch.delenv("PUSHOVER_TOKEN", raising=False)
        channels = notify.enabled_channels()
        assert "pushover" not in channels

    def test_resend_disabled_without_keys(self, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.delenv("RESEND_API_KEY", raising=False)
        monkeypatch.delenv("WATCHDOG_EMAIL_TO", raising=False)
        channels = notify.enabled_channels()
        assert "resend" not in channels

    def test_service_health_log_is_always_enabled(self, monkeypatch):
        from watchdog import notify

        monkeypatch.delenv("DISCORD_WATCHDOG_WEBHOOK_URL", raising=False)
        monkeypatch.delenv("PUSHOVER_USER", raising=False)
        monkeypatch.delenv("PUSHOVER_TOKEN", raising=False)
        channels = notify.enabled_channels()
        assert "service_health" in channels

    def test_discord_enabled_with_webhook(self, monkeypatch):
        from watchdog import notify

        monkeypatch.setenv("DISCORD_WATCHDOG_WEBHOOK_URL", "https://discord.example/x")
        assert "discord" in notify.enabled_channels()


class TestDiscordPayload:
    def test_payload_contains_service_and_severity(self, db_conn, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.setenv("DISCORD_WATCHDOG_WEBHOOK_URL", "https://discord.example/x")
        with patch("watchdog.notify._http_post") as http_post:
            http_post.return_value = (204, b"")
            notify.dispatch(sample_alert)
        assert http_post.called
        url, payload = http_post.call_args_list[-1][0][:2]
        # Find the discord call (service_health emit doesn't go via _http_post).
        discord_call = [c for c in http_post.call_args_list if "discord" in c[0][0]][0]
        url, payload = discord_call[0][:2]
        assert url == "https://discord.example/x"
        body = payload["content"]
        assert "vcg-scan" in body
        assert "P1" in body
        assert "silent for 23m" in body


class TestPushoverPayload:
    def test_pushover_only_for_p1(self, db_conn, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.setenv("PUSHOVER_USER", "u")
        monkeypatch.setenv("PUSHOVER_TOKEN", "t")
        with patch("watchdog.notify._http_post") as http_post:
            http_post.return_value = (200, b"")
            notify.dispatch(sample_alert)
            pushover_calls = [c for c in http_post.call_args_list if "pushover" in c[0][0]]
            assert len(pushover_calls) == 1

    def test_pushover_skipped_for_p3(self, db_conn, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.setenv("PUSHOVER_USER", "u")
        monkeypatch.setenv("PUSHOVER_TOKEN", "t")
        sample_alert.severity = "P3"
        with patch("watchdog.notify._http_post") as http_post:
            http_post.return_value = (200, b"")
            notify.dispatch(sample_alert)
            pushover_calls = [c for c in http_post.call_args_list if "pushover" in c[0][0]]
            assert pushover_calls == []


class TestServiceHealthLog:
    def test_writes_watchdog_alerts_row(self, db_conn, monkeypatch, sample_alert):
        from watchdog import notify

        monkeypatch.delenv("DISCORD_WATCHDOG_WEBHOOK_URL", raising=False)
        monkeypatch.delenv("PUSHOVER_USER", raising=False)
        notify.dispatch(sample_alert)
        rows = db_conn.execute(
            "SELECT service, state, last_error FROM service_health WHERE service='watchdog-alerts'"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0][1] == "error"
        assert "vcg-scan" in rows[0][2]


class TestStartupWarning:
    def test_warns_when_only_service_health_enabled(self, monkeypatch, capsys):
        from watchdog import notify

        monkeypatch.delenv("DISCORD_WATCHDOG_WEBHOOK_URL", raising=False)
        monkeypatch.delenv("PUSHOVER_USER", raising=False)
        monkeypatch.delenv("PUSHOVER_TOKEN", raising=False)
        monkeypatch.delenv("RESEND_API_KEY", raising=False)
        notify.log_startup_warning()
        captured = capsys.readouterr()
        assert "warning" in captured.err.lower() or "warn" in captured.err.lower()

    def test_no_warning_when_discord_enabled(self, monkeypatch, capsys):
        from watchdog import notify

        monkeypatch.setenv("DISCORD_WATCHDOG_WEBHOOK_URL", "https://discord.example/x")
        notify.log_startup_warning()
        captured = capsys.readouterr()
        assert "no external channel" not in captured.err.lower()
