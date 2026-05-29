"""The public /health surface must not leak account IDs, IB auth/connection
state, or internal topology.

`/health` is auth-exempt and reachable from the public internet via Caddy's
`handle_path /api/ib/*` (→ /api/ib/health). Untrusted (proxied/public) callers
therefore get liveness only; trusted local/tailnet callers — the admin panel
via server-side radonFetch, the watchdogs curling 127.0.0.1:8321/health — keep
the full payload. The untrusted branch must also short-circuit BEFORE
check_ib_gateway() so an internet GET can't drive the pool-reconnect / heal
side effects on that call path.
"""

import os
import sys
from types import SimpleNamespace

import pytest

_scripts_dir = os.path.join(os.path.dirname(__file__), os.pardir, os.pardir)
sys.path.insert(0, os.path.abspath(_scripts_dir))

from scripts.api import server


def _request(host, extra_headers=None):
    return SimpleNamespace(
        client=SimpleNamespace(host=host) if host is not None else None,
        headers=extra_headers or {},
        url=SimpleNamespace(path="/health"),
    )


# Fields that must never reach an untrusted caller.
_SENSITIVE_KEYS = {"ib_gateway", "ib_pool", "auth_state", "managed_accounts", "restart_backoff"}


class TestHealthPayloadScoping:
    @pytest.mark.asyncio
    async def test_public_proxied_caller_gets_liveness_only(self, monkeypatch):
        # Loopback peer + forwarding header == arrived through Caddy. Must get
        # liveness only, and must NOT invoke check_ib_gateway (no side effects).
        called = {"gw": False}

        async def _should_not_run(*args, **kwargs):
            called["gw"] = True
            return {"auth_state": "authenticated", "managed_accounts": ["U1234567"]}

        monkeypatch.setattr(server, "check_ib_gateway", _should_not_run)

        req = _request("127.0.0.1", {"X-Forwarded-For": "8.8.8.8"})
        result = await server.health(req)

        assert result == {"status": "ok"}
        assert not (_SENSITIVE_KEYS & set(result)), result
        assert called["gw"] is False  # side-effect-free for untrusted callers

    @pytest.mark.asyncio
    async def test_public_direct_caller_gets_liveness_only(self, monkeypatch):
        async def _should_not_run(*args, **kwargs):
            raise AssertionError("check_ib_gateway must not run for public callers")

        monkeypatch.setattr(server, "check_ib_gateway", _should_not_run)

        req = _request("8.8.8.8")  # real remote IP (uvicorn proxy-headers rewrite)
        result = await server.health(req)

        assert result == {"status": "ok"}

    @pytest.mark.asyncio
    async def test_trusted_local_caller_gets_full_payload(self, monkeypatch):
        async def _gw(*args, **kwargs):
            return {"auth_state": "authenticated", "managed_accounts": ["U1234567"], "port": 4001}

        monkeypatch.setattr(server, "check_ib_gateway", _gw)
        monkeypatch.setattr(server, "ib_pool", SimpleNamespace(status=lambda: {"sync": {"connected": True}}))

        req = _request("127.0.0.1")  # loopback, no forwarding headers
        result = await server.health(req)

        assert result["status"] == "ok"
        assert result["ib_gateway"]["auth_state"] == "authenticated"
        assert result["ib_gateway"]["managed_accounts"] == ["U1234567"]
        assert result["ib_pool"] == {"sync": {"connected": True}}

    @pytest.mark.asyncio
    async def test_trusted_tailnet_caller_gets_full_payload(self, monkeypatch):
        async def _gw(*args, **kwargs):
            return {"auth_state": "awaiting_2fa"}

        monkeypatch.setattr(server, "check_ib_gateway", _gw)
        monkeypatch.setattr(server, "ib_pool", SimpleNamespace(status=lambda: {}))

        req = _request("100.112.32.16")  # cloud-thin laptop over Tailscale
        result = await server.health(req)

        assert result["ib_gateway"]["auth_state"] == "awaiting_2fa"
