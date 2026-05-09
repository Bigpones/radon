"""Regression tests for timezone-aware `last_sync` writers.

Covers a HIGH-severity correctness bug:

* `scripts/ib_sync.py` previously wrote `last_sync` via `datetime.now().isoformat()`
  with no timezone offset. On Hetzner (UTC) the JS consumer
  (`web/lib/performanceFreshness.ts`) parses naive strings as local time,
  shifting the derived ET session date and triggering false-negative
  staleness checks.

* `scripts/portfolio_performance.py` derived `end_date` via `last_sync[:10]`.
  With the legacy producer that string slice was already wrong on Hetzner,
  baking the UTC-shifted date into Turso `performance_snapshots`. The helper
  here picks the ET calendar day explicitly.
"""

import json
import re
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent.parent))

import ib_sync
import portfolio_performance


ISO_OFFSET_RE = re.compile(r"([+-]\d{2}:\d{2}|Z)$")


class TestIbSyncLastSyncTimezone(unittest.TestCase):
    """`last_sync` must include a timezone offset so JS parses it correctly."""

    def _build_portfolio(self, tmpdir: Path) -> dict:
        portfolio_path = tmpdir / "portfolio.json"
        portfolio_path.write_text(json.dumps({"positions": []}))
        (tmpdir / "trade_log.json").write_text(json.dumps({"trades": []}))
        with patch.object(ib_sync, "PORTFOLIO_PATH", portfolio_path):
            return ib_sync.convert_to_portfolio_format(
                account={"NetLiquidation": 100000},
                collapsed_positions=[],
                pnl_data=None,
                fill_dates=None,
            )

    def test_last_sync_carries_timezone_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._build_portfolio(Path(tmp))
        last_sync = result["last_sync"]
        self.assertIsInstance(last_sync, str)
        self.assertRegex(
            last_sync,
            ISO_OFFSET_RE,
            msg=f"last_sync must include a tz offset (was: {last_sync!r})",
        )

    def test_last_sync_is_utc_aware(self):
        """Producer writes UTC; the offset proves Hetzner's wall clock is preserved."""
        with tempfile.TemporaryDirectory() as tmp:
            result = self._build_portfolio(Path(tmp))
        parsed = datetime.fromisoformat(result["last_sync"])
        self.assertIsNotNone(parsed.tzinfo)
        # UTC offset == zero — equivalent forms `+00:00` from datetime.now(utc).
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)


class TestPortfolioPerformanceEndDate(unittest.TestCase):
    """`portfolio_performance._last_sync_to_et_date` must derive the ET day
    correctly for naive UTC, tz-aware UTC, and tz-aware ET inputs."""

    def test_naive_utc_after_et_midnight_resolves_to_prior_et_day(self):
        # Legacy producer: naive ISO. Treated as UTC; ET is one day earlier.
        self.assertEqual(
            portfolio_performance._last_sync_to_et_date("2026-05-09T01:58:36.144211"),
            "2026-05-08",
        )

    def test_utc_aware_after_et_midnight_resolves_to_prior_et_day(self):
        # New producer (`datetime.now(timezone.utc).isoformat()`).
        self.assertEqual(
            portfolio_performance._last_sync_to_et_date("2026-05-09T01:58:36.144211+00:00"),
            "2026-05-08",
        )

    def test_zulu_suffix_supported(self):
        self.assertEqual(
            portfolio_performance._last_sync_to_et_date("2026-05-09T01:58:36Z"),
            "2026-05-08",
        )

    def test_et_aware_kept_as_is(self):
        # Laptop in ET writing tz-aware iso → no shift.
        self.assertEqual(
            portfolio_performance._last_sync_to_et_date("2026-05-08T21:58:36-04:00"),
            "2026-05-08",
        )

    def test_empty_returns_none(self):
        self.assertIsNone(portfolio_performance._last_sync_to_et_date(""))


if __name__ == "__main__":
    unittest.main()
