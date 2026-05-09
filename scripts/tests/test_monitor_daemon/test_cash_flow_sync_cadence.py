#!/usr/bin/env python3
"""Cadence + IBKR-Flex-lag tests for the cash_flow_sync handler.

Production bug (2026-05-09): a withdrawal initiated on 2026-05-08 did not
appear in the Cash Flows panel for ~24h. Root cause: the handler's
``CHECK_INTERVAL`` was 86400s (24h). Combined with IBKR's 1-day Flex
settlement lag and the daemon's persisted ``last_run`` state, a
transaction that became Flex-visible the next morning had to wait until
the previous day's run-time + 24h before being re-fetched — a 12-24h
display lag the user actually felt.

Pin the cadence to <= 4h so the next sync after Flex makes a row visible
fires within 4h, not 24h. Tests are red against the previous 86400s
constant and green at 14400s.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# --------------------------------------------------------------------------- cadence

class TestCashFlowSyncCadence:
    """The handler must poll Flex often enough to surface a transaction
    within 4h of it becoming Flex-visible."""

    def test_check_interval_is_at_most_four_hours(self):
        """Daily polling caused the May 8 withdrawal to lag ~24h.

        Lower bound at 4h: 4-hour cadence catches Flex's morning
        settlement of a previous-evening transaction within one cycle.
        """
        from monitor_daemon.handlers.cash_flow_sync import CHECK_INTERVAL

        assert CHECK_INTERVAL <= 4 * 60 * 60, (
            f"CHECK_INTERVAL is {CHECK_INTERVAL}s — too long. IBKR Flex "
            "lags ~1 day for cash transactions, and a daily handler can "
            "miss the morning settlement window. Cap at 4h (14400s)."
        )

    def test_check_interval_is_not_pathologically_short(self):
        """Don't hammer Flex — sub-15-min polling is wasteful."""
        from monitor_daemon.handlers.cash_flow_sync import CHECK_INTERVAL

        assert CHECK_INTERVAL >= 15 * 60, (
            f"CHECK_INTERVAL is {CHECK_INTERVAL}s — too aggressive. "
            "IBKR Flex publishes once per day; sub-15-min polling wastes "
            "API budget without surfacing fresher data."
        )

    def test_handler_class_uses_module_constant(self):
        """``CashFlowSyncHandler.interval_seconds`` must follow the module
        constant — defending against accidental drift between docstring
        and class attribute."""
        from monitor_daemon.handlers.cash_flow_sync import (
            CHECK_INTERVAL,
            CashFlowSyncHandler,
        )

        assert CashFlowSyncHandler.interval_seconds == CHECK_INTERVAL


# --------------------------------------------------------------------------- is_due

class TestStartupCatchUp:
    """If the daemon was off when a Flex window opened, ``is_due`` must
    return True for any persisted ``last_run`` older than the interval.

    The ``BaseHandler.is_due`` already implements this; the test pins
    the contract so future refactors don't accidentally regress it.
    """

    def test_due_when_last_run_is_older_than_interval(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler

        h = CashFlowSyncHandler()
        # Mark last run as just past one interval ago — handler must fire.
        h.last_run = datetime.now() - timedelta(seconds=h.interval_seconds + 60)
        assert h.is_due() is True

    def test_not_due_when_last_run_is_recent(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler

        h = CashFlowSyncHandler()
        h.last_run = datetime.now() - timedelta(seconds=60)
        assert h.is_due() is False

    def test_due_when_never_run(self):
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler

        h = CashFlowSyncHandler()
        assert h.last_run is None
        assert h.is_due() is True

    def test_does_not_require_market_hours(self):
        """Cash-flow sync must run weekends + nights — settlement
        publishes outside RTH and the user expects the panel current
        on Saturdays."""
        from monitor_daemon.handlers.cash_flow_sync import CashFlowSyncHandler

        assert CashFlowSyncHandler.requires_market_hours is False
