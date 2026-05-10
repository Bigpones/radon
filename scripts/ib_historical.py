#!/usr/bin/env python3
"""Fetch historical OHLCV bars from IB for a symbol across all six Forge timeframes.

Fetches all timeframes in a single IB connection to avoid client-ID conflicts.

Usage:
    python3 scripts/ib_historical.py --symbol IRDM
    python3 scripts/ib_historical.py --symbol IRDM --timeframe 1D
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ib_insync import Stock
from scripts.clients.ib_client import IBClient

# Forge timeframe → (IB duration string, IB bar-size string)
TIMEFRAME_CONFIG = {
    "Monthly": ("1 Y",  "1 month"),
    "Weekly":  ("1 Y",  "1 week"),
    "1D":      ("2 Y",  "1 day"),
    "4H":      ("20 D", "4 hours"),
    "1H":      ("10 D", "1 hour"),
    "15M":     ("5 D",  "15 mins"),
}

ALL_TIMEFRAMES = ["Monthly", "Weekly", "1D", "4H", "1H", "15M"]


def fetch_bars(client: IBClient, contract, timeframe: str) -> dict:
    duration, bar_size = TIMEFRAME_CONFIG[timeframe]
    try:
        bars = client.get_historical_data(
            contract,
            duration=duration,
            bar_size=bar_size,
            what_to_show="TRADES",
            use_rth=True,
        )
        return {
            "timeframe": timeframe,
            "bar_size": bar_size,
            "bars": [
                {
                    "date": str(b.date),
                    "open":   round(float(b.open),   4),
                    "high":   round(float(b.high),   4),
                    "low":    round(float(b.low),    4),
                    "close":  round(float(b.close),  4),
                    "volume": int(b.volume),
                }
                for b in bars
            ],
        }
    except Exception as exc:
        return {"timeframe": timeframe, "bar_size": bar_size, "bars": [], "error": str(exc)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", required=True)
    parser.add_argument(
        "--timeframe",
        choices=ALL_TIMEFRAMES,
        default=None,
        help="Single timeframe to fetch (default: all six)",
    )
    parser.add_argument("--port",      type=int, default=4001)
    parser.add_argument("--client-id", type=int, default=29)
    args = parser.parse_args()

    timeframes = [args.timeframe] if args.timeframe else ALL_TIMEFRAMES

    client = IBClient()
    try:
        client.connect(port=args.port, client_id=args.client_id)
        contract = Stock(args.symbol.upper(), "SMART", "USD")
        client.qualify_contract(contract)

        results = [fetch_bars(client, contract, tf) for tf in timeframes]

        # Derive current price from the most recent close (prefer 1H, fall back to 1D, then any)
        current_price = None
        for preferred in ("1H", "1D", "4H", "Weekly", "Monthly"):
            tf_result = next((r for r in results if r["timeframe"] == preferred and r["bars"]), None)
            if tf_result:
                current_price = tf_result["bars"][-1]["close"]
                break

        print(json.dumps({
            "symbol": args.symbol.upper(),
            "current_price": current_price,
            "timeframes": results,
        }))

    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
