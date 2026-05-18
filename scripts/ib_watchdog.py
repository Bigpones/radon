#!/usr/bin/env python3
"""IB Gateway API-aware watchdog.

Docker's TCP healthcheck only confirms the JVM has a socket bound on
port 4001. It can't tell whether the IB API thread is actually
responsive — a state we've hit three times in 24h on Hetzner where
the gateway accepts TCP connections but the API handshake hangs
forever, leaving fill-monitor / journal-sync / orders all timing out
while Docker reports "healthy."

This watchdog watches FastAPI's `/health` (which DOES probe the API
layer via the existing `ib_pool` machinery) and triggers a clean
`systemctl restart radon-ib-gateway.service` after sustained
degradation. Cadence: 60s, threshold: 3 consecutive degraded
readings (= ~3 min of real-time hang).

State persists at ``STATE_PATH`` so each oneshot invocation can pick
up the counter from the previous one. Reset on healthy, or on any
signal that isn't this specific degradation pattern (e.g. awaiting
2FA — which the 2FA backoff in scripts/api/ib_gateway.py already
handles and is NOT this bug).

See ``docs/ib-gateway-healthcheck-hardening.md`` for the design.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

LOG = logging.getLogger("ib_watchdog")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)


# --- Configuration -----------------------------------------------------------

DEFAULT_HEALTH_URL = "http://127.0.0.1:8321/health"
DEFAULT_HEALTH_TIMEOUT_SECS = 5.0
DEFAULT_STATE_PATH = Path("/var/lib/radon/ib-watchdog-state.json")
DEFAULT_RESTART_UNIT = "radon-ib-gateway.service"
# Three consecutive degraded readings (60s apart) = ~3 min of hang
# before we restart. Calibrated against today's incidents: the JVM
# hangs we've seen each lasted 10+ minutes, so 3 cycles trips well
# before user impact while skipping transient blips.
DEFAULT_THRESHOLD_CYCLES = 3


# --- /health response handling ----------------------------------------------


@dataclass(frozen=True)
class GatewayState:
    """The subset of FastAPI /health we care about."""

    service_state: str  # "healthy" | "unhealthy" | "unknown"
    port_listening: bool
    upstream_dead: bool
    auth_state: str  # "authenticated" | "awaiting_2fa" | "unreachable" | …

    @classmethod
    def from_health_payload(cls, payload: dict) -> Optional["GatewayState"]:
        gw = payload.get("ib_gateway") or {}
        if not isinstance(gw, dict):
            return None
        return cls(
            service_state=str(gw.get("service_state", "unknown")),
            port_listening=bool(gw.get("port_listening", False)),
            upstream_dead=bool(gw.get("upstream_dead", False)),
            auth_state=str(gw.get("auth_state", "unknown")),
        )


def fetch_health(url: str, timeout: float) -> Optional[GatewayState]:
    """Fetch /health and return the gateway state, or None on error.

    Network errors and bad payloads return None — the caller treats
    that as "watchdog can't tell, leave state alone" rather than
    falsely incrementing the degradation counter.
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        LOG.warning("health probe failed: %s", exc)
        return None
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        LOG.warning("health payload not JSON: %s", exc)
        return None
    state = GatewayState.from_health_payload(payload)
    if state is None:
        LOG.warning("health payload missing ib_gateway")
    return state


# --- Degradation classification ---------------------------------------------


def is_api_hang(state: GatewayState) -> bool:
    """The specific failure mode this watchdog exists to catch.

    TCP socket is bound (port_listening) but the upstream API isn't
    responding to handshakes (upstream_dead). This is distinct from
    awaiting_2fa (which has its own backoff) and from a fully-down
    gateway (port_listening would be False — Docker `restart: always`
    handles that).
    """
    if not state.port_listening:
        return False  # Port down → Docker restart policy handles it
    if state.auth_state == "awaiting_2fa":
        return False  # 2FA backoff in ib_gateway.py handles this
    return state.upstream_dead


# --- State persistence ------------------------------------------------------


@dataclass
class WatchdogState:
    degraded_count: int = 0
    last_restart_at: float = 0.0
    last_outcome: str = "init"  # human-readable status for ops

    def to_dict(self) -> dict:
        return {
            "degraded_count": self.degraded_count,
            "last_restart_at": self.last_restart_at,
            "last_outcome": self.last_outcome,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WatchdogState":
        return cls(
            degraded_count=int(data.get("degraded_count", 0)),
            last_restart_at=float(data.get("last_restart_at", 0.0)),
            last_outcome=str(data.get("last_outcome", "init")),
        )


def load_state(path: Path) -> WatchdogState:
    if not path.exists():
        return WatchdogState()
    try:
        with path.open() as fh:
            return WatchdogState.from_dict(json.load(fh))
    except (json.JSONDecodeError, OSError) as exc:
        LOG.warning("state load failed (%s); resetting", exc)
        return WatchdogState()


def save_state(path: Path, state: WatchdogState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as fh:
        json.dump(state.to_dict(), fh)
    os.replace(tmp, path)


# --- Restart action ---------------------------------------------------------


def trigger_restart(unit: str, dry_run: bool = False) -> bool:
    """Restart the IB Gateway systemd unit. Returns True on success.

    Uses `systemctl restart` rather than calling FastAPI's
    `/ib/restart` directly because FastAPI's path is gated on the
    2FA backoff — we want this watchdog to be an escape hatch even
    when that backoff is active (it isn't fired for this specific
    failure mode, but defense in depth).
    """
    cmd = ["systemctl", "restart", unit]
    if dry_run:
        LOG.info("[dry-run] would run: %s", " ".join(cmd))
        return True
    try:
        subprocess.run(cmd, check=True, timeout=30)
        return True
    except subprocess.CalledProcessError as exc:
        LOG.error("systemctl restart failed: rc=%s stderr=%s", exc.returncode, exc.stderr)
        return False
    except subprocess.TimeoutExpired:
        LOG.error("systemctl restart timed out after 30s")
        return False


# --- service_health write ---------------------------------------------------


def record_service_health(
    state_label: str,
    error_message: Optional[str] = None,
) -> None:
    """Best-effort heartbeat into Turso so the banner can show our state.

    Imports the writer lazily so the script remains useful in dev
    environments without the full Radon dependency surface — a
    missing writer just logs and continues.
    """
    try:
        # Lazy import — keeps the script importable in unit tests
        # that mock subprocess.run / urlopen but don't have Turso
        # creds configured.
        from scripts.db.writer import record_service_health as _write
    except ImportError:
        LOG.debug("service_health writer not available in this environment")
        return
    try:
        _write(
            "ib-watchdog",
            state_label,
            started_at=None,
            finished_at=None,  # writer fills timestamp
            error={"message": error_message} if error_message else None,
        )
    except Exception as exc:  # pragma: no cover — never crash the watchdog
        LOG.warning("service_health write failed: %s", exc)


# --- Main cycle -------------------------------------------------------------


def run_cycle(
    *,
    health_url: str = DEFAULT_HEALTH_URL,
    health_timeout: float = DEFAULT_HEALTH_TIMEOUT_SECS,
    state_path: Path = DEFAULT_STATE_PATH,
    restart_unit: str = DEFAULT_RESTART_UNIT,
    threshold: int = DEFAULT_THRESHOLD_CYCLES,
    dry_run: bool = False,
    clock: callable = time.time,
) -> WatchdogState:
    """Execute one cycle. Returns the final state for inspection / testing.

    Kept as a pure-ish function (no top-level side effects beyond
    the dependencies it accepts) so tests can drive it deterministically.
    """
    state = load_state(state_path)

    health = fetch_health(health_url, health_timeout)
    if health is None:
        # Can't tell — record but don't act. Keeps the watchdog from
        # restarting the gateway when FastAPI itself is the broken thing.
        state.last_outcome = "probe_unreachable"
        save_state(state_path, state)
        record_service_health("ok", error_message=None)
        return state

    if not is_api_hang(health):
        # Healthy, or a state we don't act on (awaiting_2fa, port-down).
        # Reset the counter so a one-off blip doesn't bleed into the
        # next legitimate hang detection.
        if state.degraded_count > 0:
            LOG.info(
                "gateway no longer api-degraded "
                "(service_state=%s auth_state=%s) — resetting counter from %s",
                health.service_state,
                health.auth_state,
                state.degraded_count,
            )
        state.degraded_count = 0
        state.last_outcome = f"healthy:{health.service_state}/{health.auth_state}"
        save_state(state_path, state)
        record_service_health("ok")
        return state

    # API hang detected — increment.
    state.degraded_count += 1
    LOG.warning(
        "api hang detected (cycle %s/%s) — port=%s upstream_dead=%s auth=%s",
        state.degraded_count,
        threshold,
        health.port_listening,
        health.upstream_dead,
        health.auth_state,
    )

    if state.degraded_count < threshold:
        state.last_outcome = f"degraded_{state.degraded_count}_of_{threshold}"
        save_state(state_path, state)
        record_service_health(
            "ok",  # Watchdog itself is fine; just observing degradation
            error_message=None,
        )
        return state

    # Threshold hit — restart.
    LOG.warning(
        "api hang sustained %s cycles — triggering %s restart",
        state.degraded_count,
        restart_unit,
    )
    ok = trigger_restart(restart_unit, dry_run=dry_run)
    state.last_restart_at = clock()
    state.degraded_count = 0  # Reset; let the next cycle observe recovery
    state.last_outcome = f"restarted:{'ok' if ok else 'fail'}"
    save_state(state_path, state)
    record_service_health(
        "error" if ok else "error",
        error_message=(
            f"triggered {restart_unit} restart after {threshold} cycles of api hang"
            if ok
            else f"FAILED to restart {restart_unit} after {threshold} cycles of api hang"
        ),
    )
    return state


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--health-url", default=DEFAULT_HEALTH_URL)
    p.add_argument(
        "--health-timeout",
        type=float,
        default=DEFAULT_HEALTH_TIMEOUT_SECS,
    )
    p.add_argument("--state-path", type=Path, default=DEFAULT_STATE_PATH)
    p.add_argument("--restart-unit", default=DEFAULT_RESTART_UNIT)
    p.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD_CYCLES,
        help="consecutive degraded cycles before restart",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="log the restart command instead of running it",
    )
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    state = run_cycle(
        health_url=args.health_url,
        health_timeout=args.health_timeout,
        state_path=args.state_path,
        restart_unit=args.restart_unit,
        threshold=args.threshold,
        dry_run=args.dry_run,
    )
    LOG.info("cycle done: %s", state.last_outcome)
    return 0


if __name__ == "__main__":
    sys.exit(main())
