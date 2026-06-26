"""Regression tests for `fetch_cash_transactions` IBKR Flex error handling.

Production incidents:

  2026-05-09 (#1): the service-health banner showed "Flex SendRequest
  did not return a ReferenceCode" — a generic message that hid the
  real IBKR error. Now we surface IBKR's ErrorCode + ErrorMessage so
  an operator can tell transient from auth from config.

  2026-05-09 (#2): the daemon's 4h cadence with internal 3-attempt
  retries (12 hits/day) perpetuated a Flex sliding-window throttle
  for ~24h. Every retry on a throttle code (1001/1018/1019) pushes
  the reset further out — so the script must NOT retry internally
  on those codes. It raises FlexThrottleError on the first hit and
  the handler decides when to try again (typically tomorrow at
  17:00 ET via the throttle-aware circuit breaker).

  Other transient failures (network blip, parse error) still allow
  ONE bounded retry within the call.
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
from monitor_daemon.handlers._throttle_backoff import FlexThrottleError  # noqa: E402


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


FAIL_1018 = (
    "<FlexStatementResponse>"
    "<Status>Fail</Status>"
    "<ErrorCode>1018</ErrorCode>"
    "<ErrorMessage>Too many requests have been made from this token. "
    "Please try again shortly.</ErrorMessage>"
    "</FlexStatementResponse>"
)


class TestFlexErrorSurface:
    """Surface IBKR's actual error code + message instead of a generic."""

    def test_includes_error_code_in_exception(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(FlexThrottleError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            msg = str(excinfo.value)
            assert "1001" in msg, f"error code 1001 missing: {msg!r}"

    def test_includes_error_message_in_exception(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(FlexThrottleError) as excinfo:
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
            with pytest.raises(FlexThrottleError) as excinfo:
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


class TestThrottleNoInternalRetry:
    """Codes 1001 / 1018 / 1019 must NOT trigger an internal retry —
    every retry burns the sliding-window throttle budget further. The
    daemon handler will back off via its circuit breaker instead."""

    def test_1001_raises_flex_throttle_error_immediately(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep") as mock_sleep:
            mock_urlopen.return_value = _xml_response(FAIL_1001)
            with pytest.raises(FlexThrottleError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            assert excinfo.value.code == "1001"
            # Exactly ONE call — no internal retry on a throttle code.
            assert mock_urlopen.call_count == 1
            # And we slept zero times — no waiting either.
            mock_sleep.assert_not_called()

    def test_1018_raises_flex_throttle_error_immediately(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep") as mock_sleep:
            mock_urlopen.return_value = _xml_response(FAIL_1018)
            with pytest.raises(FlexThrottleError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            assert excinfo.value.code == "1018"
            assert mock_urlopen.call_count == 1
            mock_sleep.assert_not_called()

    def test_1019_raises_flex_throttle_error_immediately(self):
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep") as mock_sleep:
            mock_urlopen.return_value = _xml_response(FAIL_1019)
            with pytest.raises(FlexThrottleError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            assert excinfo.value.code == "1019"
            assert mock_urlopen.call_count == 1
            mock_sleep.assert_not_called()

    def test_throttle_error_is_runtime_error_subclass(self):
        """Existing callers that catch RuntimeError still work."""
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_1018)
            with pytest.raises(RuntimeError):
                fetch_cash_transactions("tok", "qid")


class TestNonThrottleFailures:
    """Non-throttle errors keep their existing semantics."""

    def test_does_not_retry_on_auth_failure(self):
        """Auth/permission errors are NOT transient — fail fast."""
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.return_value = _xml_response(FAIL_AUTH)
            with pytest.raises(RuntimeError) as excinfo:
                fetch_cash_transactions("tok", "qid")
            # Auth failures must NOT be FlexThrottleError — that would
            # advance the circuit breaker incorrectly.
            assert not isinstance(excinfo.value, FlexThrottleError)
            assert mock_urlopen.call_count == 1

    def test_network_error_retried_at_most_once(self):
        """A network blip is NOT a throttle — bounded single retry is fine."""
        from urllib.error import URLError

        side_effects = [
            URLError("connection reset"),
            _xml_response(SUCCESS_REF),
            _xml_response(SUCCESS_STMT),
        ]
        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.side_effect = side_effects
            rows = fetch_cash_transactions("tok", "qid", max_polls=5, poll_sleep=0)
            assert len(rows) == 1
            # Exactly 3: 1 failed + 1 retry SendRequest + 1 GetStatement.
            assert mock_urlopen.call_count == 3

    def test_persistent_network_error_fails_after_one_retry(self):
        """If both attempts fail with network errors, raise — don't loop."""
        from urllib.error import URLError

        with patch("cash_flow_sync.urlopen") as mock_urlopen, \
             patch("cash_flow_sync.time.sleep"):
            mock_urlopen.side_effect = URLError("connection reset")
            with pytest.raises(Exception):
                fetch_cash_transactions("tok", "qid")
            # 2 attempts total (initial + 1 retry).
            assert mock_urlopen.call_count == 2
