import { NextResponse } from "next/server";
import { runScript } from "@tools/runner";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol")?.toUpperCase();
  const expiry = searchParams.get("expiry");

  if (!symbol) {
    return NextResponse.json({ error: "Required: symbol" }, { status: 400 });
  }

  const args = ["--symbol", symbol];
  if (expiry) {
    args.push("--expiry", expiry);
  }

  const result = await runScript("scripts/ib_option_chain.py", {
    args,
    timeout: 15_000,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "Failed to fetch option chain", stderr: result.stderr },
      { status: 502 },
    );
  }

  const data = result.data as Record<string, unknown>;
  if (data.error) {
    return NextResponse.json({ error: data.error }, { status: 502 });
  }

  return NextResponse.json(data);
}
