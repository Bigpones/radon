#!/usr/bin/env python3
"""Cash-flow sync — Monitor daemon handler.

Pulls IB CashTransaction rows (deposits, withdrawals, dividends, interest,
fees) from the NAV Flex Query and persists to the `cash_flows` Turso
table every 4h. IBKR Flex publishes cash transactions once per day with
a ~1-day settlement lag, but the publication time floats — polling 4x
daily catches the morning publication window without wasting API budget.

Wired into monitor_daemon via scripts/monitor_daemon/run.py:create_daemon().
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

from monitor_daemon.handlers.base import BaseHandler

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent

# Poll every 4h (14400s).
#
# Why not daily: IBKR Flex publishes cash transactions with ~1 trading-day
# settlement lag — a withdrawal initiated on day N becomes Flex-visible
# on the morning of day N+1. With a 24h cadence the next sync after Flex
# makes a row visible could be ~24h away (we saw 12h+ display lag in
# production on 2026-05-08 → 2026-05-09). 4h is the sweet spot: fresh
# enough that a morning Flex publication appears in the panel by lunch,
# slow enough that we don't waste IB's API budget polling a feed that
# updates roughly once per day.
CHECK_INTERVAL = 4 * 60 * 60  # 14400s


class CashFlowSyncHandler(BaseHandler):
    """Run scripts/cash_flow_sync.py daily to refresh cash transactions."""

    name = "cash_flow_sync"
    interval_seconds = CHECK_INTERVAL
    requires_market_hours = False
    _SERVICE_NAME = "cash-flow-sync"

    def execute(self) -> Dict[str, Any]:
        """Wrap inner logic with service_health heartbeat (success+error)."""
        try:
            from db.writer import _now_iso, record_service_health  # type: ignore
        except Exception as exc:  # pragma: no cover — hosts without libsql
            logger.warning("service_health heartbeat unavailable: %s", exc)
            return self._execute_inner()

        started_at = _now_iso()
        try:
            result = self._execute_inner()
        except Exception as exc:
            try:
                record_service_health(
                    self._SERVICE_NAME, "error",
                    started_at=started_at, finished_at=_now_iso(),
                    error={"message": str(exc)},
                )
            except Exception as inner:
                logger.warning("record_service_health(error) failed: %s", inner)
            raise

        try:
            # Inner returns {"status": "error", "error": ...} on subprocess
            # failure — surface that as a heartbeat error too.
            if result.get("status") == "error" or result.get("error"):
                record_service_health(
                    self._SERVICE_NAME, "error",
                    started_at=started_at, finished_at=_now_iso(),
                    error={"message": str(result.get("error") or "cash_flow_sync failed")},
                )
            else:
                record_service_health(
                    self._SERVICE_NAME, "ok",
                    started_at=started_at, finished_at=_now_iso(),
                )
        except Exception as exc:
            logger.warning("record_service_health failed: %s", exc)

        return result

    def _execute_inner(self) -> Dict[str, Any]:
        if not os.environ.get("IB_FLEX_TOKEN") or not os.environ.get("IB_FLEX_NAV_QUERY_ID"):
            return {"status": "skip", "reason": "IB_FLEX_TOKEN / IB_FLEX_NAV_QUERY_ID not configured"}

        script = PROJECT_ROOT / "scripts" / "cash_flow_sync.py"
        if not script.exists():
            return {"status": "error", "error": f"script not found: {script}"}

        try:
            result = subprocess.run(
                [sys.executable, "-m", "scripts.cash_flow_sync"],
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                text=True,
                timeout=180,  # Flex Query polling can take ~60s
            )
        except subprocess.TimeoutExpired:
            return {"status": "error", "error": "cash_flow_sync timed out after 180s"}
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").splitlines()[-3:]
            logger.warning("cash_flow_sync failed: %s", " | ".join(tail))
            return {"status": "error", "error": " | ".join(tail), "returncode": result.returncode}

        # Last line of stdout is "Synced N cash flows. Breakdown: {...}"
        last_line = (result.stdout or "").strip().splitlines()[-1] if result.stdout else ""
        return {"status": "ok", "summary": last_line}
