/**
 * @vitest-environment node
 *
 * Tests for /api/orders — Phase 3.2 comparison-logging behaviour.
 *
 * Contract:
 *   1. Disk read remains canonical — response body always reflects disk.
 *   2. DB read fires in parallel; failure is swallowed (no 500).
 *   3. When both sides exist and diverge, a service_health row is written
 *      with state=warn AND comparison runs without blocking the response.
 *   4. When DB returns null (dual-write hasn't populated), no warn fires.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const diskOrders = {
  last_sync: "2026-05-07T13:30:00Z",
  open_orders: [
    {
      orderId: 1, permId: 1, symbol: "TSLA",
      contract: { conId: 1, symbol: "TSLA", secType: "OPT", strike: 200, right: "C", expiry: "20260530" },
      action: "BUY", orderType: "LMT", totalQuantity: 1,
      limitPrice: 5, auxPrice: null, status: "PreSubmitted",
      filled: 0, remaining: 1, avgFillPrice: null, tif: "DAY",
    },
  ],
  executed_orders: [],
  open_count: 1,
  executed_count: 0,
};

beforeEach(() => {
  vi.resetModules();
});

function mockReaders(opts: {
  disk?: typeof diskOrders | null;
  db?: typeof diskOrders | null;
  dbThrows?: boolean;
}): { recordCalls: unknown[][] } {
  const recordCalls: unknown[][] = [];
  vi.doMock("@tools/data-reader", () => ({
    readDataFile: vi.fn().mockResolvedValue(
      opts.disk === undefined ? { ok: true, data: diskOrders } :
      opts.disk === null ? { ok: false } :
      { ok: true, data: opts.disk },
    ),
  }));
  vi.doMock("@/lib/orders/readOrdersFromDb", () => ({
    readOrdersFromDb: vi.fn().mockImplementation(() => {
      if (opts.dbThrows) throw new Error("WAL locked");
      return Promise.resolve(opts.db ?? null);
    }),
  }));
  vi.doMock("@/lib/serviceHealth", () => ({
    recordServiceHealth: vi.fn().mockImplementation(async (...args: unknown[]) => {
      recordCalls.push(args);
    }),
  }));
  vi.doMock("@/lib/radonApi", () => ({ radonFetch: vi.fn() }));
  return { recordCalls };
}

async function flushMicrotasks() {
  // compareAndLog is fire-and-forget; allow promise chain to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("/api/orders", () => {
  it("returns disk-derived data even when DB has different rows", async () => {
    mockReaders({ db: { ...diskOrders, open_orders: [], open_count: 0 } });
    const { GET } = await import("../app/api/orders/route");
    const res = await GET();
    const body = await res.json();
    expect(body.open_count).toBe(1); // disk wins
    expect(body.open_orders[0].permId).toBe(1);
  });

  it("does NOT block the response on the comparison logger", async () => {
    mockReaders({ db: diskOrders });
    const { GET } = await import("../app/api/orders/route");
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("records service_health=warn when DB↔disk diverge", async () => {
    const { recordCalls } = mockReaders({
      db: { ...diskOrders, open_orders: [], open_count: 0 }, // missing permId 1
    });
    const { GET } = await import("../app/api/orders/route");
    await GET();
    await flushMicrotasks();
    expect(recordCalls).toHaveLength(1);
    expect((recordCalls[0][0] as { service: string }).service).toBe("orders-read-compare");
    expect((recordCalls[0][0] as { state: string }).state).toBe("warn");
  });

  it("does NOT record service_health when DB matches disk", async () => {
    const { recordCalls } = mockReaders({ db: diskOrders });
    const { GET } = await import("../app/api/orders/route");
    await GET();
    await flushMicrotasks();
    expect(recordCalls).toHaveLength(0);
  });

  it("does NOT record service_health when DB returns null (not yet populated)", async () => {
    const { recordCalls } = mockReaders({ db: null });
    const { GET } = await import("../app/api/orders/route");
    await GET();
    await flushMicrotasks();
    expect(recordCalls).toHaveLength(0);
  });

  it("does NOT record service_health when DB read throws", async () => {
    const { recordCalls } = mockReaders({ dbThrows: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await import("../app/api/orders/route");
    const res = await GET();
    expect(res.status).toBe(200); // disk path still returns 200
    await flushMicrotasks();
    expect(recordCalls).toHaveLength(0);
  });

  it("exports dynamic = force-dynamic (cache contract)", async () => {
    mockReaders({});
    const mod = await import("../app/api/orders/route");
    expect(mod.dynamic).toBe("force-dynamic");
  });
});
