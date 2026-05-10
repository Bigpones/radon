#!/usr/bin/env python3
"""Cadence + circuit-breaker tests for the cash_flow_sync handler.

Production bug (2026-05-09): a withdrawal initiated on 2026-05-08 did
not appear in the Cash Flows panel for ~24h. Initial fix lowered the
4h polling interval, but on 2026-05-09 the same handler hammered Flex
through a sliding-window throttle and burned ~24h of visibility. The
new cadence is **once per ET trading day at 17:00 ET** with throttle-
aware exponential backoff (24h -> 48h -> 72h -> 168h capped) on
documented Flex throttle codes.

Tests pin the fire window, weekend / holiday skip, DST handling, and
the circuit breaker that delays the next attempt across daemon
restarts.

Late-fire policy: if `last_run` is on a strictly earlier ET trading
day AND the daemon is past 17:00 ET on a current trading day, fire
late even if the 17:00 to 18:00 ET "preferred" window has passed. The
1-hour preferred window only exists so the daemon's 30s loop has
multiple chances under normal operation; missing a day defeats the
purpose.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9 fallback
    from backports.zoneinfo import ZoneInfo  # type: ignore

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


ET = ZoneInfo("America/New_York")


def _et_to_utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """Build a UTC datetime that maps to the given ET wall-clock moment."""
    et_dt = datetime(year, month, day, hour, minute, tzinfo=ET)
    return et_dt.astimezone(timezone.utc)


# --------------------------------------------------------------------------- is_due

class TestDailyFireWindow:
    """Handler fires once per ET trading day at 17:00 ET (1h after close)."""

    def _fresh_handler(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler
        return CashFlowSyncHandler()

    def test_fires_at_17_30_et_on_monday_with_no_prior_run(self):
        # 2026-05-11 is a Monday; 17:30 EDT = 21:30 UTC.
        now = _et_to_utc(2026, 5, 11, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is True

    def test_does_not_fire_on_saturday(self):
        # 2026-05-09 is a Saturday at 17:30 ET.
        now = _et_to_utc(2026, 5, 9, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False

    def test_does_not_fire_on_sunday(self):
        now = _et_to_utc(2026, 5, 10, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False

    def test_does_not_fire_before_window_opens(self):
        # 16:30 ET on Monday — window not yet open.
        now = _et_to_utc(2026, 5, 11, 16, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False

    def test_late_fire_after_18_when_not_run_today(self):
        # 18:30 ET Monday, no prior run — fire late, not next day.
        now = _et_to_utc(2026, 5, 11, 18, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is True

    def test_does_not_re_fire_same_et_trading_day(self):
        # last_run at 17:05 ET, now 17:45 ET same day → already done.
        last_run = _et_to_utc(2026, 5, 11, 17, 5)
        now = _et_to_utc(2026, 5, 11, 17, 45)
        h = self._fresh_handler()
        h.last_run = last_run
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False

    def test_fires_again_next_trading_day(self):
        # last_run yesterday at 17:05 ET, now 17:30 ET today → fire.
        last_run = _et_to_utc(2026, 5, 11, 17, 5)
        now = _et_to_utc(2026, 5, 12, 17, 30)
        h = self._fresh_handler()
        h.last_run = last_run
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is True


class TestHolidaySkip:
    """US trading holidays are skipped — the next eligible day is the next
    trading day."""

    def _fresh_handler(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler
        return CashFlowSyncHandler()

    def test_does_not_fire_on_christmas(self):
        # 2026-12-25 is a Friday and a US trading holiday.
        now = _et_to_utc(2026, 12, 25, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False

    def test_does_not_fire_on_mlk_day(self):
        # 2026-01-19 (Monday) — MLK day.
        now = _et_to_utc(2026, 1, 19, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False


class TestDSTBoundaries:
    """zoneinfo handles 17:00 ET correctly across the EST/EDT boundary."""

    def _fresh_handler(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler
        return CashFlowSyncHandler()

    def test_17_et_in_march_edt(self):
        # 2026-03-16 (Monday, after DST start). 17:30 EDT = 21:30 UTC.
        now = _et_to_utc(2026, 3, 16, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is True

    def test_17_et_in_december_est(self):
        # 2026-12-14 (Monday, EST). 17:30 EST = 22:30 UTC.
        now = _et_to_utc(2026, 12, 14, 17, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is True

    def test_16_30_est_in_december_does_not_fire(self):
        now = _et_to_utc(2026, 12, 14, 16, 30)
        h = self._fresh_handler()
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=now
        ):
            assert h.is_due() is False


class TestCircuitBreakerCadence:
    """Throttle-aware backoff composes with the daily window: a 24h
    embargo says 'no earlier than tomorrow at 17:00 ET'."""

    def _fresh_handler(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler
        return CashFlowSyncHandler()

    def test_blocked_during_embargo(self):
        from monitor_daemon.handlers._throttle_backoff import record_throttle

        now = _et_to_utc(2026, 5, 11, 17, 30)
        h = self._fresh_handler()
        # Pretend a throttle just landed; 24h embargo.
        h._backoff_state = record_throttle({"throttle_count": 0, "blocked_until": None}, now_utc=now)
        # 1h later, still in window → blocked.
        later = now + timedelta(hours=1)
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc", return_value=later
        ):
            assert h.is_due() is False

    def test_unblocked_after_embargo_expires_and_in_daily_window(self):
        from monitor_daemon.handlers._throttle_backoff import record_throttle

        first = _et_to_utc(2026, 5, 11, 17, 30)
        h = self._fresh_handler()
        h._backoff_state = record_throttle({"throttle_count": 0, "blocked_until": None}, now_utc=first)
        # 25h later → embargo cleared, also a daily window on 5/12 17:30 ET.
        next_day_window = _et_to_utc(2026, 5, 12, 18, 30)
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc",
            return_value=next_day_window,
        ):
            assert h.is_due() is True

    def test_breaker_persists_through_get_state_set_state(self):
        from monitor_daemon.handlers._throttle_backoff import record_throttle

        now = _et_to_utc(2026, 5, 11, 17, 30)
        h1 = self._fresh_handler()
        h1._backoff_state = record_throttle({"throttle_count": 0, "blocked_until": None}, now_utc=now)
        state = h1.get_state()
        assert "backoff_state" in state
        assert state["backoff_state"]["throttle_count"] == 1

        h2 = self._fresh_handler()
        h2.set_state(state)
        # 1h later — still blocked.
        with patch(
            "monitor_daemon.handlers.cash_flow_sync._now_utc",
            return_value=now + timedelta(hours=1),
        ):
            assert h2.is_due() is False
        assert h2._backoff_state["throttle_count"] == 1

    def test_successful_run_resets_breaker(self):
        from monitor_daemon.handlers._throttle_backoff import record_throttle

        now = _et_to_utc(2026, 5, 11, 17, 30)
        h = self._fresh_handler()
        h._backoff_state = record_throttle({"throttle_count": 0, "blocked_until": None}, now_utc=now)
        # Simulate the success path the handler triggers internally.
        h._mark_success()
        assert h._backoff_state["throttle_count"] == 0
        assert h._backoff_state["blocked_until"] is None


# --------------------------------------------------------------------------- handler contract

class TestHandlerContract:
    """The handler still has to behave well in the daemon's framework."""

    def test_does_not_require_market_hours(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler
        assert CashFlowSyncHandler.requires_market_hours is False

    def test_other_handlers_still_use_default_is_due(self):
        """The override is on CashFlowSyncHandler only — generic handlers
        keep the BaseHandler.is_due interval semantics."""
        from monitor_daemon.handlers.base import BaseHandler

        class Toy(BaseHandler):
            name = "toy"
            interval_seconds = 60
            requires_market_hours = False

            def execute(self):
                return {}

        h = Toy()
        h.last_run = datetime.now() - timedelta(seconds=120)
        # No is_due override on generic handlers — only the time-since-last-run
        # rule applies, and that has nothing to do with ET / 17:00.
        assert h.is_due() is True
        h.last_run = datetime.now() - timedelta(seconds=10)
        assert h.is_due() is False
