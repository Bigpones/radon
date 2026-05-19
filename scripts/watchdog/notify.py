"""Notification channels.

Pluggable — each channel is enabled iff its env vars are present at
runtime. An always-on ``service_health`` channel writes a
``watchdog-alerts`` row so the dashboard banner reflects active alerts
even with no external channel configured.

Severity routing:

 * P1 → Pushover (if configured) + service_health
 * P2 → service_health
 * P3 → service_health

If no external channel is configured, only `service_health` fires and
a one-line warning prints on startup so the operator notices.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

from .check import CheckOutcome
from . import cooldown as cooldown_mod


log = logging.getLogger("watchdog.notify")


# ── env-driven channel registry ─────────────────────────────────────

def _pushover_creds() -> Optional[tuple[str, str]]:
    user = os.environ.get("PUSHOVER_USER")
    token = os.environ.get("PUSHOVER_TOKEN")
    return (user, token) if user and token else None


def _resend_creds() -> Optional[tuple[str, str]]:
    api_key = os.environ.get("RESEND_API_KEY")
    to = os.environ.get("WATCHDOG_EMAIL_TO")
    return (api_key, to) if api_key and to else None


def enabled_channels() -> set[str]:
    channels = {"service_health"}
    if _pushover_creds():
        channels.add("pushover")
    if _resend_creds():
        channels.add("resend")
    return channels


def log_startup_warning() -> None:
    channels = enabled_channels()
    external = channels - {"service_health"}
    if not external:
        sys.stderr.write(
            "[watchdog] warning: no external notification channel configured "
            "(set PUSHOVER_USER+PUSHOVER_TOKEN). "
            "Alerts will only land in the service_health table.\n"
        )
    else:
        sys.stderr.write(f"[watchdog] channels enabled: {sorted(channels)}\n")


# ── HTTP seam (mocked in tests) ─────────────────────────────────────

def _http_post(url: str, payload: dict, headers: Optional[dict] = None) -> tuple[int, bytes]:
    """Thin urllib wrapper so tests can monkeypatch a single function.
    Returns (status_code, body). Raises on transport-level failure.
    """
    data = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib_request.Request(url, data=data, headers=req_headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib_error.HTTPError as exc:
        return exc.code, exc.read() if hasattr(exc, "read") else b""


# ── per-channel emitters ────────────────────────────────────────────

_EMOJI = {"P1": "🚨", "P2": "❌", "P3": "⚠️"}


def _format_summary(outcome: CheckOutcome) -> str:
    emoji = _EMOJI.get(outcome.severity or "", "")
    sev = outcome.severity or ""
    return f"{emoji} [{sev}] `{outcome.service}` — {outcome.message}"


def _emit_pushover(outcome: CheckOutcome) -> None:
    """P1 only — cuts through iOS DnD. Skip everything else."""
    if outcome.severity != "P1":
        return
    creds = _pushover_creds()
    if not creds:
        return
    user, token = creds
    payload = {
        "token": token,
        "user": user,
        "title": f"radon watchdog: {outcome.service}",
        "message": outcome.message,
        "priority": 1,
    }
    try:
        _http_post("https://api.pushover.net/1/messages.json", payload)
    except Exception as exc:  # pragma: no cover
        log.warning("pushover failed: %s", exc)


def _emit_service_health(outcome: CheckOutcome) -> None:
    """Always-on. Writes a `watchdog-alerts` row so the dashboard banner
    surfaces the alert too.
    """
    from db.writer import record_service_health  # local import — fixture reloads

    record_service_health(
        "watchdog-alerts",
        "error",
        finished_at=outcome.now.isoformat().replace("+00:00", "Z"),
        error={
            "service": outcome.service,
            "severity": outcome.severity,
            "kind": outcome.kind,
            "message": outcome.message,
            "consecutive_failures": outcome.consecutive_failures,
        },
    )


def heartbeat_ok(*, bucket: str, now) -> None:
    """Write `watchdog-alerts=ok` when a bucket cycle dispatched nothing.

    Without this, a single fired alert latches the row at `state=error`
    indefinitely — every subsequent quiet cycle leaves the stale error
    row visible in the banner. Mirrors the heartbeat-on-success pattern
    documented in `feedback_service_health_heartbeat.md` and applied to
    `replica-watchdog` and `newsfeed-scraper`.

    Best-effort: telemetry failures are logged, never raised.
    """
    from db.writer import record_service_health  # local import — fixture reloads

    finished_at = now.isoformat().replace("+00:00", "Z") if hasattr(now, "isoformat") else None
    try:
        record_service_health(
            "watchdog-alerts",
            "ok",
            finished_at=finished_at,
            error={"heartbeat_at": finished_at, "bucket": bucket},
        )
    except Exception as exc:  # noqa: BLE001 — telemetry failure must not kill cycle
        log.warning("watchdog-alerts heartbeat failed: %s", exc)


# ── public entry point ─────────────────────────────────────────────

def dispatch(outcome: CheckOutcome) -> None:
    """Route ``outcome`` to every enabled channel matching its
    severity, then stamp the cooldown row.

    Callers should pre-check ``cooldown_allows_fire()``; ``dispatch``
    does NOT skip on cooldown so end-to-end tests can verify channel
    dispatch directly.
    """
    if not outcome.fired:
        return

    _emit_service_health(outcome)
    _emit_pushover(outcome)

    if outcome.severity:
        cooldown_mod.mark_notified(
            service=outcome.service,
            severity=outcome.severity,
            now=outcome.now,
        )
