"""Contract tests for the Python service list.

The watchdog hard-codes the scheduled services in scripts/watchdog/services.py
to avoid parsing TS at runtime. This test cross-references the canonical
TS source (web/lib/serviceHealthWindows.ts) and asserts both lists agree,
so a future SOT drift between TS and Python is caught by CI.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_TS_FILE = _PROJECT_ROOT / "web" / "lib" / "serviceHealthWindows.ts"


def _ts_scheduled_services() -> set[str]:
    """Parse web/lib/serviceHealthWindows.ts and return the set of
    service names whose category === "scheduled".
    """
    text = _TS_FILE.read_text(encoding="utf-8")
    # Match: "service-name": { ... category: "scheduled" ... }
    pattern = re.compile(
        r'"([a-z][a-z0-9\-]*)"\s*:\s*\{[^}]*category:\s*"scheduled"',
        re.MULTILINE | re.DOTALL,
    )
    return set(pattern.findall(text))


class TestServiceCatalogContract:
    def test_python_lists_every_scheduled_ts_service(self):
        from watchdog import services as svc_mod

        ts_set = _ts_scheduled_services()
        py_set = set(svc_mod.SCHEDULED_SERVICES.keys())
        missing_in_py = ts_set - py_set
        assert not missing_in_py, (
            f"TS has scheduled services not in Python list: {sorted(missing_in_py)}. "
            "Add them to scripts/watchdog/services.py SCHEDULED_SERVICES."
        )

    def test_python_does_not_track_non_scheduled_services(self):
        from watchdog import services as svc_mod

        ts_set = _ts_scheduled_services()
        py_set = set(svc_mod.SCHEDULED_SERVICES.keys())
        extra_in_py = py_set - ts_set
        assert not extra_in_py, (
            f"Python lists services that aren't 'scheduled' in TS: {sorted(extra_in_py)}."
        )

    def test_every_service_has_window_data(self):
        from watchdog import services as svc_mod

        for name, window in svc_mod.SCHEDULED_SERVICES.items():
            assert "open" in window and isinstance(window["open"], int), name
            assert "closed" in window and isinstance(window["closed"], int), name
            assert window["open"] > 0, name
            assert window["closed"] > 0, name


class TestBuckets:
    def test_intraday_bucket_lists_market_hours_services(self):
        from watchdog import services as svc_mod

        intraday = set(svc_mod.BUCKETS["intraday"])
        assert "vcg-scan" in intraday
        assert "cri-scan" in intraday
        assert "orders-sync" in intraday
        assert "portfolio-sync" in intraday

    def test_continuous_bucket_lists_always_on_services(self):
        from watchdog import services as svc_mod

        cont = set(svc_mod.BUCKETS["continuous"])
        assert "newsfeed-scraper" in cont
        assert "replica-watchdog" in cont
        assert "fill-monitor" in cont
        assert "exit-orders" in cont
        assert "journal-sync" in cont

    def test_daily_bucket_lists_daily_services(self):
        from watchdog import services as svc_mod

        daily = set(svc_mod.BUCKETS["daily"])
        assert "cash-flow-sync" in daily
        assert "flex-token-check" in daily

    def test_error_bucket_lists_every_scheduled_service_except_self_meta(self):
        from watchdog import services as svc_mod

        # watchdog-alerts is the meta-row the watchdog writes to when
        # alerting on OTHER services. Including it in the error bucket
        # would create a recursive alerting loop (alert about an alert
        # row, which then triggers another alert, etc). Every other
        # scheduled service should be in the error bucket.
        error_bucket = set(svc_mod.BUCKETS["error"])
        expected = set(svc_mod.SCHEDULED_SERVICES.keys()) - {"watchdog-alerts"}
        assert error_bucket == expected
        assert "watchdog-alerts" not in error_bucket

    def test_no_unknown_buckets(self):
        from watchdog import services as svc_mod

        assert set(svc_mod.BUCKETS.keys()) == {"intraday", "continuous", "daily", "error"}
