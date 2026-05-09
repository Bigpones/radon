"""Regression tests for `fetch_cash_transactions` IBKR Flex error handling.

Production incident 2026-05-09: the service-health banner showed
"Flex SendRequest did not return a ReferenceCode" — a generic message
that hides the real IBKR error. Hitting the Flex SendRequest endpoint
directly returned:

    <FlexStatementResponse>
      <Status>Fail</Status>
      <ErrorCode>1001</ErrorCode>
      <ErrorMessage>Statement could not be generated at this time.
                    Please try again shortly.</ErrorMessage>
    </FlexStatementResponse>

Two issues:
  1. The raised RuntimeError must surface IBKR's ErrorCode + ErrorMessage
     so an operator can act on it (transient vs auth vs config).
  2. Documented transient codes (1001, 1018, 1019) must trigger a bounded
     retry — the IBKR error message itself instructs "try again shortly".
"""
from __future__ import annotations

import io
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Make scripts/ importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from cash_flow_sync import fetch_cash_transactions  # noqa: E402


def _xml_response(body: str) -> MagicMock:
    """Mimic the file-like object urlopen returns."""
    resp = MagicMock()
    resp.read.return_value = body.encode("utf-8")
    return resp


FAIL_1001 = (
    "<FlexStatementResponse timestamp='09 May, 2026 04:21 PM EDT'>"
    "<Status>Fail</Status>"
    "<ErrorCode>1001</ErrorCode>"
    "<ErrorMessage>Statement could not be generated at this time. "
    "Please try again shortly.</ErrorMessage>"
    "</FlexStatementResponse>"
)

FAIL_1019 = (
    "<FlexStatementResponse>"
    "<Status>Warn</Status>"
    "<ErrorCode>1019</ErrorCode>"
    "<ErrorMessage>Statement generation in progress. Please try "
    "again shortly.</ErrorMessage>"
    "</FlexStatementResponse>"
)

FAIL_AUTH = (
    "<FlexStatementResponse>"
    "<Status>Fail</Status>"
    "<ErrorCode>1012</ErrorCode>"
    "<ErrorMessage>Token has expired.</ErrorMessage>"
    "</FlexStatementResponse>"
)

SUCCESS_REF = (
    "<FlexStatementResponse>"
    "<Status>Success</Status>"
    "<ReferenceCode>1234567890</ReferenceCode>"
    "<Url>https://example.com</Url>"
    "</FlexStatementResponse>"
)

SUCCESS_STMT = (
    "<FlexQueryResponse>"
    "<FlexStatements count='1'>"
    "<FlexStatement accountId='U123'>"
    "<CashTransactions>"
    "<CashTransaction transactionID='42' amount='100.00' "
    "type='Deposit' reportDate='20260509' currency='USD' "
    "description='ACH Deposit' />"
    "</CashTransactions>"
    "</FlexStatement>"
    "</FlexStatements>"
    "</FlexQueryResponse>"
)


class TestFlexErrorSurface:
    """Surface IBKR's actual error code + message instead of a generic."""

    def test_includes_error_code_in_exception(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            # Always return the same transient error so retries exhaust.
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(RuntimeError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            msg = str(excinfo.value)
            assert "1001" in msg, f"error code 1001 missing: {msg!r}"

    def test_includes_error_message_in_exception(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(RuntimeError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            msg = str(excinfo.value)
            assert "Statement could not be generated" in msg, (
                f"IBKR error message missing: {msg!r}"
            )

    def test_does_not_emit_generic_reference_code_message(self):
        """Regression: the old generic message hid the real IBKR error."""
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(RuntimeError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            msg = str(excinfo.value)
            assert "did not return a ReferenceCode" not in msg, (
                f"generic message regressed: {msg!r}"
            )

    def test_auth_failure_surfaces_real_message(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_AUTH)
            with pytest.raises(RuntimeError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            msg = str(excinfo.value)
            assert "1012" in msg
            assert "Token has expired" in msg


class TestTransientRetry:
    """Documented transient codes (1001, 1018, 1019) trigger a bounded retry."""

    def test_retries_on_1001_then_succeeds(self):
        # Two transient failures, then SendRequest succeeds, then GetStatement
        # returns the statement on the first poll.
        responses = [
            _xml_response(FAIL_1001),
            _xml_response(FAIL_1001),
            _xml_response(SUCCESS_REF),
            _xml_response(SUCCESS_STMT),
        ]
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.side_effect = responses
            rows = fetch_cash_transactions("tok", "qid", max_polls=5, poll_sleep=0)
            assert len(rows) == 1
            assert rows[0]["id"] == "42"
            # Three SendRequest hits + one GetStatement.
            assert mock_urlopen.call_count == 4

    def test_retries_on_1019_then_succeeds(self):
        responses = [
            _xml_response(FAIL_1019),
            _xml_response(SUCCESS_REF),
            _xml_response(SUCCESS_STMT),
        ]
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.side_effect = responses
            rows = fetch_cash_transactions("tok", "qid", max_polls=5, poll_sleep=0)
            assert len(rows) == 1

    def test_does_not_retry_on_auth_failure(self):
        """Auth/permission errors are NOT transient — fail fast."""
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_AUTH)
            with pytest.raises(RuntimeError):
                fetch_cash_transactions("tok", "qid")
            # Exactly ONE call — no retry on a non-transient failure.
            assert mock_urlopen.call_count == 1

    def test_retry_budget_is_bounded(self):
        """All transient failures: gives up after a fixed number of attempts."""
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(RuntimeError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            msg = str(excinfo.value)
            # Bounded: must not loop forever, and must include the IBKR code
            # so an operator can tell this was a transient that exhausted.
            assert "1001" in msg
            # 3 attempts total (initial + 2 retries) is the contract.
            assert mock_urlopen.call_count == 3
