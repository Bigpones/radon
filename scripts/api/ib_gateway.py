"""IB Gateway health check and lifecycle management.

Supports three modes controlled by IB_GATEWAY_MODE env var:
  - "cloud"   — remote Gateway (e.g. Hetzner via Tailscale). No local restart.
  - "docker"  — manages Gateway via Docker Compose
  - "launchd" — manages Gateway via IBC launchd service (legacy)

Default: "docker".
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("radon.ib_gateway")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

IB_HOST = os.environ.get("IB_GATEWAY_HOST", "127.0.0.1")
IB_PORT = int(os.environ.get("IB_GATEWAY_PORT", "4001"))
GATEWAY_MODE = os.environ.get("IB_GATEWAY_MODE", "docker")  # "docker", "cloud", or "launchd"

# LaunchD paths
IBC_HOME = Path.home() / "ibc" / "bin"
STATUS_SCRIPT = IBC_HOME / "status-secure-ibc-service.sh"
START_SCRIPT = IBC_HOME / "start-secure-ibc-service.sh"
RESTART_SCRIPT = IBC_HOME / "restart-secure-ibc-service.sh"

# Docker paths
COMPOSE_DIR = Path(__file__).parent.parent.parent / "docker" / "ib-gateway"

# Timing
RESTART_WAIT_SECS = 45
PORT_POLL_INTERVAL = 3

# Prevent concurrent restart races
_restart_lock = asyncio.Lock()

# Restart backoff state — only reset when a probe confirms login (managedAccounts non-empty).
# Each restart sends a fresh IBKR Mobile 2FA push; tight retry loops spam the user
# AND can flag the account as suspicious, so we widen the gap between attempts
# until login completes.
BACKOFF_LADDER_SECS: List[int] = [60, 120, 300, 900, 1800, 3600]  # 1m,2m,5m,15m,30m,60m

_restart_state: Dict = {
    "attempt_count": 0,            # consecutive unconfirmed attempts
    "next_attempt_after": 0.0,     # epoch seconds; restart() refuses before this
    "last_attempt_at": 0.0,        # epoch seconds; last actual restart attempt
    "last_outcome": None,          # "authenticated" | "awaiting_2fa" | "unreachable" | None
    "last_accounts": [],           # most recent managedAccounts() probe result
}


def _next_backoff_delay(attempt_count: int) -> int:
    """Return delay in seconds for the Nth consecutive failed attempt (1-indexed)."""
    if attempt_count <= 0:
        return BACKOFF_LADDER_SECS[0]
    idx = min(attempt_count - 1, len(BACKOFF_LADDER_SECS) - 1)
    return BACKOFF_LADDER_SECS[idx]


def restart_backoff_state() -> Dict:
    """Snapshot of restart backoff state for /health and operator visibility."""
    now = time.time()
    return {
        "attempt_count": _restart_state["attempt_count"],
        "last_attempt_at": _restart_state["last_attempt_at"],
        "next_attempt_after": _restart_state["next_attempt_after"],
        "next_attempt_in_secs": max(0, int(_restart_state["next_attempt_after"] - now)),
        "last_outcome": _restart_state["last_outcome"],
    }


def reset_restart_backoff() -> Dict:
    """Manually clear backoff. Operator path: 'I just approved 2FA, try again now'."""
    previous = {k: _restart_state[k] for k in ("attempt_count", "next_attempt_after", "last_outcome")}
    _restart_state["attempt_count"] = 0
    _restart_state["next_attempt_after"] = 0.0
    return {"reset": True, "previous": previous}

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _port_listening(host: str = IB_HOST, port: int = IB_PORT, timeout: float = 2.0) -> bool:
    """Check if IB Gateway port is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, OSError, socket.timeout):
        return False


async def _poll_port(wait_secs: int = RESTART_WAIT_SECS) -> tuple:
    """Poll port until listening or timeout. Returns (port_ok, elapsed)."""
    elapsed = 0
    while elapsed < wait_secs:
        await asyncio.sleep(PORT_POLL_INTERVAL)
        elapsed += PORT_POLL_INTERVAL
        if await asyncio.to_thread(_port_listening):
            logger.info("IB Gateway accepting connections after %ds", elapsed)
            return True, elapsed
        logger.info("Waiting for IB Gateway... (%d/%ds)", elapsed, wait_secs)
    return False, elapsed


# ---------------------------------------------------------------------------
# LaunchD mode
# ---------------------------------------------------------------------------


def _has_close_wait(port: int = IB_PORT) -> bool:
    """Detect CLOSE_WAIT sockets on IB Gateway port.

    CLOSE_WAIT means the Gateway process is alive but the upstream IB
    session has dropped. Only relevant in launchd mode where we see
    the host-level TCP state directly.
    """
    try:
        out = subprocess.check_output(
            ["lsof", "-i", f":{port}", "-n", "-P"],
            timeout=5,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return "CLOSE_WAIT" in out
    except (subprocess.SubprocessError, OSError):
        return False


async def _run_shell(script: Path, timeout: float = 10.0) -> tuple:
    """Run a shell script, return (stdout, stderr, returncode)."""
    if not script.exists():
        return ("", f"Script not found: {script}", 1)

    proc = await asyncio.create_subprocess_exec(
        "bash", str(script),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (
            stdout.decode("utf-8", errors="replace").strip(),
            stderr.decode("utf-8", errors="replace").strip(),
            proc.returncode,
        )
    except asyncio.TimeoutError:
        proc.kill()
        return ("", "Script timed out", -1)


async def _check_launchd() -> Dict:
    """Check Gateway health via launchd service state."""
    port_ok = await asyncio.to_thread(_port_listening)
    close_wait = await asyncio.to_thread(_has_close_wait) if port_ok else False

    service_state = "unknown"
    if STATUS_SCRIPT.exists():
        stdout, _, rc = await _run_shell(STATUS_SCRIPT)
        if rc == 0:
            for line in stdout.split("\n"):
                line = line.strip()
                if line.startswith("state ="):
                    service_state = line.split("=", 1)[1].strip()
                    break

    return {
        "port_listening": port_ok,
        "upstream_dead": close_wait,
        "service_state": service_state,
        "host": IB_HOST,
        "port": IB_PORT,
        "gateway_mode": "launchd",
    }


async def _ensure_launchd() -> Dict:
    """Ensure Gateway is running via launchd. Handles CLOSE_WAIT detection."""
    port_ok = await asyncio.to_thread(_port_listening)

    if port_ok:
        close_wait = await asyncio.to_thread(_has_close_wait)
        if close_wait:
            logger.warning(
                "IB Gateway on %s:%d has CLOSE_WAIT (upstream dead) — restarting",
                IB_HOST, IB_PORT,
            )
            return await _restart_launchd()
        return {"status": "already_running", "port_listening": True, "gateway_mode": "launchd"}

    logger.warning("IB Gateway not listening on %s:%d — attempting start", IB_HOST, IB_PORT)
    return await _restart_launchd()


async def _restart_launchd() -> Dict:
    """Restart Gateway via IBC launchd service scripts."""
    if not RESTART_SCRIPT.exists():
        return {
            "restarted": False,
            "error": f"IBC restart script not found at {RESTART_SCRIPT}",
            "port_listening": False,
            "gateway_mode": "launchd",
        }

    logger.info("Running IBC restart script...")
    stdout, stderr, rc = await _run_shell(RESTART_SCRIPT, timeout=60.0)

    if rc != 0:
        logger.warning("Restart script failed (rc=%d), trying start script...", rc)
        if START_SCRIPT.exists():
            stdout, stderr, rc = await _run_shell(START_SCRIPT, timeout=60.0)
        if rc != 0:
            return {
                "restarted": False,
                "error": f"Both restart and start scripts failed. stderr: {stderr[:200]}",
                "port_listening": False,
                "gateway_mode": "launchd",
            }

    logger.info("IBC script finished, waiting for Gateway (up to %ds)...", RESTART_WAIT_SECS)
    port_ok, elapsed = await _poll_port()

    if not port_ok:
        return {
            "restarted": True,
            "port_listening": False,
            "gateway_mode": "launchd",
            "error": (
                f"IBC service started but Gateway not accepting connections after {RESTART_WAIT_SECS}s. "
                "Check IBKR Mobile for 2FA approval."
            ),
        }

    return {
        "restarted": True,
        "port_listening": True,
        "wait_seconds": elapsed,
        "gateway_mode": "launchd",
    }


# ---------------------------------------------------------------------------
# Docker mode
# ---------------------------------------------------------------------------


async def _docker_compose(*args: str, timeout: float = 30.0) -> tuple:
    """Run docker compose command in the ib-gateway directory."""
    compose_file = COMPOSE_DIR / "docker-compose.yml"
    env_file = COMPOSE_DIR / ".env"

    if not compose_file.exists():
        return ("", f"Docker compose file not found at {compose_file}", 1)

    cmd = ["docker", "compose", "-f", str(compose_file)]
    if env_file.exists():
        cmd.extend(["--env-file", str(env_file)])
    cmd.extend(args)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (
            stdout.decode("utf-8", errors="replace").strip(),
            stderr.decode("utf-8", errors="replace").strip(),
            proc.returncode,
        )
    except asyncio.TimeoutError:
        proc.kill()
        return ("", "Docker compose command timed out", -1)


async def _docker_container_state() -> tuple:
    """Get Docker container state and health.

    Returns (state, health) tuple, e.g. ("running", "healthy"), ("exited", "").
    """
    stdout, _, rc = await _docker_compose("ps", "--format", "json", timeout=10.0)
    if rc != 0 or not stdout:
        return "not_found", ""

    try:
        for line in stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("Service") == "ib-gateway" or "ib-gateway" in entry.get("Name", ""):
                state = entry.get("State", "unknown").lower()
                health = entry.get("Health", "").lower()
                return state, health
    except (json.JSONDecodeError, KeyError):
        pass

    return "not_found", ""


async def _check_docker() -> Dict:
    """Check Gateway health via Docker container status."""
    port_ok = await asyncio.to_thread(_port_listening)
    container_state, container_health = await _docker_container_state()

    # Map container health status
    service_state = "unknown"
    if container_state == "running":
        if container_health == "healthy":
            service_state = "healthy"
        elif container_health == "unhealthy":
            service_state = "unhealthy"
        else:
            service_state = "starting" if not port_ok else "healthy"
    elif container_state == "restarting":
        service_state = "restarting"
    elif container_state in ("exited", "not_found"):
        service_state = "stopped"

    # In Docker mode, upstream_dead means the container is running but IB API
    # inside is not responsive (unhealthy healthcheck). Docker's port proxy
    # may still accept TCP connections even when the IB API is down.
    upstream_dead = container_state == "running" and container_health == "unhealthy"

    return {
        "port_listening": port_ok,
        "upstream_dead": upstream_dead,
        "service_state": service_state,
        "container_state": container_state,
        "container_health": container_health,
        "host": IB_HOST,
        "port": IB_PORT,
        "gateway_mode": "docker",
    }


async def _ensure_docker_container() -> Dict:
    """Ensure Docker container is running. Start if stopped, wait if restarting.

    In Docker mode, we do NOT attempt to restart the container — Docker's
    restart: unless-stopped policy handles that. We only start a stopped/missing
    container, or wait for a restarting one.
    """
    port_ok = await asyncio.to_thread(_port_listening)

    if port_ok:
        return {"status": "already_running", "port_listening": True, "gateway_mode": "docker"}

    container_state, container_health = await _docker_container_state()

    if container_state == "restarting":
        logger.info("Docker container is restarting, waiting for port...")
        port_ok, elapsed = await _poll_port()
        return {
            "status": "waited_for_restart",
            "port_listening": port_ok,
            "wait_seconds": elapsed,
            "gateway_mode": "docker",
        }

    if container_state in ("exited", "not_found"):
        logger.warning("Docker container %s — starting with docker compose up -d", container_state)
        _, stderr, rc = await _docker_compose("up", "-d", timeout=60.0)
        if rc != 0:
            return {
                "restarted": False,
                "error": f"docker compose up failed: {stderr[:200]}",
                "port_listening": False,
                "gateway_mode": "docker",
            }
    elif container_state == "running" and container_health == "unhealthy":
        # Container is running but IB API is unresponsive (e.g. 2FA expired).
        # Docker's restart: unless-stopped will cycle it. Don't restart from here.
        logger.warning("Docker container running but unhealthy — waiting for Docker auto-restart")
        return {
            "restarted": False,
            "port_listening": False,
            "gateway_mode": "docker",
            "error": "IB Gateway container is unhealthy (IB API not responding). Docker will auto-restart. Check IBKR Mobile for 2FA.",
        }

    # Container running but port not yet ready — wait
    logger.info("Waiting for Gateway port (up to %ds)...", RESTART_WAIT_SECS)
    port_ok, elapsed = await _poll_port()

    if not port_ok:
        return {
            "restarted": True,
            "port_listening": False,
            "gateway_mode": "docker",
            "error": (
                f"Container started but Gateway not accepting connections after {RESTART_WAIT_SECS}s. "
                "Check 2FA approval or container logs: scripts/docker_ib_gateway.sh logs"
            ),
        }

    return {
        "restarted": True,
        "port_listening": True,
        "wait_seconds": elapsed,
        "gateway_mode": "docker",
    }


async def _restart_docker() -> Dict:
    """Restart Gateway via Docker Compose.

    For running containers, issue docker compose restart. Docker's own
    restart: unless-stopped policy handles crash recovery — this is only
    for explicit user-initiated restarts via POST /ib/restart.
    """
    container_state, _ = await _docker_container_state()

    if container_state in ("exited", "not_found"):
        return await _ensure_docker_container()

    logger.info("Restarting Docker ib-gateway container...")
    _, stderr, rc = await _docker_compose("restart", "ib-gateway", timeout=60.0)

    if rc != 0:
        return {
            "restarted": False,
            "error": f"docker compose restart failed: {stderr[:200]}",
            "port_listening": False,
            "gateway_mode": "docker",
        }

    logger.info("Docker restart issued, waiting for Gateway (up to %ds)...", RESTART_WAIT_SECS)
    port_ok, elapsed = await _poll_port()

    if not port_ok:
        return {
            "restarted": True,
            "port_listening": False,
            "gateway_mode": "docker",
            "error": (
                f"Container restarted but Gateway not accepting connections after {RESTART_WAIT_SECS}s. "
                "Check 2FA or container logs."
            ),
        }

    return {
        "restarted": True,
        "port_listening": True,
        "wait_seconds": elapsed,
        "gateway_mode": "docker",
    }


# ---------------------------------------------------------------------------
# Cloud mode — remote Gateway, no local lifecycle management
# ---------------------------------------------------------------------------


async def _check_cloud() -> Dict:
    """Check remote Gateway health via TCP port probe only."""
    port_ok = await asyncio.to_thread(_port_listening)
    return {
        "port_listening": port_ok,
        "upstream_dead": False,
        "service_state": "reachable" if port_ok else "unreachable",
        "host": IB_HOST,
        "port": IB_PORT,
        "gateway_mode": "cloud",
    }


async def _ensure_cloud() -> Dict:
    """Verify remote Gateway is reachable. No restart capability."""
    port_ok = await asyncio.to_thread(_port_listening)
    if port_ok:
        return {"status": "already_running", "port_listening": True, "gateway_mode": "cloud"}
    logger.warning(
        "Cloud IB Gateway not reachable at %s:%d — check remote host",
        IB_HOST, IB_PORT,
    )
    return {
        "status": "unreachable",
        "port_listening": False,
        "gateway_mode": "cloud",
        "error": f"Cloud IB Gateway at {IB_HOST}:{IB_PORT} is not reachable. Check remote host and Tailscale.",
    }


# ---------------------------------------------------------------------------
# Public API — dispatches by GATEWAY_MODE
# ---------------------------------------------------------------------------


def is_cloud_mode() -> bool:
    """Return True if Gateway runs on a remote host (no local lifecycle)."""
    return GATEWAY_MODE == "cloud"


def is_docker_mode() -> bool:
    """Return True if Gateway is managed by Docker."""
    return GATEWAY_MODE == "docker"


def is_launchd_mode() -> bool:
    """Return True if Gateway is managed by the local launchd/IBC service."""
    return GATEWAY_MODE == "launchd"


async def _probe_authenticated(timeout: float = 8.0) -> tuple[bool, List[str]]:
    """Open a throwaway IB connection and probe `managedAccounts()`.

    Returns (authenticated, accounts). Authenticated = accounts list non-empty.
    Used to verify a restart actually completed login — not just that the API
    socket is listening. Empty accounts on a listening port means TWS is sitting
    at the IBKR Mobile 2FA prompt.
    """
    try:
        from ib_insync import IB
    except ImportError:
        return (False, [])

    def _do_probe() -> tuple[bool, List[str]]:
        ib = IB()
        try:
            # CLI range (90-99) per CLAUDE.md client-id allocation — clientId 98
            # to avoid colliding with pool (3-5), relay (10-19), subprocesses,
            # scanners, daemons. Brief connect + immediate disconnect.
            ib.connect(IB_HOST, IB_PORT, clientId=98, timeout=timeout)
            accounts = list(ib.managedAccounts() or [])
            return (bool(accounts), accounts)
        except Exception:
            return (False, [])
        finally:
            try:
                ib.disconnect()
            except Exception:
                pass

    return await asyncio.to_thread(_do_probe)


def _derive_auth_state(check_result: Dict, pool_status: Optional[dict]) -> str:
    """Derive auth_state from a check result + optional pool status.

    States:
      unreachable   — port not listening
      authenticated — at least one connected pool client returns managed_accounts
      awaiting_2fa  — port listening but no accounts visible (TWS at 2FA prompt
                      or pool fully disconnected from a Gateway that's pre-login)
      unknown       — pool status unavailable; cannot distinguish auth/no-auth
    """
    if not check_result.get("port_listening"):
        return "unreachable"
    if not pool_status:
        return "unknown"
    for role_info in pool_status.values():
        if role_info.get("connected") and role_info.get("managed_accounts"):
            return "authenticated"
    return "awaiting_2fa"


async def check_ib_gateway(pool_status: Optional[dict] = None) -> Dict:
    """Check IB Gateway health. Returns status dict for /health endpoint.

    Pass `pool_status` (typically `IBPool.status()`) so the response can
    distinguish "logged in" from "port listening but awaiting 2FA". Without
    it, auth_state is "remote" (cloud mode) or "unknown" (no pool to probe).
    """
    if is_cloud_mode():
        result = await _check_cloud()
        result["auth_state"] = "remote" if result.get("port_listening") else "unreachable"
        return result

    if is_docker_mode():
        result = await _check_docker()
    else:
        result = await _check_launchd()

    result["auth_state"] = _derive_auth_state(result, pool_status)
    result["restart_backoff"] = restart_backoff_state()
    return result


async def ensure_ib_gateway() -> Dict:
    """Ensure IB Gateway is running. Called at FastAPI startup."""
    async with _restart_lock:
        if is_cloud_mode():
            return await _ensure_cloud()
        if is_docker_mode():
            return await _ensure_docker_container()
        return await _ensure_launchd()


async def restart_ib_gateway() -> Dict:
    """Restart IB Gateway. Honors exponential backoff if 2FA stays unapproved.

    Refuses fresh restart attempts inside the backoff window (1m, 2m, 5m, 15m,
    30m, 60m, capped at 60m). After an attempt, probes `managedAccounts()` and
    only resets the backoff counter when accounts are returned (= login
    completed). A "port listening" success is NOT enough — Gateway sits with
    the API socket open while waiting for the IBKR Mobile 2FA push.
    """
    async with _restart_lock:
        now = time.time()

        # Backoff gate
        if _restart_state["next_attempt_after"] > now:
            wait_secs = int(_restart_state["next_attempt_after"] - now)
            last_iso = (
                datetime.fromtimestamp(_restart_state["last_attempt_at"]).isoformat()
                if _restart_state["last_attempt_at"]
                else "never"
            )
            return {
                "restarted": False,
                "deferred": True,
                "reason": "awaiting_backoff",
                "attempt_count": _restart_state["attempt_count"],
                "next_attempt_in_secs": wait_secs,
                "next_attempt_after": _restart_state["next_attempt_after"],
                "last_attempt_at": last_iso,
                "last_outcome": _restart_state["last_outcome"],
                "error": (
                    f"Skipping restart — last attempt at {last_iso} did not complete login "
                    f"({_restart_state['attempt_count']} consecutive). Backoff window "
                    f"of {wait_secs}s remaining. Approve IBKR Mobile 2FA, then call "
                    f"POST /ib/reset-backoff to retry immediately."
                ),
            }

        if is_cloud_mode():
            return {
                "restarted": False,
                "gateway_mode": "cloud",
                "error": f"Cannot restart remote Gateway at {IB_HOST}:{IB_PORT}. Manage it on the remote host.",
            }

        result = await (_restart_docker() if is_docker_mode() else _restart_launchd())
        _restart_state["last_attempt_at"] = now

        if result.get("port_listening"):
            authenticated, accounts = await _probe_authenticated()
            result["managed_accounts"] = accounts
            if authenticated:
                _restart_state["attempt_count"] = 0
                _restart_state["next_attempt_after"] = 0.0
                _restart_state["last_outcome"] = "authenticated"
                _restart_state["last_accounts"] = accounts
                result["authenticated"] = True
                result["auth_state"] = "authenticated"
                logger.info("IB Gateway restart verified — accounts: %s", accounts)
            else:
                _restart_state["attempt_count"] += 1
                delay = _next_backoff_delay(_restart_state["attempt_count"])
                _restart_state["next_attempt_after"] = now + delay
                _restart_state["last_outcome"] = "awaiting_2fa"
                result["authenticated"] = False
                result["auth_state"] = "awaiting_2fa"
                result["next_attempt_in_secs"] = delay
                result["attempt_count"] = _restart_state["attempt_count"]
                logger.warning(
                    "IB Gateway restart: port up but managedAccounts empty — "
                    "treating as awaiting_2fa, next attempt allowed in %ds (attempt #%d)",
                    delay, _restart_state["attempt_count"],
                )
        else:
            _restart_state["attempt_count"] += 1
            delay = _next_backoff_delay(_restart_state["attempt_count"])
            _restart_state["next_attempt_after"] = now + delay
            _restart_state["last_outcome"] = "unreachable"
            result["auth_state"] = "unreachable"
            result["next_attempt_in_secs"] = delay
            result["attempt_count"] = _restart_state["attempt_count"]
            logger.warning(
                "IB Gateway restart: port did not come up — next attempt allowed in %ds (attempt #%d)",
                delay, _restart_state["attempt_count"],
            )

        return result
