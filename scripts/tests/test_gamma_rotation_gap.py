from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _PROJECT_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from gamma_rotation_gap import compute_gamma_rotation


def _history_row(date: str, net_gamma: float) -> dict[str, str]:
    call_gamma = max(net_gamma, 0.0)
    put_gamma = min(net_gamma, 0.0)
    return {
        "date": date,
        "call_gamma": str(call_gamma),
        "put_gamma": str(put_gamma),
        "call_delta": "1000",
        "put_delta": "-500",
    }


def _history(values: list[float]) -> list[dict[str, str]]:
    return [_history_row(f"2026-01-{idx + 1:02d}", value) for idx, value in enumerate(values)]


def _strikes(net_positive: bool = True) -> list[dict[str, str]]:
    return [
        {"date": "2026-05-29", "strike": "520", "call_gex": "10", "put_gex": "-50", "call_delta": "1", "put_delta": "-2"},
        {"date": "2026-05-29", "strike": "540", "call_gex": "100", "put_gex": "-20", "call_delta": "1", "put_delta": "-2"},
        {"date": "2026-05-29", "strike": "560", "call_gex": "200" if net_positive else "10", "put_gex": "-30", "call_delta": "1", "put_delta": "-2"},
    ]


def test_compute_gamma_rotation_identifies_risk_on_divergence():
    spy = [100 + idx for idx in range(75)]
    tlt = [100 - idx * 3 for idx in range(75)]

    result = compute_gamma_rotation(
        spy_history_rows=_history(spy),
        tlt_history_rows=_history(tlt),
        spy_strike_rows=_strikes(),
        tlt_strike_rows=_strikes(False),
        spy_spot=555,
        tlt_spot=90,
        scan_time="2026-05-31T12:00:00Z",
        market_open=False,
    )

    assert result["signal"]["state"] == "RISK_ON_DIVERGENCE"
    assert result["assets"]["SPY"]["state"] == "CUSHION"
    assert result["assets"]["TLT"]["state"] == "WHIP"
    assert result["history"][-1]["state"] == "RISK_ON_DIVERGENCE"
    assert result["signal"]["grg_z"] is not None


def test_compute_gamma_rotation_rejects_short_history():
    with pytest.raises(ValueError, match="aligned observations"):
        compute_gamma_rotation(
            spy_history_rows=_history([1, 2, 3]),
            tlt_history_rows=_history([3, 2, 1]),
            spy_strike_rows=[],
            tlt_strike_rows=[],
            scan_time="2026-05-31T12:00:00Z",
        )


def test_writer_upserts_gamma_rotation_snapshot(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE gamma_rotation_snapshots (scan_time TEXT PRIMARY KEY, payload TEXT NOT NULL)")

    import db.client as client_mod
    monkeypatch.setattr(client_mod, "_cached", conn, raising=False)
    monkeypatch.setattr(client_mod, "get_db", lambda: conn)

    import importlib
    import db.writer as writer_mod
    importlib.reload(writer_mod)

    writer_mod.upsert_gamma_rotation_snapshot("2026-05-31T12:00:00Z", {"signal": {"state": "DUAL_CUSHION"}})
    writer_mod.upsert_gamma_rotation_snapshot("2026-05-31T12:00:00Z", {"signal": {"state": "DUAL_WHIP"}})

    rows = conn.execute("SELECT payload FROM gamma_rotation_snapshots").fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0][0])["signal"]["state"] == "DUAL_WHIP"
