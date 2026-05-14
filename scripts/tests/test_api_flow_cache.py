"""Tests for the cache-write gate in POST /flow-analysis/<ticker>.

Regression: `scripts/fetch_flow.py` swallows every `UWAPIError` subclass
(rate-limit, 5xx, auth) and returns `[]`. The aggregator then produces
a structurally empty "success" payload with `analysis.num_prints == 0`
and `dark_pool.flow_direction == "NO_DATA"`. The GET handler was
serving that as a valid cache for 600s, surfacing as a phantom
"NO DATA" view of healthy tickers. The server now refuses to write the
empty payload to `data/flow_reports/<TICKER>.json` so the next POST
retries against UW and the GET route falls back to the prior valid
cache. Surfaced 2026-05-14 against GOOGL.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


def _result_with(num_prints: int) -> SimpleNamespace:
    """Stub the ScriptResult shape that `run_script` returns. Minimum
    fields required by the route: `ok`, `error`, `data`.
    """
    return SimpleNamespace(
        ok=True,
        error=None,
        data={
            "ticker": "GOOGL",
            "verdict": {"direction": "NEUTRAL", "confidence": 0},
            "analysis": {"num_prints": num_prints, "score": 0},
            "dark_pool": {"flow_direction": "NO_DATA" if num_prints == 0 else "ACCUMULATION"},
            "options_flow": {},
        },
    )


@pytest.fixture
def app_client(monkeypatch):
    """Late-imported FastAPI TestClient.

    Auth bypass: the server's auth middleware short-circuits when
    CLERK_JWKS_URL is unset (the "no auth configured" dev path). The
    server module loads .env at import time which re-sets the var, so
    we must delenv AFTER import for the runtime check to fail.
    """
    from fastapi.testclient import TestClient
    from api import server  # noqa: WPS433 — import-after-path

    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)

    return TestClient(server.app), server


class TestEmptyAggregateGate:
    def test_skips_cache_write_when_num_prints_zero(self, app_client, tmp_path):
        client, server = app_client
        target = tmp_path / "GOOGL.json"
        cache_writes: list[Path] = []

        async def _fake_run_script(*_args, **_kwargs):
            return _result_with(num_prints=0)

        def _fake_write_cache(path, data):
            cache_writes.append(path)

        with patch.object(server, "run_script", _fake_run_script), \
             patch.object(server, "_write_cache", _fake_write_cache), \
             patch.object(server, "_FLOW_REPORTS_DIR", tmp_path):

            resp = client.post("/flow-analysis/GOOGL")

        assert resp.status_code == 200
        # Response body is still the raw aggregator output so the UI can
        # show the user the result of *this* POST. Only the persistent
        # cache is gated.
        assert resp.json()["analysis"]["num_prints"] == 0
        # The cache was NOT written — the prior valid cache (if any)
        # is preserved.
        assert cache_writes == [], "Expected _write_cache to be skipped on empty aggregate"
        assert not target.exists()

    def test_writes_cache_when_num_prints_positive(self, app_client, tmp_path):
        client, server = app_client
        cache_writes: list[Path] = []

        async def _fake_run_script(*_args, **_kwargs):
            return _result_with(num_prints=2500)

        def _fake_write_cache(path, data):
            cache_writes.append(path)

        with patch.object(server, "run_script", _fake_run_script), \
             patch.object(server, "_write_cache", _fake_write_cache), \
             patch.object(server, "_FLOW_REPORTS_DIR", tmp_path):

            resp = client.post("/flow-analysis/GOOGL")

        assert resp.status_code == 200
        assert resp.json()["analysis"]["num_prints"] == 2500
        assert len(cache_writes) == 1
        assert cache_writes[0].name == "GOOGL.json"

    def test_writes_cache_when_analysis_missing_falsy_path(self, app_client, tmp_path):
        """Safety: a malformed payload with no `analysis` key counts as
        zero. Don't poison the cache with structurally broken data.
        """
        client, server = app_client
        cache_writes: list[Path] = []

        async def _fake_run_script(*_args, **_kwargs):
            return SimpleNamespace(
                ok=True,
                error=None,
                data={"ticker": "GOOGL", "verdict": {"direction": "NEUTRAL"}},
            )

        def _fake_write_cache(path, data):
            cache_writes.append(path)

        with patch.object(server, "run_script", _fake_run_script), \
             patch.object(server, "_write_cache", _fake_write_cache), \
             patch.object(server, "_FLOW_REPORTS_DIR", tmp_path):

            resp = client.post("/flow-analysis/GOOGL")

        assert resp.status_code == 200
        assert cache_writes == []
