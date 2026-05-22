"""Tests for /futures/chain (Phase 2 — VIX futures)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture(autouse=True)
def localhost_bypass(monkeypatch):
    from scripts.api import server, auth
    monkeypatch.setattr(auth, "is_local_or_tailnet", lambda host: True)
    monkeypatch.setattr(server, "is_local_or_tailnet", lambda host: True)
    yield


@pytest.fixture
def client():
    from scripts.api.server import app
    return TestClient(app)


def _fake_contract(*, conId, localSymbol, expiry):
    """Match the shape ib_insync ContractDetails returns: .contract.{...}"""
    contract = MagicMock()
    contract.conId = conId
    contract.symbol = "VIX"
    contract.localSymbol = localSymbol
    contract.exchange = "CFE"
    contract.currency = "USD"
    contract.lastTradeDateOrContractMonth = expiry
    contract.multiplier = "1000"
    contract.tradingClass = "VX"
    cd = MagicMock()
    cd.contract = contract
    cd.marketName = "VX"
    cd.minTick = 0.05
    return cd


def test_futures_chain_returns_sorted_contracts(client, monkeypatch):
    """Happy path: pool returns 3 contracts unsorted, route sorts them by expiry."""
    from scripts.api import server

    fake_pool = MagicMock()
    pool_client = MagicMock()
    pool_client.ib.reqContractDetails = MagicMock(return_value=[
        _fake_contract(conId=2, localSymbol="VXN6", expiry="20260722"),
        _fake_contract(conId=1, localSymbol="VXM6", expiry="20260617"),
        _fake_contract(conId=3, localSymbol="VXQ6", expiry="20260819"),
    ])

    class _PoolCtx:
        async def __aenter__(self):
            return pool_client
        async def __aexit__(self, *args):
            return False

    fake_pool.acquire = MagicMock(return_value=_PoolCtx())
    monkeypatch.setattr(server, "ib_pool", fake_pool)

    resp = client.get("/futures/chain?symbol=VIX")
    assert resp.status_code == 200
    body = resp.json()
    assert body["symbol"] == "VIX"
    assert body["exchange"] == "CFE"
    assert body["count"] == 3
    # Sorted ascending — front month first.
    assert [c["localSymbol"] for c in body["contracts"]] == ["VXM6", "VXN6", "VXQ6"]
    assert body["contracts"][0]["conId"] == 1


def test_futures_chain_unsupported_symbol_returns_400(client):
    resp = client.get("/futures/chain?symbol=AAPL")
    assert resp.status_code == 400
    assert "futures not supported" in resp.json()["detail"]


def test_futures_chain_handles_pool_timeout(client, monkeypatch):
    from scripts.api import server
    import time

    fake_pool = MagicMock()
    pool_client = MagicMock()

    def _hang(*args, **kwargs):
        # Sleep past the route's 15s asyncio.wait_for budget.
        time.sleep(20)
        return []

    pool_client.ib.reqContractDetails = _hang

    class _PoolCtx:
        async def __aenter__(self):
            return pool_client
        async def __aexit__(self, *args):
            return False

    fake_pool.acquire = MagicMock(return_value=_PoolCtx())
    monkeypatch.setattr(server, "ib_pool", fake_pool)

    # Override wait_for budget to 0.1s so the test runs quickly.
    monkeypatch.setattr(server, "_FUTURES_CHAIN_TIMEOUT_S", 0.1, raising=False)

    resp = client.get("/futures/chain?symbol=VIX")
    assert resp.status_code == 504
    assert "timed out" in resp.json()["detail"].lower()


def test_futures_chain_returns_503_when_pool_not_initialised(client, monkeypatch):
    from scripts.api import server
    monkeypatch.setattr(server, "ib_pool", None)
    resp = client.get("/futures/chain?symbol=VIX")
    assert resp.status_code == 503


def test_futures_chain_case_insensitive(client, monkeypatch):
    from scripts.api import server

    fake_pool = MagicMock()
    pool_client = MagicMock()
    pool_client.ib.reqContractDetails = MagicMock(return_value=[
        _fake_contract(conId=1, localSymbol="VXM6", expiry="20260617"),
    ])

    class _PoolCtx:
        async def __aenter__(self):
            return pool_client
        async def __aexit__(self, *args):
            return False

    fake_pool.acquire = MagicMock(return_value=_PoolCtx())
    monkeypatch.setattr(server, "ib_pool", fake_pool)

    resp = client.get("/futures/chain?symbol=vix")
    assert resp.status_code == 200
    assert resp.json()["symbol"] == "VIX"
