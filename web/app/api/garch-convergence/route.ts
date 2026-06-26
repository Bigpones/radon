import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { statSync } from "fs";
import { join } from "path";
import { getRequestId, setNoStoreResponseHeaders } from "@/lib/apiContracts";

/**
 * GET /api/garch-convergence
 *
 * Reads the latest GARCH convergence scan from `data/garch_convergence.json`
 * (written by `scripts/garch_convergence.py --json`, either via the systemd
 * timer on Hetzner or via POST /api/garch-convergence/scan → FastAPI
 * /garch-convergence/scan).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GARCH_CACHE_PATH = join(process.cwd(), "..", "data", "garch_convergence.json");
const STALE_THRESHOLD_SECONDS = 6 * 60 * 60;

interface CacheMeta {
  last_refresh: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  stale_threshold_seconds: number;
}

function buildCacheMeta(filePath: string): CacheMeta {
  try {
    const s = statSync(filePath);
    const ageSeconds = (Date.now() - s.mtime.getTime()) / 1000;
    return {
      last_refresh: s.mtime.toISOString(),
      age_seconds: Math.round(ageSeconds),
      is_stale: ageSeconds > STALE_THRESHOLD_SECONDS,
      stale_threshold_seconds: STALE_THRESHOLD_SECONDS,
    };
  } catch {
    return {
      last_refresh: null,
      age_seconds: null,
      is_stale: true,
      stale_threshold_seconds: STALE_THRESHOLD_SECONDS,
    };
  }
}

export async function GET(): Promise<Response> {
  const requestId = getRequestId();
  try {
    const raw = await readFile(GARCH_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw);
    const cache_meta = buildCacheMeta(GARCH_CACHE_PATH);
    return setNoStoreResponseHeaders(
      NextResponse.json({ ...data, cache_meta }),
      requestId,
    );
  } catch {
    const cache_meta = buildCacheMeta(GARCH_CACHE_PATH);
    return setNoStoreResponseHeaders(
      NextResponse.json({
        scan_time: "",
        tickers: {},
        pairs: [],
        cache_meta,
      }),
      requestId,
    );
  }
}
