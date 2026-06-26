/**
 * Phase 3.2 — compare /api/orders DB read against the JSON read so we
 * can validate dual-write integrity in production before flipping the
 * read order in 3.3.
 *
 * Comparison is structural-by-id, not byte-equal: timestamps, derived
 * counts, and field ordering will differ between the two paths and
 * are not interesting.
 *
 * Open orders are session-scoped on both sides (IB returns the full
 * open snapshot each sync; disk overwrites and DB DELETE+INSERTs).
 * Symmetric checks apply: any permId on one side but not the other,
 * or status/qty/price drift on a shared permId, is divergence.
 *
 * Executed orders are asymmetric: disk holds only the current IB
 * Gateway session (cleared on every restart), while the DB table is
 * cumulative within the readOrdersFromDb 36h window. After any
 * gateway restart the DB is a strict superset of disk — that is
 * expected, not divergence. We flag:
 *
 *   - executed_only_in_disk → real bug (dual-write missed a fill)
 *   - executed_field_drift on shared execIds → real bug
 *
 * `executed_only_in_db` is recorded for telemetry but does not mark
 * the comparison as diverged.
 *
 * Surfaces a one-line summary that fits in service_health.last_error.
 */
import type { Static } from "@sinclair/typebox";
import type { OrdersData } from "@tools/schemas/ib-orders";

type Orders = Static<typeof OrdersData>;

export type DivergenceSummary = {
  diverged: boolean;
  reason: string;
  details: {
    open_only_in_disk: number[];
    open_only_in_db: number[];
    executed_only_in_disk: string[];
    executed_only_in_db: string[];
    open_field_drift: Array<{ permId: number; fields: string[] }>;
    executed_field_drift: Array<{ execId: string; fields: string[] }>;
  };
};

const TRACKED_OPEN_FIELDS = ["status", "filled", "remaining", "limitPrice", "totalQuantity"] as const;
const TRACKED_EXEC_FIELDS = ["quantity", "avgPrice", "commission", "realizedPNL"] as const;

function indexOpen(o: Orders | null): Map<number, Orders["open_orders"][number]> {
  const map = new Map<number, Orders["open_orders"][number]>();
  if (!o) return map;
  for (const order of o.open_orders) {
    if (typeof order.permId === "number") map.set(order.permId, order);
  }
  return map;
}

function indexExec(o: Orders | null): Map<string, Orders["executed_orders"][number]> {
  const map = new Map<string, Orders["executed_orders"][number]>();
  if (!o) return map;
  for (const order of o.executed_orders) {
    if (order.execId) map.set(order.execId, order);
  }
  return map;
}

export function compareOrders(disk: Orders | null, db: Orders | null): DivergenceSummary {
  const diskOpen = indexOpen(disk);
  const dbOpen = indexOpen(db);
  const diskExec = indexExec(disk);
  const dbExec = indexExec(db);

  const open_only_in_disk: number[] = [];
  const open_only_in_db: number[] = [];
  const executed_only_in_disk: string[] = [];
  const executed_only_in_db: string[] = [];
  const open_field_drift: DivergenceSummary["details"]["open_field_drift"] = [];
  const executed_field_drift: DivergenceSummary["details"]["executed_field_drift"] = [];

  for (const id of diskOpen.keys()) {
    if (!dbOpen.has(id)) open_only_in_disk.push(id);
  }
  for (const id of dbOpen.keys()) {
    if (!diskOpen.has(id)) open_only_in_db.push(id);
  }
  for (const id of diskExec.keys()) {
    if (!dbExec.has(id)) executed_only_in_disk.push(id);
  }
  for (const id of dbExec.keys()) {
    if (!diskExec.has(id)) executed_only_in_db.push(id);
  }

  for (const [permId, diskRow] of diskOpen) {
    const dbRow = dbOpen.get(permId);
    if (!dbRow) continue;
    const drifted: string[] = [];
    for (const field of TRACKED_OPEN_FIELDS) {
      const a = (diskRow as Record<string, unknown>)[field];
      const b = (dbRow as Record<string, unknown>)[field];
      if (a !== b) drifted.push(field);
    }
    if (drifted.length > 0) open_field_drift.push({ permId, fields: drifted });
  }

  for (const [execId, diskRow] of diskExec) {
    const dbRow = dbExec.get(execId);
    if (!dbRow) continue;
    const drifted: string[] = [];
    for (const field of TRACKED_EXEC_FIELDS) {
      const a = (diskRow as Record<string, unknown>)[field];
      const b = (dbRow as Record<string, unknown>)[field];
      if (a !== b) drifted.push(field);
    }
    if (drifted.length > 0) executed_field_drift.push({ execId, fields: drifted });
  }

  const details: DivergenceSummary["details"] = {
    open_only_in_disk,
    open_only_in_db,
    executed_only_in_disk,
    executed_only_in_db,
    open_field_drift,
    executed_field_drift,
  };

  // executed_only_in_db is the expected steady-state superset (DB
  // retains pre-restart fills disk has dropped); record it for
  // telemetry but exclude from the divergence verdict.
  const divergeCount =
    open_only_in_disk.length +
    open_only_in_db.length +
    executed_only_in_disk.length +
    open_field_drift.length +
    executed_field_drift.length;

  if (divergeCount === 0) {
    return { diverged: false, reason: "ok", details };
  }

  const parts: string[] = [];
  if (open_only_in_disk.length > 0) parts.push(`open_only_disk=${open_only_in_disk.length}`);
  if (open_only_in_db.length > 0) parts.push(`open_only_db=${open_only_in_db.length}`);
  if (executed_only_in_disk.length > 0) parts.push(`exec_only_disk=${executed_only_in_disk.length}`);
  if (open_field_drift.length > 0) parts.push(`open_field_drift=${open_field_drift.length}`);
  if (executed_field_drift.length > 0) parts.push(`exec_field_drift=${executed_field_drift.length}`);

  return { diverged: true, reason: parts.join(" "), details };
}
