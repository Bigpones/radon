"""Tests for /futures/chain (Phase 2 — VIX futures).

Subprocess-backed since the rewrite — patches `run_script` rather
than `ib_pool` for the same reason test_ticker_ratings_and_pi.py does.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture(autouse=True)
def localhost_bypass(monkeypatch):
    from scripts.api import server, auth
    monkeypatch.setattr(auth, "is_trusted_local_request", lambda request: True)
    monkeypatch.setattr(server, "is_trusted_local_request", lambda request: True)
    yield


@pytest.fixture
def client():
    from scripts.api.server import app
    return TestClient(app)


def _fake_script_result(*, ok=True, data=None, error=None, exit_code=0):
    from api.subprocess import ScriptResult
    return ScriptResult(ok=ok, data=data, error=error, exit_code=exit_code)


def test_futures_chain_returns_payload(client):
    payload = {
        "symbol": "VIX",
        "exchange": "CFE",
        "contracts": [
            {"conId": 1, "localSymbol": "VXM6", "lastTradeDateOrContractMonth": "20260617", "multiplier": "1000"},
            {"conId": 2, "localSymbol": "VXN6", "lastTradeDateOrContractMonth": "20260722", "multiplier": "1000"},
        ],
        "count": 2,
    }

    async def _stub(*args, **kwargs):
        return _fake_script_result(ok=True, data=payload)

    with patch("scripts.api.server.run_script", side_effect=_stub) as run_mock:
        resp = client.get("/futures/chain?symbol=VIX")

    assert resp.status_code == 200
    body = resp.json()
    assert body["symbol"] == "VIX"
    assert body["count"] == 2
    args, kwargs = run_mock.call_args
    assert args[0] == "ib_chain.py"
    assert "future" in args[1]
    assert "VIX" in args[1]


def test_unsupported_symbol_returns_400(client):
    resp = client.get("/futures/chain?symbol=AAPL")
    assert resp.status_code == 400
    assert "futures not supported" in resp.json()["detail"]


def test_subprocess_failure_returns_502(client):
    async def _stub(*args, **kwargs):
        return _fake_script_result(ok=False, error="boom", exit_code=1)

    with patch("scripts.api.server.run_script", side_effect=_stub):
        resp = client.get("/futures/chain?symbol=VIX")
    assert resp.status_code == 502
    assert "boom" in resp.json()["detail"]


def test_script_error_payload_returns_502(client):
    """If the subprocess returns ok but data.error is set (e.g. IB connect
    failed), the route surfaces that as 502."""
    async def _stub(*args, **kwargs):
        return _fake_script_result(ok=True, data={"error": "IB connect failed: socket"})

    with patch("scripts.api.server.run_script", side_effect=_stub):
        resp = client.get("/futures/chain?symbol=VIX")
    assert resp.status_code == 502
    assert "IB connect failed" in resp.json()["detail"]


def test_case_insensitive(client):
    payload = {"symbol": "VIX", "exchange": "CFE", "contracts": [], "count": 0}

    async def _stub(*args, **kwargs):
        return _fake_script_result(ok=True, data=payload)

    with patch("scripts.api.server.run_script", side_effect=_stub) as run_mock:
        resp = client.get("/futures/chain?symbol=vix")
    assert resp.status_code == 200
    args, _ = run_mock.call_args
    assert "VIX" in args[1]
