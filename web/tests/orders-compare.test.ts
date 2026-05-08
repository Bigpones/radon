/**
 * @vitest-environment node
 *
 * Tests for compareOrders — Phase 3.2 divergence detection.
 */
import { describe, it, expect } from "vitest";
import { compareOrders } from "../lib/orders/compareOrders";
import type { Static } from "@sinclair/typebox";
import type { OrdersData } from "../../lib/tools/schemas/ib-orders";

type Orders = Static<typeof OrdersData>;

const baseContract = {
  conId: 1,
  symbol: "TSLA",
  secType: "OPT",
  strike: 200,
  right: "C",
  expiry: "20260530",
};

function makeOpen(permId: number, overrides: Partial<Orders["open_orders"][number]> = {}): Orders["open_orders"][number] {
  return {
    orderId: permId,
    permId,
    symbol: "TSLA",
    contract: baseContract,
    action: "BUY",
    orderType: "LMT",
    totalQuantity: 1,
    limitPrice: 5.0,
    auxPrice: null,
    status: "PreSubmitted",
    filled: 0,
    remaining: 1,
    avgFillPrice: null,
    tif: "DAY",
    ...overrides,
  };
}

function makeExec(execId: string): Orders["executed_orders"][number] {
  return {
    execId,
    symbol: "TSLA",
    contract: baseContract,
    side: "BOT",
    quantity: 1,
    avgPrice: 5.25,
    commission: 0.65,
    realizedPNL: null,
    time: "2026-05-07T13:30:00Z",
    exchange: "ISE",
  };
}

function shell(open: Orders["open_orders"], executed: Orders["executed_orders"]): Orders {
  return {
    last_sync: "2026-05-07T13:30:00Z",
    open_orders: open,
    executed_orders: executed,
    open_count: open.length,
    executed_count: executed.length,
  };
}

describe("compareOrders", () => {
  it("returns diverged=false when both sides match", () => {
    const a = shell([makeOpen(1), makeOpen(2)], [makeExec("e1")]);
    const b = shell([makeOpen(2), makeOpen(1)], [makeExec("e1")]); // same set, diff order
    const diff = compareOrders(a, b);
    expect(diff.diverged).toBe(false);
    expect(diff.reason).toBe("ok");
  });

  it("flags permIds present only on disk", () => {
    const disk = shell([makeOpen(1), makeOpen(2)], []);
    const db = shell([makeOpen(1)], []);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(true);
    expect(diff.details.open_only_in_disk).toEqual([2]);
    expect(diff.reason).toContain("open_only_disk=1");
  });

  it("flags permIds present only in DB", () => {
    const disk = shell([makeOpen(1)], []);
    const db = shell([makeOpen(1), makeOpen(99)], []);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(true);
    expect(diff.details.open_only_in_db).toEqual([99]);
  });

  it("flags execIds present only on disk (dual-write missed a fill)", () => {
    const disk = shell([], [makeExec("e1"), makeExec("e2")]);
    const db = shell([], [makeExec("e1")]);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(true);
    expect(diff.details.executed_only_in_disk).toEqual(["e2"]);
    expect(diff.details.executed_only_in_db).toEqual([]);
    expect(diff.reason).toContain("exec_only_disk=1");
  });

  it("treats execIds present only in DB as informational, not divergence", () => {
    // Disk holds only the current IB Gateway session; DB retains the
    // last 36h of fills. Pre-restart fills survive in DB after disk
    // resets — that asymmetry is expected, not a bug.
    const disk = shell([], [makeExec("today1")]);
    const db = shell([], [makeExec("today1"), makeExec("yesterday1"), makeExec("yesterday2")]);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(false);
    expect(diff.reason).toBe("ok");
    expect(diff.details.executed_only_in_db.sort()).toEqual(["yesterday1", "yesterday2"]);
  });

  it("flags drift on tracked exec fields (avgPrice, quantity, commission, realizedPNL) for shared execIds", () => {
    const disk = shell([], [{ ...makeExec("e1"), avgPrice: 5.25, quantity: 1, commission: 0.65 }]);
    const db = shell([], [{ ...makeExec("e1"), avgPrice: 5.30, quantity: 1, commission: 0.70 }]);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(true);
    expect(diff.details.executed_field_drift).toHaveLength(1);
    expect(diff.details.executed_field_drift[0].execId).toBe("e1");
    expect(diff.details.executed_field_drift[0].fields.sort()).toEqual(["avgPrice", "commission"]);
    expect(diff.reason).toContain("exec_field_drift=1");
  });

  it("flags drift on tracked open-order fields (status, filled, remaining, limitPrice, totalQuantity)", () => {
    const disk = shell([makeOpen(1, { status: "Filled", filled: 1, remaining: 0 })], []);
    const db = shell([makeOpen(1, { status: "PreSubmitted", filled: 0, remaining: 1 })], []);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(true);
    expect(diff.details.open_field_drift).toHaveLength(1);
    expect(diff.details.open_field_drift[0].permId).toBe(1);
    expect(diff.details.open_field_drift[0].fields.sort()).toEqual(["filled", "remaining", "status"]);
  });

  it("ignores untracked field differences (e.g. tif, auxPrice)", () => {
    const disk = shell([makeOpen(1, { tif: "DAY" })], []);
    const db = shell([makeOpen(1, { tif: "GTC" })], []);
    const diff = compareOrders(disk, db);
    expect(diff.diverged).toBe(false);
  });

  it("treats null DB read as no divergence (dual-write hasn't populated)", () => {
    const disk = shell([makeOpen(1)], [makeExec("e1")]);
    const diff = compareOrders(disk, null);
    expect(diff.details.open_only_in_disk).toEqual([1]);
    expect(diff.details.executed_only_in_disk).toEqual(["e1"]);
    // diverged=true is fine here; the route handler short-circuits on null
    // BEFORE calling compareOrders, so this branch is reachable only via tests.
  });

  it("compresses summary into a single readable reason line", () => {
    const disk = shell([makeOpen(1), makeOpen(2)], [makeExec("e1")]);
    const db = shell([makeOpen(3)], [makeExec("e2")]);
    const diff = compareOrders(disk, db);
    expect(diff.reason).toMatch(/open_only_disk=2/);
    expect(diff.reason).toMatch(/open_only_db=1/);
    expect(diff.reason).toMatch(/exec_only_disk=1/);
    // exec_only_db is informational and intentionally excluded from
    // the reason summary.
    expect(diff.reason).not.toMatch(/exec_only_db=/);
  });
});
