#!/usr/bin/env python3
"""
Tests for Fill Monitor handler.

RED/GREEN TDD
"""

import pytest
import json
from pathlib import Path
from datetime import datetime
from unittest.mock import Mock, patch, MagicMock

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from monitor_daemon.handlers.fill_monitor import FillMonitorHandler


def make_mock_client(trades=None):
    """Create a mock IBClient for fill monitor tests."""
    mock_client = MagicMock()
    mock_client.get_open_orders.return_value = trades or []
    return mock_client


class TestFillMonitorInit:
    """Test fill monitor initialization."""

    def test_has_correct_name(self):
        """Handler has correct name."""
        handler = FillMonitorHandler()
        assert handler.name == "fill_monitor"

    def test_has_short_interval(self):
        """Handler runs every 60 seconds."""
        handler = FillMonitorHandler()
        assert handler.interval_seconds == 60

    def test_tracks_known_orders(self):
        """Handler tracks known order states."""
        handler = FillMonitorHandler()
        assert hasattr(handler, 'known_orders')
        assert isinstance(handler.known_orders, dict)


class TestFillMonitorExecute:
    """Test fill monitor execution."""

    def test_connects_to_ib(self):
        """Handler connects to IB via IBClient."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls:
            mock_client = make_mock_client()
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler()
            handler.execute()

            mock_client.connect.assert_called_once()

    def test_fetches_open_orders(self):
        """Handler fetches open orders via IBClient.get_open_orders."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls:
            mock_client = make_mock_client()
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler()
            handler.execute()

            mock_client.get_open_orders.assert_called_once()

    def test_detects_new_order(self):
        """Handler detects new orders."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls:
            # Mock a trade
            mock_trade = MagicMock()
            mock_trade.order.orderId = 5
            mock_trade.order.action = "BUY"
            mock_trade.order.totalQuantity = 25
            mock_trade.order.lmtPrice = 1.00
            mock_trade.orderStatus.status = "Submitted"
            mock_trade.orderStatus.filled = 0
            mock_trade.orderStatus.remaining = 25
            mock_trade.orderStatus.avgFillPrice = None
            mock_trade.contract.symbol = "AAOI"
            mock_trade.contract.localSymbol = "AAOI  260306P00090000"

            mock_client = make_mock_client(trades=[mock_trade])
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler()
            result = handler.execute()

            assert "orders" in result
            assert len(result["orders"]) == 1
            assert result["new_orders"] == 1

    def test_detects_partial_fill(self):
        """Handler detects partial fills."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls:
            mock_trade = MagicMock()
            mock_trade.order.orderId = 5
            mock_trade.order.action = "BUY"
            mock_trade.order.totalQuantity = 25
            mock_trade.order.lmtPrice = 1.00
            mock_trade.orderStatus.status = "Submitted"
            mock_trade.orderStatus.filled = 10
            mock_trade.orderStatus.remaining = 15
            mock_trade.orderStatus.avgFillPrice = 0.98
            mock_trade.contract.symbol = "AAOI"
            mock_trade.contract.localSymbol = "AAOI  260306P00090000"

            mock_client = make_mock_client(trades=[mock_trade])
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler()
            # Pretend we knew about this order with 0 filled
            handler.known_orders = {5: {"filled": 0}}

            result = handler.execute()

            assert result["partial_fills"] == 1
            assert result["fills"][0]["order_id"] == 5
            assert result["fills"][0]["newly_filled"] == 10

    def test_detects_complete_fill(self):
        """Handler detects complete fills (order no longer in open orders)."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls:
            # No open orders now
            mock_client = make_mock_client(trades=[])
            mock_cls.return_value = mock_client

            # But we had an order before
            handler = FillMonitorHandler()
            handler.known_orders = {
                5: {
                    "symbol": "AAOI",
                    "contract": "AAOI  260306P00090000",
                    "action": "BUY",
                    "quantity": 25,
                    "filled": 20,
                    "limit": 1.00
                }
            }

            result = handler.execute()

            assert result["complete_fills"] == 1
            assert result["completed"][0]["order_id"] == 5

    def test_disconnects_after_execution(self):
        """Handler disconnects from IB after execution."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls:
            mock_client = make_mock_client()
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler()
            handler.execute()

            mock_client.disconnect.assert_called_once()


class TestFillMonitorNotifications:
    """Test notification logic."""

    def test_sends_notification_on_fill(self):
        """Handler sends macOS notification on fill."""
        with patch('monitor_daemon.handlers.fill_monitor.IBClient') as mock_cls, \
             patch.object(FillMonitorHandler, '_send_notification') as mock_notify:
            mock_trade = MagicMock()
            mock_trade.order.orderId = 5
            mock_trade.order.action = "BUY"
            mock_trade.order.totalQuantity = 25
            mock_trade.order.lmtPrice = 1.00
            mock_trade.orderStatus.status = "Submitted"
            mock_trade.orderStatus.filled = 25
            mock_trade.orderStatus.remaining = 0
            mock_trade.orderStatus.avgFillPrice = 0.98
            mock_trade.contract.symbol = "AAOI"
            mock_trade.contract.localSymbol = "AAOI  260306P00090000"

            mock_client = make_mock_client(trades=[mock_trade])
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler()
            handler.known_orders = {5: {"filled": 0}}
            handler.execute()

            # Should have called notification method
            mock_notify.assert_called()


class TestFillMonitorJournalPersistence:
    """Detected fills must be mirrored to the Turso journal table inline.

    Today fills land only in self.known_orders (in-memory). A process
    restart between detection and the next journal_sync cycle drops the
    fill from the in-process cache; only Flex rehydrate recovers it.
    Mirror inline via db.writer.upsert_journal_entry.
    """

    def _make_partial_fill_trade(self):
        mock_trade = MagicMock()
        mock_trade.order.orderId = 5
        mock_trade.order.action = "BUY"
        mock_trade.order.totalQuantity = 25
        mock_trade.order.lmtPrice = 1.00
        mock_trade.orderStatus.status = "Submitted"
        mock_trade.orderStatus.filled = 10
        mock_trade.orderStatus.remaining = 15
        mock_trade.orderStatus.avgFillPrice = 0.98
        mock_trade.contract.symbol = "AAOI"
        mock_trade.contract.localSymbol = "AAOI  260306P00090000"
        return mock_trade

    def test_partial_fill_writes_to_journal(self):
        """A newly detected partial fill triggers upsert_journal_entry."""
        with patch("monitor_daemon.handlers.fill_monitor.IBClient") as mock_cls, \
             patch("monitor_daemon.handlers.fill_monitor.upsert_journal_entry") as mock_upsert:

            mock_trade = self._make_partial_fill_trade()
            mock_client = make_mock_client(trades=[mock_trade])
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler(send_notifications=False)
            handler.known_orders = {5: {"filled": 0}}

            result = handler.execute()

            assert result["partial_fills"] == 1
            mock_upsert.assert_called()
            # First positional arg = trade_id; payload follows.
            call_args = mock_upsert.call_args
            trade_id = call_args.args[0] if call_args.args else call_args.kwargs.get("trade_id")
            assert trade_id  # non-empty
            assert "5" in str(trade_id)  # contains order id

    def test_already_known_fill_does_not_rewrite(self):
        """Known fill (same total_filled) does NOT call upsert again."""
        with patch("monitor_daemon.handlers.fill_monitor.IBClient") as mock_cls, \
             patch("monitor_daemon.handlers.fill_monitor.upsert_journal_entry") as mock_upsert:

            mock_trade = self._make_partial_fill_trade()
            mock_client = make_mock_client(trades=[mock_trade])
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler(send_notifications=False)
            # Pretend we already saw the fill at total_filled=10
            handler.known_orders = {5: {"filled": 10}}

            result = handler.execute()

            assert result["partial_fills"] == 0
            mock_upsert.assert_not_called()

    def test_db_write_failure_does_not_crash_handler(self):
        """A DB upsert exception is logged but never propagates."""
        with patch("monitor_daemon.handlers.fill_monitor.IBClient") as mock_cls, \
             patch(
                 "monitor_daemon.handlers.fill_monitor.upsert_journal_entry",
                 side_effect=RuntimeError("turso write down"),
             ):

            mock_trade = self._make_partial_fill_trade()
            mock_client = make_mock_client(trades=[mock_trade])
            mock_cls.return_value = mock_client

            handler = FillMonitorHandler(send_notifications=False)
            handler.known_orders = {5: {"filled": 0}}

            # Should NOT raise even though the DB write fails.
            result = handler.execute()

            assert result["partial_fills"] == 1


class TestFillMonitorState:
    """Test state persistence for fill monitor."""

    def test_get_state_includes_known_orders(self):
        """get_state includes known_orders."""
        handler = FillMonitorHandler()
        handler.known_orders = {5: {"filled": 10, "symbol": "AAOI"}}

        state = handler.get_state()

        assert "known_orders" in state
        assert "5" in state["known_orders"] or 5 in state["known_orders"]

    def test_set_state_restores_known_orders(self):
        """set_state restores known_orders."""
        handler = FillMonitorHandler()

        handler.set_state({
            "last_run": "2026-03-04T10:00:00",
            "known_orders": {"5": {"filled": 10, "symbol": "AAOI"}}
        })

        assert 5 in handler.known_orders or "5" in handler.known_orders


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
