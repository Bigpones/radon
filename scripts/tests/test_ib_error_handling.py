"""Tests for IBClient pacing & invalid contract error handling.

Red/Green TDD: tests written FIRST (RED phase), then implementation follows.
All tests mock ib_insync.IB — no real IB connection needed.
"""

from unittest.mock import MagicMock, patch

import pytest

from clients.ib_client import IBClient


# ---------------------------------------------------------------------------
# Pacing violations (codes 162, 366)
# ---------------------------------------------------------------------------


class TestPacingViolation:
    """Test exponential backoff for pacing violation errors."""

    @patch("clients.ib_client.IB")
    def test_pacing_162_tracked_in_retries(self, MockIB):
        """Error 162 should be tracked in _pacing_retries."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        client._on_error(1, 162, "Historical Market Data pacing violation")

        assert 1 in client._pacing_retries
        assert client._pacing_retries[1] == 1

    @patch("clients.ib_client.IB")
    def test_pacing_366_tracked_in_retries(self, MockIB):
        """Error 366 should be tracked in _pacing_retries."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        client._on_error(2, 366, "No historical data query found for ticker id:2")

        assert 2 in client._pacing_retries
        assert client._pacing_retries[2] == 1

    @patch("clients.ib_client.IB")
    def test_pacing_retries_increment_per_reqid(self, MockIB):
        """Multiple pacing errors for same reqId should increment count."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        client._on_error(5, 162, "pacing violation")
        client._on_error(5, 162, "pacing violation")
        client._on_error(5, 162, "pacing violation")

        assert client._pacing_retries[5] == 3

    @patch("clients.ib_client.IB")
    def test_pacing_max_retries_respected(self, MockIB):
        """After 3 retries, pacing errors should stop incrementing (capped)."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        # Fire 5 pacing errors for same reqId
        for _ in range(5):
            client._on_error(10, 162, "pacing violation")

        # Should cap at 3
        assert client._pacing_retries[10] == 3

    @patch("clients.ib_client.IB")
    def test_pacing_different_reqids_independent(self, MockIB):
        """Pacing retries should be tracked independently per reqId."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        client._on_error(1, 162, "pacing violation")
        client._on_error(1, 162, "pacing violation")
        client._on_error(2, 366, "pacing violation")

        assert client._pacing_retries[1] == 2
        assert client._pacing_retries[2] == 1


# ---------------------------------------------------------------------------
# Invalid contracts (codes 200, 354)
# ---------------------------------------------------------------------------


class TestInvalidContract:
    """Test invalid contract handling — no retry, add to failed set."""

    @patch("clients.ib_client.IB")
    def test_invalid_contract_200_added_to_failed(self, MockIB):
        """Error 200 should add contract to _failed_contracts."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        contract = MagicMock()
        contract.__str__ = lambda self: "AAPL OPT 20260320 200 C"
        client._on_error(1, 200, "No security definition found", contract)

        assert len(client._failed_contracts) == 1

    @patch("clients.ib_client.IB")
    def test_invalid_contract_354_added_to_failed(self, MockIB):
        """Error 354 should add contract to _failed_contracts."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        contract = MagicMock()
        client._on_error(2, 354, "Requested market data not subscribed", contract)

        assert len(client._failed_contracts) == 1

    @patch("clients.ib_client.IB")
    def test_invalid_contract_does_not_retry(self, MockIB):
        """Invalid contract errors should NOT be added to _pacing_retries."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        contract = MagicMock()
        client._on_error(1, 200, "No security definition found", contract)

        assert 1 not in client._pacing_retries

    @patch("clients.ib_client.IB")
    def test_failed_contracts_property(self, MockIB):
        """_failed_contracts should be a set accessible as property."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        assert isinstance(client.failed_contracts, set)
        assert len(client.failed_contracts) == 0

        contract = MagicMock()
        client._on_error(1, 200, "No security definition found", contract)

        assert len(client.failed_contracts) == 1

    @patch("clients.ib_client.IB")
    def test_multiple_invalid_contracts_all_tracked(self, MockIB):
        """Multiple different invalid contracts should all be in the set."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        c1 = MagicMock()
        c1.conId = 111
        c2 = MagicMock()
        c2.conId = 222

        client._on_error(1, 200, "No security definition found", c1)
        client._on_error(2, 354, "Not subscribed", c2)

        assert len(client.failed_contracts) == 2


# ---------------------------------------------------------------------------
# Error 10358 — verify existing handling not broken
# ---------------------------------------------------------------------------


class TestExistingErrorHandling:
    """Verify that existing error handling is not broken by new code."""

    @patch("clients.ib_client.IB")
    def test_error_10358_still_ignored(self, MockIB):
        """Error 10358 (Reuters) should still be silently ignored."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        # Should not raise, not add to failed contracts
        client._on_error(1, 10358, "Reuters Fundamentals subscription inactive")

        assert len(client.failed_contracts) == 0
        assert 1 not in client._pacing_retries

    @patch("clients.ib_client.IB")
    def test_info_codes_still_handled(self, MockIB):
        """Info codes (2104, 2106, etc.) should still be handled gracefully."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        # These should not raise or add to any tracking
        client._on_error(0, 2104, "Market data farm connection is OK")
        client._on_error(0, 2106, "HMDS data farm connection is OK")

        assert len(client.failed_contracts) == 0
        assert len(client._pacing_retries) == 0

    @patch("clients.ib_client.IB")
    def test_connectivity_codes_still_handled(self, MockIB):
        """Connectivity codes (1100, 1101, 1102) should still be handled."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        # Should not raise
        client._on_error(0, 1100, "Connectivity between IB and TWS has been lost")
        client._on_error(0, 1101, "Connectivity restored — data lost")
        client._on_error(0, 1102, "Connectivity restored — data maintained")

    @patch("clients.ib_client.IB")
    def test_last_error_still_stored_for_unknown_codes(self, MockIB):
        """Unknown error codes should still store in _last_error."""
        mock_ib = MockIB.return_value
        mock_ib.isConnected.return_value = True

        client = IBClient()
        client.connect(client_id=1)

        client._on_error(99, 999, "Some unknown error")
        assert client._last_error == (999, "Some unknown error")
