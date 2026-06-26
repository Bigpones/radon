"""Index → futures-root resolution (contract_resolver.FUTURES_ROOTS).

Pins the cash-index → CME E-mini mapping the Book tab + futures order ticket
rely on: SPX→ES, NDX→NQ, RUT→RTY (and VIX→VIX/CFE). Getting the root or
multiplier wrong silently resolves the wrong (or a Micro) contract.
"""

import pytest

from scripts.clients.contract_resolver import (
    FUTURES_ROOTS,
    resolve_future_contract,
    supports_futures,
)


@pytest.mark.parametrize(
    "symbol,root,exchange,multiplier",
    [
        ("VIX", "VIX", "CFE", "1000"),
        ("SPX", "ES", "CME", "50"),
        ("NDX", "NQ", "CME", "20"),
        ("RUT", "RTY", "CME", "50"),
    ],
)
def test_index_resolves_to_expected_future(symbol, root, exchange, multiplier):
    assert supports_futures(symbol) is True
    contract = resolve_future_contract(symbol, expiry="")
    assert contract.symbol == root
    assert contract.exchange == exchange
    assert contract.multiplier == multiplier
    assert contract.currency == "USD"


def test_lookup_is_case_insensitive():
    assert resolve_future_contract("spx").symbol == "ES"


def test_unmapped_symbol_raises():
    # VVIX is a known index but has no listed future Radon resolves.
    assert supports_futures("VVIX") is False
    with pytest.raises(ValueError):
        resolve_future_contract("VVIX")


def test_table_matches_frontend_support_set():
    # FUTURES_ROOTS keys must equal web/lib/indexSymbols.ts
    # FUTURES_SUPPORTED_SYMBOLS — they are wired as a pair.
    assert set(FUTURES_ROOTS) == {"VIX", "SPX", "NDX", "RUT"}
