"""Tests for /index-options/chain (Phase 3 — VIX/SPX/NDX options)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

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


def _fake_option(*, conId, localSymbol, expiry, strike, right):
    contract = MagicMock()
    contract.conId = conId
    contract.symbol = "VIX"
    contract.localSymbol = localSymbol
    contract.exchange = "CBOE"
    contract.currency = "USD"
    contract.lastTradeDateOrContractMonth = expiry
    contract.strike = strike
    contract.right = right
    contract.multiplier = "100"
    contract.tradingClass = "VIX"
    cd = MagicMock()
    cd.contract = contract
    cd.minTick = 0.05
    return cd


def test_index_options_chain_returns_sorted_contracts(client, monkeypatch):
    from scripts.api import server

    fake_pool = MagicMock()
    pool_client = MagicMock()
    pool_client.ib.reqContractDetails = MagicMock(return_value=[
        _fake_option(conId=3, localSymbol="VIX_C25", expiry="20260721", strike=25.0, right="C"),
        _fake_option(conId=1, localSymbol="VIX_C20", expiry="20260616", strike=20.0, right="C"),
        _fake_option(conId=2, localSymbol="VIX_P20", expiry="20260616", strike=20.0, right="P"),
    ])

    class _PoolCtx:
        async def __aenter__(self):
            return pool_client
        async def __aexit__(self, *args):
            return False

    fake_pool.acquire = MagicMock(return_value=_PoolCtx())
    monkeypatch.setattr(server, "ib_pool", fake_pool)

    resp = client.get("/index-options/chain?symbol=VIX")
    assert resp.status_code == 200
    body = resp.json()
    assert body["symbol"] == "VIX"
    assert body["exchange"] == "CBOE"
    assert body["tradingClass"] == "VIX"
    assert body["count"] == 3
    # Sort: expiry asc, then strike asc, then right asc
    assert [c["conId"] for c in body["contracts"]] == [1, 2, 3]
    assert body["expirations"] == ["20260616", "20260721"]


def test_unsupported_symbol_returns_400(client):
    resp = client.get("/index-options/chain?symbol=AAPL")
    assert resp.status_code == 400
    assert "index options not supported" in resp.json()["detail"]


def test_pool_not_initialised_returns_503(client, monkeypatch):
    from scripts.api import server
    monkeypatch.setattr(server, "ib_pool", None)
    resp = client.get("/index-options/chain?symbol=VIX")
    assert resp.status_code == 503


def test_expiry_filter_forwarded_to_contract(client, monkeypatch):
    """Ensure expiry param is plumbed into the contract spec passed to IB."""
    from scripts.api import server

    captured_spec = {}
    fake_pool = MagicMock()
    pool_client = MagicMock()

    def _capture(spec):
        captured_spec["spec"] = spec
        return []

    pool_client.ib.reqContractDetails = MagicMock(side_effect=_capture)

    class _PoolCtx:
        async def __aenter__(self):
            return pool_client
        async def __aexit__(self, *args):
            return False

    fake_pool.acquire = MagicMock(return_value=_PoolCtx())
    monkeypatch.setattr(server, "ib_pool", fake_pool)

    resp = client.get("/index-options/chain?symbol=VIX&expiry=20260617")
    assert resp.status_code == 200
    assert captured_spec["spec"].lastTradeDateOrContractMonth == "20260617"
    assert captured_spec["spec"].exchange == "CBOE"
    assert captured_spec["spec"].tradingClass == "VIX"


def test_case_insensitive(client, monkeypatch):
    from scripts.api import server

    fake_pool = MagicMock()
    pool_client = MagicMock()
    pool_client.ib.reqContractDetails = MagicMock(return_value=[])

    class _PoolCtx:
        async def __aenter__(self):
            return pool_client
        async def __aexit__(self, *args):
            return False

    fake_pool.acquire = MagicMock(return_value=_PoolCtx())
    monkeypatch.setattr(server, "ib_pool", fake_pool)

    resp = client.get("/index-options/chain?symbol=vix")
    assert resp.status_code == 200
    assert resp.json()["symbol"] == "VIX"
