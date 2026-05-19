"""Root-cause-aware alert grouping for the watchdog.

When the FastAPI ``/health`` endpoint reports the IB Gateway session
is ``awaiting_2fa`` or ``unreachable``, the IB-dependent services
(vcg-scan, cri-scan, orders-sync, portfolio-sync, fill-monitor,
exit-orders, journal-sync) tend to go stale in the same cycle. Firing
N separate Pushover alerts trains the operator to mute the noise — the
single actionable signal is "approve the 2FA prompt on your phone."

This module groups those into ONE message when:

  1. ``/health.auth_state`` ∈ {``awaiting_2fa``, ``unreachable``}, AND
  2. ≥ 2 IB-dependent services fired in the current cycle.

Threshold-of-2 avoids over-reporting on a single transient blip; one
isolated stale on an IB service is more likely a one-off retry than a
gateway outage.

The ``service_health`` table is still written for each underlying
service via ``notify._emit_service_health`` so the dashboard banner
reflects the truth even when the push channel is grouped.

Discord is intentionally NOT touched here — a parallel agent is removing
Discord from the watchdog. Only Pushover is grouped.

Cooldown semantics: the grouped alert key is ``ib-gateway-grouped``
with severity ``P1``. ``cooldown.mark_notified`` + ``cooldown_allows_fire``
operate on this synthetic service name so repeated grouped fires
inside the 1h window are suppressed exactly like per-service alerts.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Iterable
from urllib import error as urllib_error
from urllib import request as urllib_request

from . import cooldown as cooldown_mod
from . import notify
from . import services as services_mod
from .check import CheckOutcome


log = logging.getLogger("watchdog.grouping")


GROUPED_ALERT_KEY = "ib-gateway-grouped"
GROUPED_ALERT_SEVERITY = "P1"
GROUPING_AUTH_STATES = frozenset({"awaiting_2fa", "unreachable"})
GROUPING_THRESHOLD = 2
HEALTH_URL = os.environ.get("RADON_HEALTH_URL", "http://127.0.0.1:8321/health")
HEALTH_TIMEOUT_S = 2.0


# ── /health probe ──────────────────────────────────────────────────

def fetch_health() -> dict:
    """Return ``{auth_state: <state>}`` from FastAPI ``/health``.

    Best-effort: any transport, HTTP, or JSON failure degrades to
    ``{auth_state: "unknown"}`` so callers can fall through to the
    per-service path. Tight timeout (2s) because we don't want a slow
    /health to delay alert dispatch on a 5-minute cadence.
    """
    try:
        req = urllib_request.Request(HEALTH_URL, method="GET")
        with urllib_request.urlopen(req, timeout=HEALTH_TIMEOUT_S) as resp:
            body = resp.read()
        data = json.loads(body or b"{}")
    except (urllib_error.URLError, urllib_error.HTTPError, OSError, ValueError, json.JSONDecodeError) as exc:
        log.warning("watchdog /health probe failed: %s", exc)
        return {"auth_state": "unknown"}
    # FastAPI shape: {"ib_gateway": {"auth_state": "..."}}
    ib_gateway = data.get("ib_gateway") if isinstance(data, dict) else None
    if isinstance(ib_gateway, dict):
        return {"auth_state": ib_gateway.get("auth_state") or "unknown"}
    # Some legacy shapes put auth_state at top level.
    if isinstance(data, dict) and "auth_state" in data:
        return {"auth_state": data.get("auth_state") or "unknown"}
    return {"auth_state": "unknown"}


# ── helpers ────────────────────────────────────────────────────────

def _ib_dependent(outcome: CheckOutcome) -> bool:
    return services_mod.requires_ib(outcome.service)


def _format_grouped_message(*, auth_state: str, services: list[str]) -> str:
    n = len(services)
    listing = ", ".join(sorted(services))
    return (
        f"IB Gateway {auth_state} — {n} services degraded "
        f"({listing}). Approve on phone or POST /ib/reset-backoff."
    )


# ── public entry point ────────────────────────────────────────────

def dispatch_with_grouping(*, outcomes: Iterable[CheckOutcome], now: datetime) -> None:
    """Replacement for the per-outcome dispatch loop in __main__.

    Walks ``outcomes``, partitions IB-dependent vs not, fetches
    /health to confirm the root cause, fires a single grouped Pushover
    if the threshold is met, and falls through to per-service dispatch
    for the rest. service_health rows write through normally for every
    outcome — only the Pushover channel is grouped.
    """
    fired = [o for o in outcomes if o.fired]
    if not fired:
        return

    ib_failing = [o for o in fired if _ib_dependent(o)]
    non_ib_failing = [o for o in fired if not _ib_dependent(o)]

    grouped_handled: set[str] = set()
    if len(ib_failing) >= GROUPING_THRESHOLD:
        # fetch_health is best-effort but a raised exception (test-double
        # or future bug) must not abort the whole dispatch — fall through
        # to per-service alerts in that case.
        try:
            health_payload = fetch_health() or {}
        except Exception as exc:  # noqa: BLE001 — protect alert dispatch
            log.warning("fetch_health raised: %s — falling back to per-service", exc)
            health_payload = {"auth_state": "unknown"}
        auth_state = health_payload.get("auth_state") or "unknown"
        if auth_state in GROUPING_AUTH_STATES:
            grouped_handled = _dispatch_grouped(
                ib_outcomes=ib_failing,
                auth_state=auth_state,
                now=now,
            )

    # Everything not absorbed into the grouped alert falls through to the
    # regular per-service path (service_health row + Pushover + cooldown).
    for outcome in fired:
        if outcome.service in grouped_handled:
            # Service_health row still needs to be written so the dashboard
            # banner sees the failure — we just skip the per-service push.
            notify._emit_service_health(outcome)
            continue
        if outcome.severity and not cooldown_mod.cooldown_allows_fire(
            service=outcome.service, severity=outcome.severity, now=outcome.now
        ):
            log.info("suppressed by cooldown (%s/%s)", outcome.service, outcome.severity)
            continue
        notify.dispatch(outcome)

    # No-op for non_ib_failing — they're handled by the loop above.
    _ = non_ib_failing


def _dispatch_grouped(
    *,
    ib_outcomes: list[CheckOutcome],
    auth_state: str,
    now: datetime,
) -> set[str]:
    """Send the single grouped Pushover; return the set of service
    names whose per-service push should be suppressed.

    Cooldown applies to the grouped key. If we're inside the cooldown
    window we skip the push but STILL return the suppression set —
    the grouped condition is active, we just don't spam the channel.
    """
    services = [o.service for o in ib_outcomes]

    if not cooldown_mod.cooldown_allows_fire(
        service=GROUPED_ALERT_KEY,
        severity=GROUPED_ALERT_SEVERITY,
        now=now,
    ):
        log.info("grouped IB alert suppressed by cooldown")
        return set(services)

    message = _format_grouped_message(auth_state=auth_state, services=services)
    title = f"radon watchdog: IB Gateway {auth_state}"
    _emit_grouped_pushover(title=title, message=message)

    cooldown_mod.mark_notified(
        service=GROUPED_ALERT_KEY,
        severity=GROUPED_ALERT_SEVERITY,
        now=now,
    )
    return set(services)


def _emit_grouped_pushover(*, title: str, message: str) -> None:
    creds = notify._pushover_creds()
    if not creds:
        return
    user, token = creds
    payload = {
        "token": token,
        "user": user,
        "title": title,
        "message": message,
        "priority": 1,
    }
    try:
        notify._http_post("https://api.pushover.net/1/messages.json", payload)
    except Exception as exc:  # pragma: no cover - transport failures
        log.warning("grouped pushover failed: %s", exc)
