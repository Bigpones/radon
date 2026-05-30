"""Tier-3 OFF-BOX prober: GET the public edge, classify, UPSERT to Turso.

stdlib-only by contract (see package docstring). The pure parse/classify/
row-construction logic is broken out so it is testable without sockets:

  * probe_endpoint()       — bounded urllib GET -> raw probe dict (one HTTP call)
  * classify_probes()      — combine ping + status probes -> ok/detail
  * build_probe_row()      — assemble the external_probe UPSERT row
  * run_probe()            — orchestrate: probe both, classify, write (impure)

Usage (off-box, e.g. GitHub Actions):
    TURSO_DB_URL=... TURSO_AUTH_TOKEN=... python -m health_probe.probe

Exit code is 0 once the row is written, regardless of whether the edge was
healthy — a Tier-3 prober that exits non-zero on an unhealthy edge would mark
its OWN scheduled run as failed and hide the very signal it exists to record.
It exits non-zero ONLY when it could not write to Turso (no point pretending).
"""
from __future__ import annotations

import errno
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from health_probe.turso_http import TursoHttpError, upsert_external_probe

# Identity recorded in external_probe.source. Stable so the row UPSERTs in
# place and the dead-man's-switch reader can look it up by name.
PROBE_SOURCE = os.environ.get("EXTERNAL_PROBE_SOURCE", "github-actions/edge")

EDGE_BASE = os.environ.get("EXTERNAL_PROBE_EDGE_BASE", "https://app.radon.run")
PING_PATH = "/edge-health/ping"
STATUS_PATH = "/edge-health/status"

# Bounded so a hung edge can't wedge the runner. GH cron already lags; keep the
# whole probe comfortably under a minute even with both endpoints retried once.
HTTP_TIMEOUT_SECONDS = 8.0
MAX_RESPONSE_BYTES = 65536


def _now_iso() -> str:
    """ISO-8601 UTC, second precision, trailing Z. The dead-man's-switch input."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _classify_transport_error(exc: Exception) -> str:
    """Map a transport failure to a short machine-readable reason. A timeout or
    unreachable host is NOT proof the box is down (could be a runner-side blip),
    but for the OUTERMOST ring we still record ok=0 — the edge did not answer."""
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, ConnectionRefusedError):
        return "refused"
    if getattr(exc, "errno", None) == errno.ECONNREFUSED:
        return "refused"
    return "unreachable"


def probe_endpoint(url: str, timeout: float = HTTP_TIMEOUT_SECONDS) -> dict:
    """GET one URL with a bounded timeout. Returns a raw probe dict:

      reachable=True  -> {reachable, http_status, latency_ms, payload}
      reachable=False -> {reachable, http_status?, latency_ms?, detail}

    An HTTP error response (4xx/5xx) is still 'reachable' — the edge answered —
    but carries its status so classify_probes() can decide healthiness. A
    transport failure (timeout / refused / DNS) is not reachable.
    """
    started = time.monotonic()
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "radon-tier3-probe/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES)
            latency_ms = int((time.monotonic() - started) * 1000)
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                payload = {}
            return {
                "reachable": True,
                "http_status": int(getattr(resp, "status", 200)),
                "latency_ms": latency_ms,
                "payload": payload,
            }
    except urllib.error.HTTPError as exc:
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "reachable": True,
            "http_status": int(exc.code),
            "latency_ms": latency_ms,
            "payload": {},
        }
    except urllib.error.URLError as exc:
        reason = exc.reason
        detail = _classify_transport_error(reason) if isinstance(reason, Exception) else "unreachable"
        return {"reachable": False, "detail": detail}
    except (socket.timeout, TimeoutError):
        return {"reachable": False, "detail": "timeout"}
    except OSError as exc:
        return {"reachable": False, "detail": _classify_transport_error(exc)}


def _is_status_payload_healthy(payload: dict) -> bool:
    """The Tier-2 aggregate is healthy when its top-level state is not an error.

    /edge-health/status reports an `ok` boolean and/or a three-valued `state`
    ('up'|'down'|'unknown'|...). Be liberal: treat an explicit ok==False or a
    state of 'down'/'error' as unhealthy; anything else (including 'unknown',
    which is not proof of death) as healthy. A non-dict / empty payload is
    treated as healthy-but-opaque — the 200 itself proved the edge answered.
    """
    if not isinstance(payload, dict) or not payload:
        return True
    if payload.get("ok") is False:
        return False
    state = payload.get("state")
    if isinstance(state, str) and state.lower() in {"down", "error", "failed"}:
        return False
    return True


def classify_probes(ping: dict, status: dict) -> dict:
    """Combine the ping + status probe dicts into {ok, detail}.

    ok=1 requires BOTH: the static ping returned 2xx AND the aggregate status
    returned 2xx with a non-error payload. The static ping isolates 'is the
    edge serving at all' from 'is the daemon's aggregate happy', so the detail
    string says which ring failed.
    """
    if not ping.get("reachable"):
        return {"ok": 0, "detail": "ping_unreachable:" + str(ping.get("detail", "?"))}
    ping_status = int(ping.get("http_status", 0))
    if not (200 <= ping_status < 300):
        return {"ok": 0, "detail": "ping_http_%d" % ping_status}

    if not status.get("reachable"):
        return {"ok": 0, "detail": "status_unreachable:" + str(status.get("detail", "?"))}
    status_code = int(status.get("http_status", 0))
    if not (200 <= status_code < 300):
        return {"ok": 0, "detail": "status_http_%d" % status_code}

    if not _is_status_payload_healthy(status.get("payload", {})):
        return {"ok": 0, "detail": "aggregate_unhealthy"}

    return {"ok": 1, "detail": "edge_ok"}


def build_probe_row(source: str, ping: dict, status: dict, checked_at: str) -> dict:
    """Assemble the external_probe UPSERT row from the two probe dicts.

    http_status is the aggregate /status code (the meaningful one — it carries
    the daemon's verdict). latency_ms is the SLOWER of the two reachable
    endpoints (worst-case round-trip). Both are None on transport failure so a
    NULL in the row unambiguously means 'never got an HTTP answer'.
    """
    classification = classify_probes(ping, status)
    http_status = status.get("http_status") if status.get("reachable") else None
    latencies = [p.get("latency_ms") for p in (ping, status) if p.get("reachable") and p.get("latency_ms") is not None]
    latency_ms = max(latencies) if latencies else None
    return {
        "source": source,
        "ok": int(classification["ok"]),
        "http_status": http_status,
        "latency_ms": latency_ms,
        "detail": classification["detail"],
        "checked_at": checked_at,
    }


def run_probe(source: str = PROBE_SOURCE) -> dict:
    """Probe both edge endpoints, classify, and UPSERT one row. Impure
    (network + DB). Returns the row that was written. Raises TursoHttpError if
    the write fails."""
    ping = probe_endpoint(EDGE_BASE.rstrip("/") + PING_PATH)
    status = probe_endpoint(EDGE_BASE.rstrip("/") + STATUS_PATH)
    row = build_probe_row(source, ping, status, _now_iso())
    upsert_external_probe(row)
    return row


def main() -> int:
    try:
        row = run_probe()
    except TursoHttpError as exc:
        sys.stderr.write("[health_probe] FAILED to write external_probe: %s\n" % exc)
        return 1
    sys.stdout.write(json.dumps(row) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
