/**
 * Smoke tests for /api/futures/chain + place-order future branch.
 *
 * Follows the same mocking strategy as web/tests/api-routes-smoke.test.ts
 * — radonFetch is mocked so the test never reaches a real FastAPI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRadonFetch = vi.fn();
vi.mock("@/lib/radonApi", () => ({
  radonFetch: mockRadonFetch,
  RadonApiError: class RadonApiError extends Error {
    status: number;
    detail: string;
    constructor(status: number, detail: string) {
      super(`Radon API ${status}: ${detail}`);
      this.name = "RadonApiError";
      this.status = status;
      this.detail = detail;
    }
  },
}));

const mockReadFile = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

beforeEach(() => {
  mockRadonFetch.mockReset();
  mockReadFile.mockReset();
  // Default: no disk cache present.
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
});

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

async function jsonOf(res: Response): Promise<unknown> {
  return res.json();
}

describe("GET /api/futures/chain", () => {
  it("returns 400 when symbol missing", async () => {
    const { GET } = await import("../app/api/futures/chain/route");
    const res = await GET(req("http://localhost/api/futures/chain"));
    expect(res.status).toBe(400);
  });

  it("forwards symbol to FastAPI and returns the payload", async () => {
    mockRadonFetch.mockResolvedValueOnce({
      symbol: "VIX",
      exchange: "CFE",
      contracts: [
        { conId: 1, localSymbol: "VXM6", lastTradeDateOrContractMonth: "20260617", multiplier: "1000" },
      ],
      count: 1,
    });
    const { GET } = await import("../app/api/futures/chain/route");
    const res = await GET(req("http://localhost/api/futures/chain?symbol=vix"));
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as Record<string, unknown>;
    expect(body.symbol).toBe("VIX");
    expect(Array.isArray(body.contracts)).toBe(true);
    expect(mockRadonFetch).toHaveBeenCalledWith(
      "/futures/chain?symbol=VIX",
      expect.objectContaining({ timeout: 28_000 }),
    );
  });

  it("returns 502 envelope when FastAPI fails and no disk cache exists", async () => {
    mockRadonFetch.mockRejectedValueOnce(new Error("upstream down"));
    const { GET } = await import("../app/api/futures/chain/route");
    const res = await GET(req("http://localhost/api/futures/chain?symbol=VIX"));
    expect(res.status).toBe(502);
    const body = (await jsonOf(res)) as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it("serves the disk cache flagged stale when FastAPI fails", async () => {
    mockRadonFetch.mockRejectedValueOnce(new Error("upstream down"));
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        symbol: "VIX",
        exchange: "CFE",
        contracts: [
          { conId: 1, localSymbol: "VXM6", lastTradeDateOrContractMonth: "20260617", multiplier: "1000" },
        ],
        count: 1,
        as_of_date: "2026-06-01",
      }),
    );
    const { GET } = await import("../app/api/futures/chain/route");
    const res = await GET(req("http://localhost/api/futures/chain?symbol=VIX"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sync-Warning")).toContain("serving cached data");
    const body = (await jsonOf(res)) as Record<string, unknown>;
    expect(body.symbol).toBe("VIX");
    expect(body.stale).toBe(true);
    expect(Array.isArray(body.contracts)).toBe(true);
  });
});

describe("PlaceOrderBodySchema (future branch)", () => {
  it("accepts type=future with conId", async () => {
    const { PlaceOrderBodySchema } = await import("../lib/placeOrderBodySchema");
    const { Value } = await import("@sinclair/typebox/value");
    const ok = Value.Check(PlaceOrderBodySchema, {
      type: "future",
      symbol: "VIX",
      action: "BUY",
      quantity: 1,
      limitPrice: 19.4,
      conId: 816186011,
      exchange: "CFE",
    });
    expect(ok).toBe(true);
  });

  it("accepts type=future with expiry instead of conId", async () => {
    const { PlaceOrderBodySchema } = await import("../lib/placeOrderBodySchema");
    const { Value } = await import("@sinclair/typebox/value");
    const ok = Value.Check(PlaceOrderBodySchema, {
      type: "future",
      symbol: "VIX",
      action: "SELL",
      quantity: 2,
      limitPrice: 19.0,
      expiry: "20260617",
    });
    expect(ok).toBe(true);
  });

  it("rejects an unknown type literal", async () => {
    const { PlaceOrderBodySchema } = await import("../lib/placeOrderBodySchema");
    const { Value } = await import("@sinclair/typebox/value");
    const ok = Value.Check(PlaceOrderBodySchema, {
      type: "perpetual",
      symbol: "VIX",
      action: "BUY",
      quantity: 1,
      limitPrice: 19.4,
    });
    expect(ok).toBe(false);
  });
});
