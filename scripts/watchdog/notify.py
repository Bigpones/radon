"""Notification dispatcher.

This module routes ``CheckOutcome`` alerts to enabled channels
(Pushover today; service_health table always-on heartbeat).

Service-health row contract (dispatcher health, not alert content)
==================================================================

The ``service_health`` row named ``watchdog-alerts`` reflects DISPATCHER
HEALTH ONLY — i.e. "can the notifier reach its channels and persist
its own bookkeeping." It does NOT mirror the kind or severity of the
last alert dispatched.

Why: a banner row whose state mirrors the last alert latches at
``error`` until another alert with different severity fires. If the
downstream service recovers between watchdog cycles (the common case),
no ``healed`` event fires and the row stays ``error`` indefinitely.
The dashboard reads ``last_error`` and surfaces stale alert detail as
a current outage — long after recovery. Same anti-pattern as
``feedback_banner_only_actionable.md``.

Where to find the alert event itself: ``logging.getLogger("watchdog.notify")``
emits an INFO line on every dispatch with structured fields
(service, severity, kind, message). On Hetzner that lands in
``journalctl -u radon-watchdog-*.service`` and on the laptop in stderr.

The row only flips to ``state=error`` when:
  - Pushover returns a non-2xx code (channel transport failure)
  - ``record_service_health`` itself raises (DB write failure)

In both cases ``last_error`` carries a dispatcher-specific string
(``"pushover 500: …"``, ``"db write failed: …"``) so the banner
surfaces a real, actionable notifier outage — not stale alert history.

Severity routing for the Pushover channel
==========================================

 * P1 → Pushover (if configured)
 * P2 → service_health heartbeat only
 * P3 → service_health heartbeat only

If no external channel is configured a one-line warning prints on
startup so the operator notices alerts will only land in the table.
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


def _log_alert_event(outcome: CheckOutcome) -> None:
    """Emit a structured INFO line to journalctl/stderr so the alert
    event remains discoverable after we stopped recording it in
    ``service_health.last_error``. Keep this terse — operators grep
    journalctl with ``service`` + ``severity`` keys.
    """
    log.info(
        "dispatched alert service=%s severity=%s kind=%s consecutive_failures=%d message=%s",
        outcome.service,
        outcome.severity or "",
        outcome.kind,
        outcome.consecutive_failures,
        outcome.message,
    )


def _emit_pushover(outcome: CheckOutcome) -> Optional[str]:
    """P1 only — cuts through iOS DnD. Returns a dispatcher error
    string on failure, ``None`` on success or when this channel is
    not applicable (non-P1, no creds).
    """
    if outcome.severity != "P1":
        return None
    creds = _pushover_creds()
    if not creds:
        return None
    user, token = creds
    payload = {
        "token": token,
        "user": user,
        "title": f"radon watchdog: {outcome.service}",
        "message": outcome.message,
        "priority": 1,
    }
    try:
        status, body = _http_post("https://api.pushover.net/1/messages.json", payload)
    except Exception as exc:  # noqa: BLE001 — channel transport failures must surface
        log.warning("pushover transport failure: %s", exc)
        return f"pushover transport failed: {exc}"
    if status >= 400:
        log.warning("pushover non-2xx (%s): %r", status, body[:200])
        return f"pushover {status}: {body[:200].decode('utf-8', 'replace').strip() or 'no body'}"
    return None


def _write_dispatcher_health(
    *,
    now,
    dispatcher_error: Optional[str],
    bucket: Optional[str] = None,
) -> None:
    """Single source of truth for the ``watchdog-alerts`` row.

    Writes ``state=ok`` with empty ``last_error`` when the dispatcher
    succeeded; writes ``state=error`` with the dispatcher's failure
    string when something the notifier itself controls broke (channel
    5xx, DB write, etc).

    Never writes downstream alert content. Best-effort: a DB failure
    while recording dispatcher health is logged but does not raise —
    the bucket cycle must complete.
    """
    from db.writer import record_service_health  # local import — fixture reloads

    finished_at = now.isoformat().replace("+00:00", "Z") if hasattr(now, "isoformat") else None
    state = "error" if dispatcher_error else "ok"
    error_payload: Optional[dict[str, Any]] = None
    if dispatcher_error:
        error_payload = {"dispatcher_error": dispatcher_error}
    elif bucket:
        # Heartbeat-only payload is structurally distinct from the legacy
        # alert payload (no service/severity/kind keys) so the dashboard
        # can ignore it without a regex check.
        error_payload = {"heartbeat_at": finished_at, "bucket": bucket}

    try:
        record_service_health(
            "watchdog-alerts",
            state,
            finished_at=finished_at,
            error=error_payload,
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must not kill the cycle
        log.warning("watchdog-alerts row write failed: %s", exc)


def heartbeat_ok(*, bucket: str, now) -> None:
    """Write ``watchdog-alerts=ok`` on a quiet cycle (no alerts fired).

    Kept as a public seam — ``__main__._cmd_bucket`` calls this when
    the bucket dispatched nothing. The error path lives in
    ``_write_dispatcher_health`` and is reached via ``dispatch`` /
    ``dispatch_with_grouping``.
    """
    _write_dispatcher_health(now=now, dispatcher_error=None, bucket=bucket)


# ── public entry point ─────────────────────────────────────────────

def dispatch(outcome: CheckOutcome) -> None:
    """Route ``outcome`` to every enabled channel matching its
    severity, then stamp the cooldown row.

    Callers should pre-check ``cooldown_allows_fire()``; ``dispatch``
    does NOT skip on cooldown so end-to-end tests can verify channel
    dispatch directly.

    Writes a dispatcher-health row reflecting whether the dispatch
    itself succeeded. Downstream alert content goes to journalctl via
    ``_log_alert_event``, never into ``service_health.last_error``.
    """
    if not outcome.fired:
        return

    _log_alert_event(outcome)
    dispatcher_error = _emit_pushover(outcome)
    _write_dispatcher_health(now=outcome.now, dispatcher_error=dispatcher_error)

    if outcome.severity:
        cooldown_mod.mark_notified(
            service=outcome.service,
            severity=outcome.severity,
            now=outcome.now,
        )
