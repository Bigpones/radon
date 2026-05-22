#!/usr/bin/env python3
"""Fetch a Future or Option chain via reqContractDetails. JSON-in / JSON-out.

Replaces in-process IB pool calls for the futures + index-options chain
endpoints. Subprocesses get their own event loop on a single thread, so
ib_insync's sync wrapper never has the cross-thread loop deadlock that
killed the original in-process implementation (large chains returned
"There is no current event loop in thread 'asyncio_2'" intermittently).

Usage:
  python3 scripts/ib_chain.py --kind future --symbol VIX
  python3 scripts/ib_chain.py --kind option --symbol VIX --expiry 20260616

Output:
  {"symbol": "VIX", "exchange": "CFE"|"CBOE", "contracts": [...], "count": N}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Path bootstrap mirrors ib_place_order.py
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).parent))

try:
    from ib_insync import IB
except ImportError:
    print(json.dumps({"error": "ib_insync not installed"}))
    sys.exit(1)

from clients.contract_resolver import (
    resolve_future_contract,
    resolve_option_contract,
    supports_futures,
    supports_index_options,
)
from clients.ib_client import DEFAULT_HOST, DEFAULT_GATEWAY_PORT


def fetch_chain(kind: str, symbol: str, expiry: str = "") -> dict:
    symbol_upper = symbol.upper()
    if kind == "future":
        if not supports_futures(symbol_upper):
            return {"error": f"futures not supported for {symbol_upper}"}
        spec = resolve_future_contract(symbol_upper, expiry=expiry)
    elif kind == "option":
        if not supports_index_options(symbol_upper):
            return {"error": f"index options not supported for {symbol_upper}"}
        spec = resolve_option_contract(symbol_upper, expiry=expiry)
    else:
        return {"error": f"unknown kind: {kind!r}"}

    ib = IB()
    try:
        ib.connect(host=DEFAULT_HOST, port=DEFAULT_GATEWAY_PORT, clientId="auto", timeout=10)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"IB connect failed: {exc}"}

    try:
        details = ib.reqContractDetails(spec)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"reqContractDetails failed: {exc}"}
    finally:
        try:
            ib.disconnect()
        except Exception:
            pass

    rows = []
    for cd in details:
        c = cd.contract
        row = {
            "conId": c.conId,
            "symbol": c.symbol,
            "localSymbol": c.localSymbol,
            "exchange": c.exchange,
            "currency": c.currency,
            "lastTradeDateOrContractMonth": c.lastTradeDateOrContractMonth,
            "multiplier": c.multiplier,
            "tradingClass": c.tradingClass,
            "minTick": cd.minTick,
        }
        if kind == "option":
            row["strike"] = c.strike
            row["right"] = c.right
        rows.append(row)

    # Sort: futures by expiry; options by (expiry, strike, right).
    if kind == "future":
        rows.sort(key=lambda r: r["lastTradeDateOrContractMonth"] or "")
    else:
        rows.sort(key=lambda r: (
            r["lastTradeDateOrContractMonth"] or "",
            r.get("strike") or 0.0,
            r.get("right") or "",
        ))

    out = {
        "symbol": symbol_upper,
        "exchange": rows[0]["exchange"] if rows else ("CFE" if kind == "future" else "CBOE"),
        "contracts": rows,
        "count": len(rows),
    }
    if kind == "option":
        out["tradingClass"] = rows[0]["tradingClass"] if rows else symbol_upper
        out["expirations"] = sorted({
            r["lastTradeDateOrContractMonth"]
            for r in rows
            if r["lastTradeDateOrContractMonth"]
        })
    return out


def main():
    parser = argparse.ArgumentParser(description="IB chain fetcher (futures / options)")
    parser.add_argument("--kind", required=True, choices=["future", "option"])
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--expiry", default="")
    args = parser.parse_args()

    print(json.dumps(fetch_chain(args.kind, args.symbol, args.expiry)))


if __name__ == "__main__":
    main()
