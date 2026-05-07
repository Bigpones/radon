/**
 * Phase 3.2 — read orders from the open_orders / executed_orders Turso
 * tables and reshape them to match `data/orders.json` (OrdersData).
 *
 * Per CLAUDE.md "Trades canonical store": the disk JSON is still the
 * canonical surface today. This module exists so /api/orders can read
 * BOTH sources in parallel and log divergence — without that
 * comparison-logging step we'd be flipping the read to DB on faith.
 */
import type { Static } from "@sinclair/typebox";
import { getDb, syncDb } from "@/lib/db";
import type { OrdersData } from "@tools/schemas/ib-orders";

type Open = Static<typeof OrdersData>["open_orders"][number];
type Executed = Static<typeof OrdersData>["executed_orders"][number];

const EXECUTED_LOOKBACK_HOURS = 36;

function safeParse<T>(text: unknown): T | null {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function readOrdersFromDb(): Promise<Static<typeof OrdersData> | null> {
  const db = getDb();

  // Pull the freshest cloud-DB state into the embedded replica before
  // reading. Without this we lag the disk JSON by up to 60s (the
  // background sync interval), which surfaces as transient `status`
  // drift on every order state transition (PreSubmitted → Submitted at
  // market open, Submitted → Filled, etc.).
  try {
    await syncDb();
  } catch {
    // Best-effort: a sync failure (network blip, auth hiccup) just means
    // we read the slightly-older replica — same as the pre-sync world.
  }

  const openResult = await db.execute({
    sql: `SELECT payload, updated_at FROM open_orders ORDER BY updated_at DESC`,
    args: [],
  });

  const cutoff = new Date(Date.now() - EXECUTED_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const execResult = await db.execute({
    sql: `SELECT payload, fill_time FROM executed_orders
            WHERE fill_time >= ?
            ORDER BY fill_time DESC`,
    args: [cutoff],
  });

  const open: Open[] = [];
  let latestOpenSync = "";
  for (const row of openResult.rows) {
    const payload = safeParse<Open>((row as { payload?: unknown }).payload);
    if (!payload) continue;
    open.push(payload);
    const updatedAt = String((row as { updated_at?: unknown }).updated_at ?? "");
    if (updatedAt > latestOpenSync) latestOpenSync = updatedAt;
  }

  const executed: Executed[] = [];
  let latestExecSync = "";
  for (const row of execResult.rows) {
    const payload = safeParse<Executed>((row as { payload?: unknown }).payload);
    if (!payload) continue;
    executed.push(payload);
    const fillTime = String((row as { fill_time?: unknown }).fill_time ?? "");
    if (fillTime > latestExecSync) latestExecSync = fillTime;
  }

  if (open.length === 0 && executed.length === 0) return null;

  return {
    last_sync: latestOpenSync || latestExecSync || "",
    open_orders: open,
    executed_orders: executed,
    open_count: open.length,
    executed_count: executed.length,
  };
}
