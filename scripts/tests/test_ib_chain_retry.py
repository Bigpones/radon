"""ib_chain.py transient-farm resilience.

The futures/index-option chain endpoint must ride out IB Gateway data-farm
flaps (secdefil/ushmds "connection is broken") instead of failing the order
ticket after one connect attempt. These tests inject a fake IBClient so no
live gateway is needed.
"""

from types import SimpleNamespace

import pytest

from scripts import ib_chain


def _make_detail():
    contract = SimpleNamespace(
        conId=649180678, symbol="ES", localSymbol="ESM6", exchange="CME",
        currency="USD", lastTradeDateOrContractMonth="20260618",
        multiplier="50", tradingClass="ES", strike=0.0, right="",
    )
    return SimpleNamespace(contract=contract, minTick=0.25)


class _FakeIB:
    def __init__(self, details_sequence):
        self._seq = list(details_sequence)
        self.sleep_calls = 0

    def reqContractDetails(self, _spec):
        return self._seq.pop(0) if self._seq else []

    def sleep(self, _s):
        self.sleep_calls += 1


class _FakeClient:
    def __init__(self, fail_connects=0, details_sequence=None):
        self._fail_connects = fail_connects
        self.connect_calls = 0
        self.ib = _FakeIB(details_sequence if details_sequence is not None else [[_make_detail()]])
        self.disconnected = False

    def connect(self, **_kw):
        self.connect_calls += 1
        if self.connect_calls <= self._fail_connects:
            raise RuntimeError("API connection failed: TimeoutError (secdefil broken)")

    def disconnect(self):
        self.disconnected = True


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    # Don't actually wait out the backoff in tests.
    monkeypatch.setattr(ib_chain.time, "sleep", lambda _s: None)


def _patch_client(monkeypatch, client):
    monkeypatch.setattr(ib_chain, "IBClient", lambda *a, **k: client)
    return client


def test_connect_retries_then_succeeds(monkeypatch):
    client = _patch_client(monkeypatch, _FakeClient(fail_connects=2))
    out = ib_chain.fetch_chain("future", "SPX")
    assert "error" not in out
    assert out["count"] == 1 and out["contracts"][0]["symbol"] == "ES"
    assert client.connect_calls == 3  # failed twice, succeeded on the third
    assert client.disconnected is True


def test_empty_details_retried_until_populated(monkeypatch):
    client = _patch_client(
        monkeypatch, _FakeClient(fail_connects=0, details_sequence=[[], [], [_make_detail()]]),
    )
    out = ib_chain.fetch_chain("future", "SPX")
    assert out["count"] == 1
    assert client.ib.sleep_calls >= 1  # waited for the farm to settle between tries


def test_all_connect_attempts_fail_returns_error(monkeypatch):
    client = _patch_client(monkeypatch, _FakeClient(fail_connects=99))
    out = ib_chain.fetch_chain("future", "SPX")
    assert out.get("error", "").startswith("IB connect failed")
    assert client.connect_calls == ib_chain._CONNECT_ATTEMPTS


def test_persistently_empty_details_returns_empty_chain(monkeypatch):
    # Genuinely-unlisted symbol path: connect ok, details always empty ->
    # bounded retries, then an empty (not errored) chain.
    client = _patch_client(monkeypatch, _FakeClient(fail_connects=0, details_sequence=[[], [], []]))
    out = ib_chain.fetch_chain("future", "SPX")
    assert out["count"] == 0 and out["contracts"] == []
    assert client.ib.sleep_calls == ib_chain._DETAILS_ATTEMPTS - 1
