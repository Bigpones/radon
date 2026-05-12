"""Catalog of `scheduled` services the watchdog tracks.

Mirrors web/lib/serviceHealthWindows.ts (only entries with
``category: "scheduled"``). A contract test in
``scripts/tests/test_watchdog/test_services.py`` reads the TS file via
regex and asserts both lists agree, so a future SOT drift between TS
and Python is caught by CI.

Each entry carries the open/closed freshness windows (in seconds) the
watchdog uses to decide whether a row is past-window. Numbers match the
TS source ms values divided by 1000.

Buckets group services by cadence so a single systemd timer fires the
right batch at the right interval:

 * ``intraday`` — market-hours-only writers; gate the timer to ET
   trading hours and re-check the gate in Python before firing.
 * ``continuous`` — always-on writers; the timer fires every 5 min,
   24/7.
 * ``daily`` — once-per-day writers; the timer fires hourly so any
   delay surfaces within 1h of the 25h window expiring.
 * ``error`` — orthogonal sweep; flags any scheduled service in
   ``state == 'error'`` past 2 consecutive cycles regardless of
   staleness.
"""
from __future__ import annotations

from typing import TypedDict

_MIN = 60
_HOUR = 60 * _MIN
_DAY = 24 * _HOUR


class FreshnessWindow(TypedDict):
    open: int
    closed: int


# Every scheduled service in web/lib/serviceHealthWindows.ts.
# Windows in seconds.
SCHEDULED_SERVICES: dict[str, FreshnessWindow] = {
    "newsfeed-scraper": {"open": 5 * _MIN, "closed": 5 * _MIN},
    "orders-sync":      {"open": 10 * _MIN, "closed": 3 * _DAY},
    "portfolio-sync":   {"open": 10 * _MIN, "closed": 3 * _DAY},
    "journal-sync":     {"open": 10 * _MIN, "closed": 10 * _MIN},
    "cash-flow-sync":   {"open": 25 * _HOUR, "closed": 25 * _HOUR},
    "fill-monitor":     {"open": 5 * _MIN, "closed": 1 * _HOUR},
    "exit-orders":      {"open": 5 * _MIN, "closed": 1 * _HOUR},
    "flex-token-check": {"open": 25 * _HOUR, "closed": 25 * _HOUR},
    "cri-scan":         {"open": 35 * _MIN, "closed": 1 * _DAY},
    "vcg-scan":         {"open": 15 * _MIN, "closed": 1 * _DAY},
    "cta-sync":         {"open": 25 * _HOUR, "closed": 72 * _HOUR},
    "replica-watchdog": {"open": 5 * _MIN, "closed": 5 * _MIN},
}


BUCKETS: dict[str, list[str]] = {
    "intraday": [
        "vcg-scan",
        "cri-scan",
        "orders-sync",
        "portfolio-sync",
    ],
    "continuous": [
        "newsfeed-scraper",
        "replica-watchdog",
        "fill-monitor",
        "exit-orders",
        "journal-sync",
    ],
    "daily": [
        "cash-flow-sync",
        "flex-token-check",
        "cta-sync",
    ],
    "error": list(SCHEDULED_SERVICES.keys()),
}


def freshness_window_for(service: str, market_state: str) -> int:
    """Seconds-of-staleness threshold for ``service`` under the given
    market state. Unknown services fall back to 1h (matches the TS
    default).
    """
    window = SCHEDULED_SERVICES.get(service)
    if window is None:
        return 1 * _HOUR
    return window["open"] if market_state == "open" else window["closed"]
