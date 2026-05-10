#!/usr/bin/env python3
"""Throttle-aware exponential backoff for Flex Web Service polling.

IBKR Flex Web Service uses a sliding-window rate limit. **Every request
during throttle — including failures — pushes the reset further out.**
The cure is to back off aggressively on documented throttle codes
(1001 / 1018 / 1019) and refuse to probe again until the window clears.

State machine:

    success      → counter reset to 0, no embargo.
    throttle hit → counter++; embargo = THROTTLE_EMBARGO[counter-1].
    transient    → no escalation; embargo = SOFT_EMBARGO_SECS (one cycle).

Embargo schedule (capped at 168h / one week):

    1st throttle:  24h
    2nd throttle:  48h
    3rd throttle:  72h
    4th+ throttle: 168h

Stored as a plain dict so the calling handler can persist it via
``BaseHandler.get_state`` / ``set_state`` and survive daemon restarts.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional


# Embargo durations in seconds, indexed by (counter - 1). The last entry
# is the cap that all further attempts use.
THROTTLE_EMBARGO_SECS = (
    24 * 60 * 60,    # 24h after 1st throttle
    48 * 60 * 60,    # 48h after 2nd
    72 * 60 * 60,    # 72h after 3rd
    168 * 60 * 60,   # 168h (1 week) cap
)

# A non-throttle transient (network blip, parse error) does not escalate.
# Daily handlers re-fire the next 17:00 ET window — short embargo only.
SOFT_EMBARGO_SECS = 0


class FlexThrottleError(RuntimeError):
    """Raised when IBKR returns a documented throttle code (1001/1018/1019).

    The daemon handler intercepts this specifically to advance the
    circuit breaker without retrying — every retry burns the
    sliding-window budget and resets the throttle clock.
    """

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"Flex throttle (code {code}): {message}")


def initial_state() -> Dict[str, Any]:
    """Return a fresh, empty backoff state."""
    return {"throttle_count": 0, "blocked_until": None}


def _embargo_seconds_for(count: int) -> int:
    if count <= 0:
        return 0
    idx = min(count - 1, len(THROTTLE_EMBARGO_SECS) - 1)
    return THROTTLE_EMBARGO_SECS[idx]


def record_throttle(state: Dict[str, Any], *, now_utc: datetime) -> Dict[str, Any]:
    """Advance the throttle counter and compute the next eligible time."""
    count = int(state.get("throttle_count") or 0) + 1
    embargo = _embargo_seconds_for(count)
    return {
        "throttle_count": count,
        "blocked_until": (now_utc + timedelta(seconds=embargo)).isoformat(),
    }


def record_success(state: Dict[str, Any]) -> Dict[str, Any]:
    """Reset on a successful sync."""
    return initial_state()


def record_soft_failure(state: Dict[str, Any], *, now_utc: datetime) -> Dict[str, Any]:
    """Network blip / parse error — do not escalate, do not embargo.

    Returns a copy with throttle_count preserved and `blocked_until`
    cleared. The handler's daily window will retry at the next 17:00 ET.
    """
    return {
        "throttle_count": int(state.get("throttle_count") or 0),
        "blocked_until": None,
    }


def is_blocked(state: Dict[str, Any], *, now_utc: datetime) -> bool:
    """True iff `now_utc` is before the recorded `blocked_until`."""
    raw = state.get("blocked_until")
    if not raw:
        return False
    try:
        until = datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return False
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return now_utc < until


def blocked_until(state: Dict[str, Any]) -> Optional[datetime]:
    """Return the parsed `blocked_until` datetime, or None."""
    raw = state.get("blocked_until")
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed
