"""Shared helpers that guard ``ib_insync`` consumers from 2FA-pending hangs.

``ib_insync`` has no per-request timeout. When IB Gateway is logged in but
the IBKR user session is awaiting 2FA, ``connectAsync`` /
``qualifyContractsAsync`` / ``reqHistoricalDataAsync`` / ``reqMktData`` block
forever — TCP connect succeeds, but every data request hangs.

Two safety nets work together:

1. **Pre-auth check** (``assert_ib_authenticated`` / ``ib_auth_state``)
   probes the FastAPI ``/health`` endpoint and short-circuits the IB path
   before the caller creates a single contract. ``/health`` unreachable
   falls through optimistically — the per-request timeout below is the
   real safety net.

2. **Per-request timeout.** Callers wrap every ``await ib.<method>(...)``
   in ``asyncio.wait_for(..., timeout=IB_REQUEST_TIMEOUT_S)``. The
   ``IBRequestTimeout`` exception carries the gateway's auth_state (when
   reachable) so logs explain *why* the request stalled.

The constants are intentionally generous vs normal ~1-3s latency but well
below typical subprocess budgets (60-120s).
"""
from __future__ import annotations

import json
from typing import Optional

# Conservative per-request bound. 15s is comfortably above normal latency
# but short enough that subprocess wrappers (60-120s budgets) can still
# fall back to UW/Yahoo before the watchdog flags them stale.
IB_REQUEST_TIMEOUT_S: int = 15

# 30s suits ``reqHistoricalDataAsync`` which is legitimately slower (1Y
# daily bars over a slow Gateway link can take 5-10s).
IB_HISTORICAL_TIMEOUT_S: int = 30

# FastAPI ``/health`` settings. Unreachable health does NOT block IB —
# the caller proceeds optimistically and relies on the per-request bound.
FASTAPI_HEALTH_URL: str = "http://127.0.0.1:8321/health"
FASTAPI_HEALTH_TIMEOUT_S: float = 3.0


class IBPreflightError(Exception):
    """Raised when the pre-auth check decides we should not contact IB."""

    def __init__(self, auth_state: str, message: Optional[str] = None) -> None:
        self.auth_state = auth_state
        super().__init__(message or f"IB Gateway auth_state={auth_state}")


class IBRequestTimeout(Exception):
    """Raised when an ``ib_insync`` await exceeds its ``wait_for`` bound.

    Carries the gateway's ``auth_state`` (when reachable) so the caller can
    distinguish "Gateway is alive, network is slow" from "Gateway is
    sitting at the 2FA push prompt — every request will hang".
    """

    def __init__(
        self,
        method: str,
        timeout_s: float,
        auth_state: Optional[str] = None,
    ) -> None:
        self.method = method
        self.timeout_s = timeout_s
        self.auth_state = auth_state
        suffix = f" (auth_state={auth_state})" if auth_state else ""
        super().__init__(
            f"ib_insync {method} timed out after {timeout_s}s{suffix}"
        )


def ib_auth_state(timeout: float = FASTAPI_HEALTH_TIMEOUT_S) -> Optional[str]:
    """Return the gateway's ``auth_state`` from FastAPI ``/health``.

    Returns ``None`` when the endpoint is unreachable — callers should
    treat that as "proceed optimistically; rely on the per-request
    timeout for safety."

    ``urlopen`` is imported lazily so test suites can patch
    ``urllib.request.urlopen`` after this module is loaded.
    """
    from urllib.request import Request, urlopen
    try:
        req = Request(FASTAPI_HEALTH_URL, headers={"User-Agent": "ib_preflight"})
        with urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return (payload.get("ib_gateway") or {}).get("auth_state")
    except Exception:
        return None


def assert_ib_authenticated(timeout: float = FASTAPI_HEALTH_TIMEOUT_S) -> None:
    """Raise :class:`IBPreflightError` if the gateway is not authenticated.

    Unreachable ``/health`` falls through silently — the per-request
    timeout is the real safety net.
    """
    state = ib_auth_state(timeout=timeout)
    if state and state != "authenticated":
        raise IBPreflightError(
            state,
            f"IB Gateway auth_state={state}; refusing to make IB calls "
            f"(would hang). Fall back to UW/Cboe/Yahoo.",
        )


__all__ = [
    "IB_REQUEST_TIMEOUT_S",
    "IB_HISTORICAL_TIMEOUT_S",
    "IBPreflightError",
    "IBRequestTimeout",
    "ib_auth_state",
    "assert_ib_authenticated",
]
