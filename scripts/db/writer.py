"""libSQL writer helpers for Python schedulers.

Symmetric to scripts/db/writer.js. Each function takes a ready-to-write
payload (dict, list, etc.) and returns once the row has reached the
embedded replica (sync to cloud is async, single-digit-second).

Schedulers should use these helpers from inside their existing
file-write code paths so the migration is dual-write — the JSON file
remains authoritative until Phase 6 retires it.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Optional

try:
    # When imported as `scripts.db.writer` from project root.
    from .client import get_db
except ImportError:  # pragma: no cover
    # When imported flat after sys.path.insert(scripts/) like the existing
    # services do (cta_sync_service.py et al).
    from db.client import get_db  # type: ignore[no-redef]


def ensure_no_replica_for_writers() -> None:
    """Writers don't need the embedded replica — they only stream INSERTs
    to cloud. Setting this before get_db() avoids "Failed to checkpoint WAL:
    database is locked" when the long-running radon-nextjs reader holds the
    same replica.db open. See migration plan §D1.

    Call this at the top of every writer entry point — BEFORE the first
    get_db() call in the process. It's a no-op if already set.
    """
    os.environ.setdefault("RADON_DB_NO_REPLICA", "1")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def upsert_menthorq_cta(date_str: str, payload: dict[str, Any], fetched_at: Optional[str] = None) -> None:
    """Persist a CTA cache row keyed by ET trading day."""
    db = get_db()
    db.execute(
        """
        INSERT INTO menthorq_cta (date, payload, fetched_at)
        VALUES (?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          payload    = excluded.payload,
          fetched_at = excluded.fetched_at
        """,
        (date_str, json.dumps(payload), fetched_at or _now_iso()),
    )
    db.commit()


def upsert_cri_snapshot(date_str: str, taken_at: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO cri_snapshots (date, taken_at, payload)
        VALUES (?, ?, ?)
        """,
        (date_str, taken_at, json.dumps(payload)),
    )
    db.commit()


def upsert_gex_snapshot(ticker: str, scan_time: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO gex_snapshots (ticker, scan_time, payload)
        VALUES (?, ?, ?)
        """,
        (ticker, scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_vcg_snapshot(scan_time: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO vcg_snapshots (scan_time, payload)
        VALUES (?, ?)
        """,
        (scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_portfolio_snapshot(taken_at: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO portfolio_snapshots (taken_at, payload)
        VALUES (?, ?)
        """,
        (taken_at, json.dumps(payload)),
    )
    db.commit()


def upsert_cash_flow(
    txn_id: str,
    date_str: str,
    txn_type: str,
    amount: float,
    currency: str = "USD",
    description: Optional[str] = None,
    raw_type: Optional[str] = None,
) -> None:
    """Persist one cash transaction (deposit / withdrawal / dividend / etc).

    `amount` is signed (positive = inflow into account, negative = outflow).
    Idempotent on `txn_id` (IB transactionID), so re-running the Flex pull
    after a partial-day refresh is a no-op for already-seen rows.
    """
    db = get_db()
    db.execute(
        """
        INSERT INTO cash_flows (id, date, type, amount, currency, description, raw_type, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date        = excluded.date,
          type        = excluded.type,
          amount      = excluded.amount,
          currency    = excluded.currency,
          description = excluded.description,
          raw_type    = excluded.raw_type,
          synced_at   = excluded.synced_at
        """,
        (txn_id, date_str, txn_type, float(amount), currency, description, raw_type, _now_iso()),
    )
    db.commit()


def upsert_journal_entry(trade_id: str, payload: dict[str, Any], filled_at: Optional[str] = None) -> None:
    db = get_db()
    db.execute(
        """
        INSERT INTO journal (trade_id, payload, filled_at, written_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(trade_id) DO UPDATE SET
          payload    = excluded.payload,
          filled_at  = excluded.filled_at,
          written_at = excluded.written_at
        """,
        (trade_id, json.dumps(payload), filled_at, _now_iso()),
    )
    db.commit()


def upsert_discover_snapshot(scan_time: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO discover_snapshots (scan_time, payload)
        VALUES (?, ?)
        """,
        (scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_analyst_ratings(ticker: str, fetched_at: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO analyst_ratings (ticker, fetched_at, payload)
        VALUES (?, ?, ?)
        """,
        (ticker, fetched_at, json.dumps(payload)),
    )
    db.commit()


def upsert_oi_changes(scan_time: str, payload: dict[str, Any]) -> None:
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO oi_changes (scan_time, payload)
        VALUES (?, ?)
        """,
        (scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_scanner_snapshot(scan_time: str, payload: dict[str, Any]) -> None:
    """Phase 2.1 — store the watchlist signal snapshot from scanner.py."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO scanner_snapshots (scan_time, payload)
        VALUES (?, ?)
        """,
        (scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_flow_analysis_snapshot(scan_time: str, payload: dict[str, Any]) -> None:
    """Phase 2.2 — flow_analysis.py output (intraday dark-pool interp)."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO flow_analysis_snapshots (scan_time, payload)
        VALUES (?, ?)
        """,
        (scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_performance_snapshot(taken_at: str, payload: dict[str, Any]) -> None:
    """Phase 2.3 — portfolio_performance.py output."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO performance_snapshots (taken_at, payload)
        VALUES (?, ?)
        """,
        (taken_at, json.dumps(payload)),
    )
    db.commit()


def upsert_nav_history(date_str: str, net_liq: float, daily_pnl: Optional[float]) -> None:
    """Phase 2.3 — append-only NAV history (one row per trading day)."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO nav_history (date, net_liq, daily_pnl, recorded_at)
        VALUES (?, ?, ?, ?)
        """,
        (date_str, float(net_liq), float(daily_pnl) if daily_pnl is not None else None, _now_iso()),
    )
    db.commit()


def upsert_twr_history(date_str: str, twr: float) -> None:
    """Phase 2.3 — time-weighted return series (one row per trading day)."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO twr_history (date, twr, recorded_at)
        VALUES (?, ?, ?)
        """,
        (date_str, float(twr), _now_iso()),
    )
    db.commit()


def upsert_option_close(
    symbol: str,
    expiry: str,
    strike: float,
    right: str,
    close_date: str,
    close_price: float,
) -> None:
    """Phase 2.5 — end-of-day option closing prices.

    Sources: ib_realtime_server.js Node-side path. This Python helper
    exists for symmetry / test setup; the production writer is the JS
    file using @libsql/client directly.
    """
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO option_close_cache
          (symbol, expiry, strike, right, close_date, close_price, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (symbol.upper(), expiry, float(strike), right.upper()[:1], close_date, float(close_price), _now_iso()),
    )
    db.commit()


def upsert_discover_sp500_snapshot(scan_time: str, payload: dict[str, Any]) -> None:
    """Phase 2.4 — sp500-scoped discover.py output (separate table to avoid
    ALTER TABLE partial-migration risk)."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO discover_sp500_snapshots (scan_time, payload)
        VALUES (?, ?)
        """,
        (scan_time, json.dumps(payload)),
    )
    db.commit()


def upsert_analyst_ratings(ticker: str, fetched_at: str, payload: dict[str, Any]) -> None:
    """Phase 2.5 — analyst consensus per ticker. Table existed since 0001
    but no caller wrote to it before this commit (zombie schema)."""
    db = get_db()
    db.execute(
        """
        INSERT OR REPLACE INTO analyst_ratings (ticker, fetched_at, payload)
        VALUES (?, ?, ?)
        """,
        (ticker.upper(), fetched_at, json.dumps(payload)),
    )
    db.commit()


def record_service_health(
    service: str,
    state: str,
    *,
    started_at: Optional[str] = None,
    finished_at: Optional[str] = None,
    error: Optional[dict[str, Any]] = None,
) -> None:
    """state ∈ {'ok', 'syncing', 'error', 'paused'}."""
    db = get_db()
    db.execute(
        """
        INSERT INTO service_health (service, state, last_attempt_started_at, last_attempt_finished_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(service) DO UPDATE SET
          state                    = excluded.state,
          last_attempt_started_at  = COALESCE(excluded.last_attempt_started_at, service_health.last_attempt_started_at),
          last_attempt_finished_at = COALESCE(excluded.last_attempt_finished_at, service_health.last_attempt_finished_at),
          last_error               = excluded.last_error,
          updated_at               = excluded.updated_at
        """,
        (
            service,
            state,
            started_at,
            finished_at,
            json.dumps(error) if error else None,
            _now_iso(),
        ),
    )
    db.commit()
