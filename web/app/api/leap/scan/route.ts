import { NextResponse } from "next/server";
import { getRequestId, setNoStoreResponseHeaders } from "@/lib/apiContracts";
import { radonFetch, RadonApiError } from "@/lib/radonApi";

/**
 * POST /api/leap/scan
 *
 * Triggers leap_scanner_uw.py via the FastAPI /leap/scan endpoint. Cooldown
 * + lock live on the FastAPI side. Body accepts {preset?, min_gap?}; both
 * have FastAPI defaults (preset=mag7, min_gap=10.0).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId();
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine — server uses defaults
  }

  const params = new URLSearchParams();
  if (typeof body.preset === "string") params.set("preset", body.preset);
  if (typeof body.min_gap === "number") params.set("min_gap", String(body.min_gap));

  const path = params.toString() ? `/leap/scan?${params.toString()}` : "/leap/scan";

  try {
    const data = await radonFetch<Record<string, unknown>>(path, {
      method: "POST",
      timeout: 310_000,
    });
    return setNoStoreResponseHeaders(NextResponse.json(data), requestId);
  } catch (err) {
    const status = err instanceof RadonApiError ? err.status : 502;
    const message = err instanceof Error ? err.message : "LEAP scan failed";
    return setNoStoreResponseHeaders(
      NextResponse.json({ error: message }, { status }),
      requestId,
    );
  }
}
