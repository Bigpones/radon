"""Forge OHLCV pipeline — GET /historical endpoint.

FORGE-SPECIFIC. This file does not exist in Joe McCann's upstream Radon.
It is isolated here (rather than inline in server.py) so it SURVIVES every
upstream update: `git checkout upstream/main -- .` never touches a file Joe
doesn't have. The only thing apply-forge-mods.sh must re-add to server.py is
a single line:

    from api.routes.forge_ohlcv import router as forge_ohlcv_router
    app.include_router(forge_ohlcv_router)

Forge's entire OHLCV / chart pipeline depends on this endpoint. Without it,
every Forge analyze call fails (no chart bars).

Pairs with scripts/ib_historical.py (also Forge-only, also survives updates).
"""
from typing import Optional
from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.get("/historical")
async def historical_data(symbol: str, timeframe: Optional[str] = None):
    """Fetch historical OHLCV bars from IB.

    Fetches all six Forge timeframes in a single IB connection when no
    *timeframe* is specified (recommended). Pass ``timeframe`` to fetch a
    single timeframe (Monthly, Weekly, 1D, 4H, 1H, 15M).
    """
    # Lazy import avoids a circular dependency: server.py imports this router
    # at module load, before _run_ib_script_with_recovery is defined.
    from api.server import _run_ib_script_with_recovery

    valid = {"Monthly", "Weekly", "1D", "4H", "1H", "15M"}
    if timeframe and timeframe not in valid:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid timeframe '{timeframe}'. Must be one of: {sorted(valid)}",
        )
    args = ["--symbol", symbol.upper()]
    if timeframe:
        args += ["--timeframe", timeframe]
    result = await _run_ib_script_with_recovery("ib_historical.py", args, timeout=60)
    if not result.ok:
        raise HTTPException(status_code=502, detail=result.error)
    if result.data and result.data.get("error"):
        raise HTTPException(status_code=502, detail=result.data["error"])
    return result.data
