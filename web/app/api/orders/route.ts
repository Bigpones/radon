import { NextResponse } from "next/server";
import { readDataFile } from "@tools/data-reader";
import { OrdersData } from "@tools/schemas/ib-orders";
import { radonFetch } from "@/lib/radonApi";
import { readOrdersFromDb } from "@/lib/orders/readOrdersFromDb";
import { compareOrders } from "@/lib/orders/compareOrders";
import { recordServiceHealth } from "@/lib/serviceHealth";
import type { Static } from "@sinclair/typebox";

// Phase 3.2 — disk read remains canonical; DB read is logged-only so we
// can validate dual-write integrity for ≥24h before flipping in 3.3.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_ORDERS: Static<typeof OrdersData> = {
  last_sync: "",
  open_orders: [],
  executed_orders: [],
  open_count: 0,
  executed_count: 0,
};

const readOrdersFromDisk = async (): Promise<Static<typeof OrdersData>> => {
  const result = await readDataFile("data/orders.json", OrdersData);
  return result.ok ? result.data : EMPTY_ORDERS;
};

const readOrdersFromDbSafe = async (): Promise<Static<typeof OrdersData> | null> => {
  try {
    return await readOrdersFromDb();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[orders] DB read failed: ${message}`);
    return null;
  }
};

async function compareAndLog(
  disk: Static<typeof OrdersData>,
  db: Static<typeof OrdersData> | null,
): Promise<void> {
  if (!db) return; // dual-write hasn't populated yet — not a divergence
  const diff = compareOrders(disk, db);
  if (!diff.diverged) {
    return;
  }
  console.warn(`[orders] DB↔disk divergence: ${diff.reason}`);
  try {
    await recordServiceHealth({
      service: "orders-read-compare",
      state: "warn",
      finishedAt: new Date().toISOString(),
      error: { reason: diff.reason, details: diff.details },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[orders] failed to record service_health: ${message}`);
  }
}

const readOrders = async (): Promise<Static<typeof OrdersData>> => {
  const [disk, db] = await Promise.all([readOrdersFromDisk(), readOrdersFromDbSafe()]);
  // Fire-and-forget — comparison logging must not block the response.
  void compareAndLog(disk, db);
  return disk;
};

let syncInFlight: Promise<void> | null = null;

export async function GET(): Promise<Response> {
  try {
    const data = await readOrders();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read orders";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(): Promise<Response> {
  try {
    // Coalesce concurrent POSTs
    if (!syncInFlight) {
      syncInFlight = radonFetch("/orders/refresh", { method: "POST", timeout: 35_000 })
        .then(() => {})
        .finally(() => { syncInFlight = null; });
    }
    await syncInFlight;

    const data = await readOrders();
    return NextResponse.json(data);
  } catch {
    // Sync failed — fall back to cached data file
    const cached = await readOrders();
    if (cached.last_sync) {
      console.warn("[Orders] Sync failed, serving cached data");
      const res = NextResponse.json(cached);
      res.headers.set("X-Sync-Warning", "IB sync failed - serving cached data");
      return res;
    }
    // No cached data (empty last_sync) — genuine failure
    return NextResponse.json(
      { error: "Sync failed" },
      { status: 502 },
    );
  }
}
