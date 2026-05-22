"""Centralized IBKR contract resolution.

Every script that constructs a Stock(symbol, "SMART", "USD") to look up
quotes / qualify a contract / place an order should route through here
instead. Indices (VIX, SPX, NDX, RUT, ...) need `secType=IND` not STK
or IBKR returns no data.

Phase 1 surface: STK + IND.
Phase 2 will extend with Future().
Phase 3 will extend with Option() / FOP() (index options).
"""
from __future__ import annotations

from typing import Optional

from utils.index_symbols import index_exchange_for, is_index_symbol

# ib_insync may not be importable in all contexts (tests, isolated
# scripts). Lazy-import inside the function so callers that pass in an
# already-built contract still work.


def resolve_quote_contract(symbol: str):
    """Return the ib_insync Contract used for quote / chain / historical lookups.

    Order of precedence:
      1. Symbol is in INDEX_SYMBOLS → `Index(symbol, currency='USD', exchange=<from table>)`
      2. Otherwise → `Stock(symbol, 'SMART', 'USD')`

    Raises ValueError if `symbol` is empty.
    """
    if not symbol or not symbol.strip():
        raise ValueError("symbol is required")

    from ib_insync import Index, Stock

    upper = symbol.strip().upper()
    if is_index_symbol(upper):
        exchange = index_exchange_for(upper) or "CBOE"
        # ib_insync.Index(symbol, exchange, currency) — positional.
        return Index(upper, exchange, "USD")
    return Stock(upper, "SMART", "USD")


def is_tradeable(symbol: str) -> bool:
    """False for index symbols (you can only trade futures/options on them)."""
    return not is_index_symbol(symbol)


# ── Futures ────────────────────────────────────────────────────────────

# Map of underlying symbol → CFE futures root + exchange. Currently
# scoped to VIX; extend as we wire more index-futures.
FUTURES_ROOTS: dict[str, dict[str, str]] = {
    "VIX": {"root": "VIX", "exchange": "CFE", "multiplier": "1000"},
}


def supports_futures(symbol: str) -> bool:
    """True iff Radon knows how to resolve a futures contract for this symbol."""
    return symbol.upper() in FUTURES_ROOTS


def resolve_future_contract(symbol: str, expiry: str = ""):
    """Return ib_insync Future contract for `symbol` at `expiry` (YYYYMM / YYYYMMDD).

    Pass empty `expiry` to get a partial contract suitable for
    `reqContractDetails` (returns the full chain). For order placement
    `expiry` is required.
    """
    if not symbol or not symbol.strip():
        raise ValueError("symbol is required")

    from ib_insync import Future

    upper = symbol.strip().upper()
    if upper not in FUTURES_ROOTS:
        raise ValueError(f"futures not supported for {upper}")

    meta = FUTURES_ROOTS[upper]
    contract = Future(
        symbol=meta["root"],
        lastTradeDateOrContractMonth=expiry,
        exchange=meta["exchange"],
        currency="USD",
    )
    if meta.get("multiplier"):
        contract.multiplier = meta["multiplier"]
    return contract
