"""Regression for the pytest-poisoning guard in `db.client.get_db()`.

A full `pytest scripts/tests/` run on 2026-05-14 with production
Turso credentials in scope silently wrote two MagicMock-tainted rows
into the production journal table. The guard now refuses to open a
real connection when `PYTEST_CURRENT_TEST` is set, unless the caller
explicitly opts in via `RADON_DB_TEST_WRITE_OK=1`.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _PROJECT_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


def _fresh_client_module():
    """Reload `db.client` so the module-level `_cached` singleton is
    reset between cases and each test exercises the cold path.
    """
    import db.client as client_mod  # noqa: WPS433
    importlib.reload(client_mod)
    return client_mod


class TestPytestGuard:
    def test_refuses_real_connection_under_pytest_without_override(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        client_mod = _fresh_client_module()
        # PYTEST_CURRENT_TEST is set by pytest itself for every test run.
        # Make sure the override is absent.
        monkeypatch.delenv("RADON_DB_TEST_WRITE_OK", raising=False)
        monkeypatch.setenv("TURSO_DB_URL", "libsql://example.invalid")
        monkeypatch.setenv("TURSO_AUTH_TOKEN", "fake-token")

        with pytest.raises(RuntimeError, match="without a monkeypatch"):
            client_mod.get_db()

    def test_allows_connection_with_explicit_override(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """RADON_DB_TEST_WRITE_OK=1 lets the connection through. We don't
        verify the connection actually opens (no real Turso reachable in
        tests) — just that the guard does NOT short-circuit.
        """
        client_mod = _fresh_client_module()
        monkeypatch.setenv("RADON_DB_TEST_WRITE_OK", "1")
        monkeypatch.setenv("TURSO_DB_URL", "libsql://example.invalid")
        monkeypatch.setenv("TURSO_AUTH_TOKEN", "fake-token")
        # The actual libsql.connect call will fail at the network layer.
        # We catch every exception EXCEPT our guard's RuntimeError to
        # prove the guard let the call through.
        try:
            client_mod.get_db()
        except RuntimeError as exc:
            if "without a monkeypatch" in str(exc):
                pytest.fail("Guard should have been bypassed with RADON_DB_TEST_WRITE_OK=1")
            # Any other RuntimeError (e.g. from libsql) is fine.
        except Exception:
            # Network / libsql errors are expected.
            pass

    def test_allows_connection_when_monkeypatched_get_db(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The canonical pattern: tests monkeypatch get_db itself to
        return an in-memory sqlite. The guard never runs because the
        function reference is replaced.
        """
        client_mod = _fresh_client_module()
        sentinel = object()
        monkeypatch.setattr(client_mod, "get_db", lambda: sentinel)
        assert client_mod.get_db() is sentinel
