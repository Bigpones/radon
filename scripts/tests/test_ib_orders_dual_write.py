"""Phase 3.2 — verify ib_orders._dual_write_orders_to_db calls the right
upsert helpers with the right shape. Doesn't connect to IB; mocks only
the writer-side surface.
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import Any

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _PROJECT_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


@pytest.fixture
def mock_writer(monkeypatch: pytest.MonkeyPatch):
    """Stub db.writer with capturing implementations of the three helpers
    ib_orders.py invokes. Returns the captured-calls dict so tests can
    assert against it."""
    calls: dict[str, list[Any]] = {
        "ensure_no_replica_for_writers": [],
        "record_service_health": [],
        "replace_open_orders_for_session": [],
        "upsert_executed_order": [],
    }

    fake = types.ModuleType("db.writer")
    fake.ensure_no_replica_for_writers = lambda: calls["ensure_no_replica_for_writers"].append(True)  # type: ignore[attr-defined]
    fake.record_service_health = lambda *a, **kw: calls["record_service_health"].append((a, kw))  # type: ignore[attr-defined]
    fake.replace_open_orders_for_session = lambda rows: calls["replace_open_orders_for_session"].append(rows)  # type: ignore[attr-defined]
    fake.upsert_executed_order = lambda exec_id, payload, fill_time, perm_id=None: calls["upsert_executed_order"].append(  # type: ignore[attr-defined]
        {"exec_id": exec_id, "payload": payload, "fill_time": fill_time, "perm_id": perm_id}
    )

    monkeypatch.setitem(sys.modules, "db.writer", fake)

    # Reload ib_orders so its _dual_write_orders_to_db re-imports the stub.
    if "ib_orders" in sys.modules:
        del sys.modules["ib_orders"]
    yield calls


def test_dual_write_replaces_open_orders_with_perm_ids(mock_writer):
    import ib_orders  # imported AFTER mock_writer fixture stubs db.writer

    data = {
        "last_sync": "2026-05-07T00:00:00Z",
        "open_orders": [
            {"permId": 9001, "symbol": "AAPL", "action": "BUY"},
            {"permId": 9002, "symbol": "MSFT", "action": "SELL"},
            {"permId": None, "symbol": "GOOG"},  # ← skipped (no permId)
            {"symbol": "AMZN"},  # ← skipped (no permId field)
        ],
        "executed_orders": [],
    }
    ib_orders._dual_write_orders_to_db(data)

    rows = mock_writer["replace_open_orders_for_session"]
    assert len(rows) == 1
    perm_ids = sorted(r[0] for r in rows[0])
    assert perm_ids == [9001, 9002]


def test_dual_write_upserts_each_executed_order_by_exec_id(mock_writer):
    import ib_orders

    data = {
        "last_sync": "2026-05-07T00:00:00Z",
        "open_orders": [],
        "executed_orders": [
            {
                "execId": "exec-1",
                "side": "BOT",
                "quantity": 10,
                "avgPrice": 10.0,
                "time": "2026-05-06T18:17:23+00:00",
                "contract": {"symbol": "TSLA"},
            },
            {
                "execId": "exec-2",
                "side": "SLD",
                "quantity": 5,
                "avgPrice": 5.5,
                "time": "2026-05-06T19:00:00Z",
                "contract": {"symbol": "WULF"},
            },
            {
                # missing execId — must be skipped
                "side": "BOT",
                "time": "2026-05-06T19:00:00Z",
                "contract": {"symbol": "BAD"},
            },
        ],
    }
    ib_orders._dual_write_orders_to_db(data)

    upserts = mock_writer["upsert_executed_order"]
    assert sorted(u["exec_id"] for u in upserts) == ["exec-1", "exec-2"]
    assert all(u["fill_time"] for u in upserts)


def test_dual_write_records_service_health_on_success(mock_writer):
    import ib_orders
    ib_orders._dual_write_orders_to_db({"last_sync": "2026-05-07T00:00:00Z", "open_orders": [], "executed_orders": []})
    rows = mock_writer["record_service_health"]
    assert len(rows) == 1
    args, kwargs = rows[0]
    assert args[0] == "orders-sync"
    assert args[1] == "ok"


def test_dual_write_records_error_on_writer_exception(monkeypatch: pytest.MonkeyPatch, mock_writer):
    import ib_orders
    # Force replace_open_orders_for_session to throw; verify error path
    # records a non-OK service_health row.
    fake = sys.modules["db.writer"]
    setattr(fake, "replace_open_orders_for_session", lambda rows: (_ for _ in ()).throw(RuntimeError("WAL locked")))
    ib_orders._dual_write_orders_to_db({
        "last_sync": "2026-05-07T00:00:00Z",
        "open_orders": [{"permId": 9001}],
        "executed_orders": [],
    })
    health = mock_writer["record_service_health"]
    states = [args[1] for args, _ in health]
    assert "error" in states


def test_dual_write_no_op_on_import_error(monkeypatch: pytest.MonkeyPatch):
    # Strip db.writer from sys.modules and make it raise on import.
    if "ib_orders" in sys.modules:
        del sys.modules["ib_orders"]
    monkeypatch.setitem(sys.modules, "db.writer", None)  # forces ImportError
    import ib_orders
    # Should not raise.
    ib_orders._dual_write_orders_to_db({"open_orders": [], "executed_orders": []})
