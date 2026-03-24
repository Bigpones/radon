"""IB Gateway health check and auto-restart via IBC launchd service.

Detects when IB Gateway is down (port 4001 not listening) and restarts
the secure IBC service. Requires 2FA approval on IBKR Mobile after restart.

IBC service scripts:
  ~/ibc/bin/status-secure-ibc-service.sh
  ~/ibc/bin/start-secure-ibc-service.sh
  ~/ibc/bin/restart-secure-ibc-service.sh
"""

from __future__ import annotations

import asyncio
import logging
import socket
import subprocess
from pathlib import Path
from typing import Dict

logger = logging.getLogger("radon.ib_gateway")

IB_HOST = "127.0.0.1"
IB_PORT = 4001
IBC_HOME = Path.home() / "ibc" / "bin"
STATUS_SCRIPT = IBC_HOME / "status-secure-ibc-service.sh"
START_SCRIPT = IBC_HOME / "start-secure-ibc-service.sh"
RESTART_SCRIPT = IBC_HOME / "restart-secure-ibc-service.sh"

# How long to wait after restart for Gateway to accept connections
RESTART_WAIT_SECS = 45
PORT_POLL_INTERVAL = 3


def _port_listening(host: str = IB_HOST, port: int = IB_PORT, timeout: float = 2.0) -> bool:
    """Check if IB Gateway port is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, OSError, socket.timeout):
        return False


def _has_close_wait(port: int = IB_PORT) -> bool:
    """Detect CLOSE_WAIT sockets on IB Gateway port.

    CLOSE_WAIT means the Gateway process is alive but the upstream IB
    session has dropped. The port appears listening to TCP checks, but
    API calls will hang/timeout. Needs a full restart to recover.
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


async def check_ib_gateway() -> Dict:
    """Check IB Gateway health. Returns status dict for /health endpoint."""
    port_ok = await asyncio.to_thread(_port_listening)
    close_wait = await asyncio.to_thread(_has_close_wait) if port_ok else False

    # Parse launchd service state
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
    }


async def ensure_ib_gateway() -> Dict:
    """Ensure IB Gateway is running and upstream is healthy.

    Called at FastAPI startup. Detects both port-down and CLOSE_WAIT
    (port listening but upstream IB session dead). Returns status dict.
    """
    port_ok = await asyncio.to_thread(_port_listening)

    if port_ok:
        # Port is listening — check if upstream IB session is alive
        close_wait = await asyncio.to_thread(_has_close_wait)
        if close_wait:
            logger.warning(
                "IB Gateway on %s:%d has CLOSE_WAIT (upstream dead) — restarting",
                IB_HOST, IB_PORT,
            )
            return await restart_ib_gateway()
        return {"status": "already_running", "port_listening": True}

    logger.warning("IB Gateway not listening on %s:%d — attempting start", IB_HOST, IB_PORT)
    return await restart_ib_gateway()


async def restart_ib_gateway() -> Dict:
    """Restart IB Gateway via IBC service.

    1. Run restart script (or start if restart fails)
    2. Poll port for up to RESTART_WAIT_SECS
    3. Return result with port status

    Note: Fresh starts require 2FA approval on IBKR Mobile.
    """
    if not RESTART_SCRIPT.exists():
        return {
            "restarted": False,
            "error": f"IBC restart script not found at {RESTART_SCRIPT}",
            "port_listening": False,
        }

    # Try restart first (handles both running and stopped states)
    logger.info("Running IBC restart script...")
    stdout, stderr, rc = await _run_shell(RESTART_SCRIPT, timeout=60.0)

    if rc != 0:
        # Fall back to start script
        logger.warning("Restart script failed (rc=%d), trying start script...", rc)
        if START_SCRIPT.exists():
            stdout, stderr, rc = await _run_shell(START_SCRIPT, timeout=60.0)
        if rc != 0:
            return {
                "restarted": False,
                "error": f"Both restart and start scripts failed. stderr: {stderr[:200]}",
                "port_listening": False,
            }

    # Poll for port to come up
    logger.info("IBC script finished, waiting for Gateway to accept connections (up to %ds)...", RESTART_WAIT_SECS)
    port_ok = False
    elapsed = 0
    while elapsed < RESTART_WAIT_SECS:
        await asyncio.sleep(PORT_POLL_INTERVAL)
        elapsed += PORT_POLL_INTERVAL
        if await asyncio.to_thread(_port_listening):
            port_ok = True
            logger.info("IB Gateway accepting connections after %ds", elapsed)
            break
        logger.info("Waiting for IB Gateway... (%d/%ds)", elapsed, RESTART_WAIT_SECS)

    if not port_ok:
        return {
            "restarted": True,
            "port_listening": False,
            "error": (
                f"IBC service started but Gateway not accepting connections after {RESTART_WAIT_SECS}s. "
                "Check IBKR Mobile for 2FA approval."
            ),
        }

    return {
        "restarted": True,
        "port_listening": True,
        "wait_seconds": elapsed,
    }
