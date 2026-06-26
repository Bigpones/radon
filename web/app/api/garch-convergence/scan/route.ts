import { NextResponse } from "next/server";
import { getRequestId, setNoStoreResponseHeaders } from "@/lib/apiContracts";
import { radonFetch, RadonApiError } from "@/lib/radonApi";

/**
 * POST /api/garch-convergence/scan
 *
 * Triggers garch_convergence.py via FastAPI /garch-convergence/scan.
 * Cooldown + lock live on the FastAPI side. Body accepts {preset?}; the
 * FastAPI default is preset=mega-tech.
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

  const path = params.toString()
    ? `/garch-convergence/scan?${params.toString()}`
    : "/garch-convergence/scan";

  try {
    const data = await radonFetch<Record<string, unknown>>(path, {
      method: "POST",
      timeout: 190_000,
    });
    return setNoStoreResponseHeaders(NextResponse.json(data), requestId);
  } catch (err) {
    const status = err instanceof RadonApiError ? err.status : 502;
    const message = err instanceof Error ? err.message : "GARCH scan failed";
    return setNoStoreResponseHeaders(
      NextResponse.json({ error: message }, { status }),
      requestId,
    );
  }
}
