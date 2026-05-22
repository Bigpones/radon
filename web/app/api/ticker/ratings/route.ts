import { NextResponse } from "next/server";
import { radonFetch } from "@/lib/radonApi";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");

  if (!ticker) {
    return NextResponse.json({ error: "ticker parameter required" }, { status: 400 });
  }

  try {
    const data = await radonFetch<Record<string, unknown>>(
      `/ticker/ratings?ticker=${encodeURIComponent(ticker.toUpperCase())}`,
      { timeout: 60_000 },
    );
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch ratings";
    return NextResponse.json(
      { error: "Failed to fetch ratings", detail: message },
      { status: 502 },
    );
  }
}
