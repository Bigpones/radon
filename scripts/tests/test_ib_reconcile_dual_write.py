"""Phase 4 — verify ib_reconcile.save_json triggers a Turso dual-write
ONLY when the destination is reconciliation.json. Other JSON writes via
the same helper (defensive — there are none today, but the matcher
should be path-specific) must NOT touch the DB.
"""
from __future__ import annotations

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
    calls: list[dict[str, Any]] = []
    fake = types.ModuleType("db.writer")
    fake.upsert_reconciliation_log = lambda snapshot_at, payload: calls.append(  # type: ignore[attr-defined]
        {"snapshot_at": snapshot_at, "payload": payload}
    )
    monkeypatch.setitem(sys.modules, "db.writer", fake)
    if "ib_reconcile" in sys.modules:
        del sys.modules["ib_reconcile"]
    yield calls


def test_save_json_to_reconciliation_path_dual_writes(mock_writer, tmp_path: Path):
    import ib_reconcile

    target = tmp_path / "reconciliation.json"
    payload = {"snapshot_at": "2026-05-07T01:00:00Z", "diffs": []}
    ib_reconcile.save_json(str(target), payload)

    assert target.exists()
    assert len(mock_writer) == 1
    assert mock_writer[0]["snapshot_at"] == "2026-05-07T01:00:00Z"


def test_save_json_to_other_paths_does_not_dual_write(mock_writer, tmp_path: Path):
    import ib_reconcile

    target = tmp_path / "other.json"
    ib_reconcile.save_json(str(target), {"foo": "bar"})

    assert target.exists()
    assert mock_writer == []


def test_save_json_falls_back_to_now_when_payload_missing_timestamp(mock_writer, tmp_path: Path):
    import ib_reconcile

    target = tmp_path / "reconciliation.json"
    ib_reconcile.save_json(str(target), {"diffs": []})  # no snapshot_at / timestamp

    assert len(mock_writer) == 1
    assert mock_writer[0]["snapshot_at"]  # non-empty


def test_save_json_db_failure_does_not_break_disk_write(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    fake = types.ModuleType("db.writer")
    fake.upsert_reconciliation_log = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom"))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "db.writer", fake)
    if "ib_reconcile" in sys.modules:
        del sys.modules["ib_reconcile"]
    import ib_reconcile

    target = tmp_path / "reconciliation.json"
    ib_reconcile.save_json(str(target), {"diffs": []})  # must not raise
    assert target.exists()
