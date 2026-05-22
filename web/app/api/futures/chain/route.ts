import { NextResponse } from "next/server";
import { getRequestId, setNoStoreResponseHeaders } from "@/lib/apiContracts";
import { radonFetch, RadonApiError } from "@/lib/radonApi";

/**
 * GET /api/futures/chain?symbol=VIX
 *
 * Proxy to FastAPI /futures/chain. Returns every listed future
 * contract for the symbol with its conId, expiry, exchange, multiplier,
 * and tradingClass. The order form uses conId to disambiguate among
 * multiple listings on the same expiry day (standard monthly vs
 * weekly VIX contracts both expire on Wednesday).
 *
 * Currently scoped to VIX. SPX / NDX futures wiring will land later.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId();
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");

  if (!symbol) {
    return setNoStoreResponseHeaders(
      NextResponse.json(
        { error: "symbol parameter required", code: "BAD_REQUEST" },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    const data = await radonFetch<Record<string, unknown>>(
      `/futures/chain?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
      { timeout: 20_000 },
    );
    return setNoStoreResponseHeaders(NextResponse.json(data), requestId);
  } catch (err) {
    const status = err instanceof RadonApiError ? err.status : 502;
    const message = err instanceof Error ? err.message : "futures chain fetch failed";
    return setNoStoreResponseHeaders(
      NextResponse.json({ error: message }, { status }),
      requestId,
    );
  }
}
