"""``restart_ib_gateway`` must consult the shared 2FA push lock.

The bug this guards against (incident 2026-05-19): the user ran
``radon restart``, IB Gateway came up at ``awaiting_2fa``, the user
approved the push on their phone, IBKR reported "unsuccessful". Root
cause: a second restart fired ~3 minutes later from ``ib_watchdog.py``
hitting its api-hang threshold, sending a SECOND 2FA push while the
first was still pending. IBKR's backend cannot reconcile stacked
pushes — every approval gets rejected.

These tests pin down the new behavior layered on top of the existing
in-memory backoff:

  • Issuing a restart acquires the cross-process push lock so other
    paths (watchdog, operator CLI) see "in flight, don't push again".
  • A subsequent ``restart_ib_gateway`` call inside the lock window is
    REFUSED — even though the in-memory backoff might allow it (the two
    state machines work together; the lock is the hard ceiling).
  • A successful authenticated probe RELEASES the lock so the next
    legitimate restart can proceed immediately.
  • ``reset_restart_backoff`` (operator escape hatch) also releases the
    lock — "I just approved 2FA, try again now" must invalidate any
    in-flight lock from a previous failed cycle.
  • A timed-out lock is treated as released (the watchdog or any other
    consumer can proceed once IBKR's backend has had time to settle).
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


from scripts.api import ib_gateway  # noqa: E402
from utils import ib_2fa_lock  # noqa: E402


@pytest.fixture(autouse=True)
def _redirect_lock_path(tmp_path, monkeypatch):
    monkeypatch.setenv("IB_2FA_LOCK_PATH", str(tmp_path / "ib-2fa-push-lock.json"))


@pytest.fixture(autouse=True)
def _reset_backoff_state():
    """Every test gets a clean in-memory backoff so leakage from one
    test does not change the gating in another."""
    ib_gateway._restart_state["attempt_count"] = 0
    ib_gateway._restart_state["next_attempt_after"] = 0.0
    ib_gateway._restart_state["last_attempt_at"] = 0.0
    ib_gateway._restart_state["last_outcome"] = None
    ib_gateway._restart_state["last_accounts"] = []
    yield
    ib_gateway._restart_state["attempt_count"] = 0
    ib_gateway._restart_state["next_attempt_after"] = 0.0


def _patch_docker_mode(monkeypatch, restart_result, probe_result=(False, [])):
    """Force docker mode and stub the docker restart + probe.

    Default probe is "port up, no accounts" (= awaiting_2fa) so the
    first call exercises the failure path; tests that want the success
    path pass an explicit probe_result.
    """
    async def fake_restart_docker():
        return restart_result

    async def fake_probe(timeout=8.0):
        return probe_result

    monkeypatch.setattr(ib_gateway, "is_cloud_mode", lambda: False)
    monkeypatch.setattr(ib_gateway, "is_docker_mode", lambda: True)
    monkeypatch.setattr(ib_gateway, "_restart_docker", fake_restart_docker)
    monkeypatch.setattr(ib_gateway, "_probe_authenticated", fake_probe)


# --- Successful restart releases the lock ----------------------------------


def test_authenticated_restart_releases_2fa_lock(monkeypatch):
    """A restart that lands at authenticated must NOT leave a stale
    lock — otherwise the next legitimate restart (hours later) would
    be blocked until the lock TTL expired."""
    _patch_docker_mode(
        monkeypatch,
        restart_result={"restarted": True, "port_listening": True, "gateway_mode": "docker"},
        probe_result=(True, ["U1234567"]),
    )

    result = asyncio.run(ib_gateway.restart_ib_gateway())

    assert result["authenticated"] is True
    assert ib_2fa_lock.check_2fa_push_lock() is None, (
        "successful authenticated restart must release the lock so the next "
        "restart (potentially hours later) is not blocked by a stale lock"
    )


# --- Failed restart holds the lock for follow-up callers -------------------


def test_awaiting_2fa_restart_holds_lock(monkeypatch):
    """A restart that lands at awaiting_2fa MUST acquire the lock so
    a second 2FA push from another restart path (ib_watchdog etc.) is
    refused while the user is still trying to approve the first push."""
    _patch_docker_mode(
        monkeypatch,
        restart_result={"restarted": True, "port_listening": True, "gateway_mode": "docker"},
        probe_result=(False, []),
    )

    asyncio.run(ib_gateway.restart_ib_gateway())

    held = ib_2fa_lock.check_2fa_push_lock()
    assert held is not None, "awaiting_2fa restart must hold the lock"
    assert "restart_ib_gateway" in held.holder


def test_lock_held_blocks_second_restart_even_without_backoff(monkeypatch):
    """The whole point of the lock: if another holder is mid-2FA-push,
    refuse the restart entirely — even if the in-memory backoff would
    otherwise allow it (e.g. fresh process, watchdog firing while
    FastAPI just restarted)."""
    # Simulate "another restart path holds the lock RIGHT NOW".
    ok, _ = ib_2fa_lock.acquire_2fa_push_lock(
        "ib-watchdog", ttl_secs=600, reason="api hang threshold"
    )
    assert ok is True

    async def fail_restart_docker():
        raise AssertionError(
            "restart_ib_gateway must NOT call _restart_docker while another "
            "holder owns the 2FA push lock"
        )

    monkeypatch.setattr(ib_gateway, "is_cloud_mode", lambda: False)
    monkeypatch.setattr(ib_gateway, "is_docker_mode", lambda: True)
    monkeypatch.setattr(ib_gateway, "_restart_docker", fail_restart_docker)

    result = asyncio.run(ib_gateway.restart_ib_gateway())

    assert result["restarted"] is False
    assert result.get("deferred") is True
    assert result.get("reason") == "2fa_push_in_flight"
    assert "ib-watchdog" in result["error"]


def test_lock_held_by_same_holder_refreshes_and_proceeds(monkeypatch):
    """The lock is keyed by holder identity. A second
    ``restart_ib_gateway`` call inside the lock window must NOT
    deadlock against its own previous attempt — IBC may have died
    mid-2FA-dialog and the same holder needs to retry."""
    holder = "scripts.api.ib_gateway.restart_ib_gateway"
    ok, _ = ib_2fa_lock.acquire_2fa_push_lock(holder, ttl_secs=600)
    assert ok is True

    _patch_docker_mode(
        monkeypatch,
        restart_result={"restarted": True, "port_listening": True, "gateway_mode": "docker"},
        probe_result=(False, []),
    )

    result = asyncio.run(ib_gateway.restart_ib_gateway())
    assert result["restarted"] is True
    assert result["auth_state"] == "awaiting_2fa"


# --- Operator escape hatch must also release the lock ----------------------


def test_reset_restart_backoff_also_releases_2fa_lock():
    """`reset_restart_backoff` is the 'I just approved 2FA' button.
    It must clear the lock too, otherwise the next restart attempt
    would still be blocked by the in-flight lock."""
    ib_2fa_lock.acquire_2fa_push_lock("restart_ib_gateway", ttl_secs=600)
    assert ib_2fa_lock.check_2fa_push_lock() is not None

    ib_gateway.reset_restart_backoff()

    assert ib_2fa_lock.check_2fa_push_lock() is None


# --- TTL safety net --------------------------------------------------------


def test_expired_lock_does_not_block_new_restart(monkeypatch):
    """Defense in depth: if a holder crashes without releasing, the
    lock auto-expires and other restart paths get to proceed once the
    TTL passes."""
    # Hand-write an expired lock to disk.
    ib_2fa_lock.acquire_2fa_push_lock("crashed-holder", ttl_secs=1, now=time.time() - 10)

    _patch_docker_mode(
        monkeypatch,
        restart_result={"restarted": True, "port_listening": True, "gateway_mode": "docker"},
        probe_result=(False, []),
    )

    result = asyncio.run(ib_gateway.restart_ib_gateway())
    assert result["restarted"] is True
    # Fresh holder now owns the lock.
    held = ib_2fa_lock.check_2fa_push_lock()
    assert held is not None
    assert "restart_ib_gateway" in held.holder
