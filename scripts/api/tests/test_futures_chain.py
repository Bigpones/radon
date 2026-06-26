"""Tests for /futures/chain (Phase 2 — VIX futures).

Subprocess-backed since the rewrite — patches `run_script` rather
than `ib_pool` for the same reason test_ticker_ratings_and_pi.py does.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

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


@pytest.fixture(autouse=True)
def isolated_cache_dir(tmp_path, monkeypatch):
    """Point the futures-chain cache at a tmp dir so tests never read/write the
    real data/ dir and start from a clean (cache-miss) state."""
    from scripts.api import server
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    return tmp_path


def _today_et_str() -> str:
    return datetime.now(timezone.utc).astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def _write_chain_cache(cache_dir: Path, symbol: str, *, as_of_date: str, contracts):
    payload = {
        "symbol": symbol,
        "exchange": "CFE",
        "contracts": contracts,
        "count": len(contracts),
        "as_of": datetime.now(timezone.utc).isoformat(),
        "as_of_date": as_of_date,
        "stale": False,
    }
    (cache_dir / f"futures_chain_{symbol}.json").write_text(json.dumps(payload))
    return payload


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


# ── Cache hardening ─────────────────────────────────────────────────


def test_same_day_cache_hit_skips_subprocess(client, isolated_cache_dir):
    """A same-day cache with contracts is served immediately, no live call."""
    _write_chain_cache(
        isolated_cache_dir,
        "VIX",
        as_of_date=_today_et_str(),
        contracts=[{"conId": 1, "localSymbol": "VXM6"}],
    )

    async def _stub(*args, **kwargs):
        raise AssertionError("run_script must not be called on a same-day cache hit")

    with patch("scripts.api.server.run_script", side_effect=_stub):
        resp = client.get("/futures/chain?symbol=VIX")

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["stale"] is False


def test_subprocess_failure_with_cache_returns_stale_not_502(client, isolated_cache_dir):
    """A cross-day (stale) cache present + subprocess failure → serve the cache
    flagged stale, never a 502, so the order ticket never shows a timeout."""
    _write_chain_cache(
        isolated_cache_dir,
        "VIX",
        as_of_date="2000-01-01",  # cross-day → forces the live attempt
        contracts=[{"conId": 9, "localSymbol": "VXOLD"}],
    )

    async def _stub(*args, **kwargs):
        return _fake_script_result(ok=False, error="The operation was aborted due to timeout", exit_code=1)

    with patch("scripts.api.server.run_script", side_effect=_stub) as run_mock:
        resp = client.get("/futures/chain?symbol=VIX")

    assert run_mock.called  # cross-day cache still attempts a refresh
    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["contracts"][0]["conId"] == 9


def test_success_writes_cache(client, isolated_cache_dir):
    payload = {
        "symbol": "VIX",
        "exchange": "CFE",
        "contracts": [{"conId": 1, "localSymbol": "VXM6"}],
        "count": 1,
    }

    async def _stub(*args, **kwargs):
        return _fake_script_result(ok=True, data=payload)

    with patch("scripts.api.server.run_script", side_effect=_stub):
        resp = client.get("/futures/chain?symbol=VIX")

    assert resp.status_code == 200
    body = resp.json()
    assert body["as_of_date"] == _today_et_str()
    assert body["stale"] is False

    cache_file = isolated_cache_dir / "futures_chain_VIX.json"
    assert cache_file.exists()
    persisted = json.loads(cache_file.read_text())
    assert persisted["count"] == 1
    assert persisted["as_of_date"] == _today_et_str()
