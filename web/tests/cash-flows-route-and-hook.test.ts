/**
 * @vitest-environment jsdom
 *
 * Cash-flows route + hook regression guards.
 *
 * Production bug (2026-05-09): a 2026-05-08 withdrawal didn't appear in
 * the panel. Root cause was the daemon cadence (separate fix), but
 * during investigation we re-verified the cache contract and the hook's
 * fetch options. These tests pin both contracts so future refactors
 * can't reintroduce stale-display bugs from the route or hook side.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const radonFetchMock = vi.fn();
vi.mock("@/lib/radonApi", () => ({
  radonFetch: (...args: unknown[]) => radonFetchMock(...args),
}));

function expectNoStore(res: Response): void {
  const cc = res.headers.get("Cache-Control") ?? "";
  expect(cc.toLowerCase()).toContain("no-store");
}

describe("/api/cash-flows route", () => {
  beforeEach(() => {
    radonFetchMock.mockReset();
  });

  it("returns Cache-Control: no-store on success", async () => {
    radonFetchMock.mockResolvedValueOnce({
      rows: [
        {
          id: "39803040384",
          date: "2026-05-08",
          type: "Withdrawal",
          amount: -72_000,
          currency: "USD",
          description: "DISBURSEMENT INITIATED BY Joseph McCann",
          raw_type: "Deposits/Withdrawals",
          synced_at: "2026-05-09T08:00:00Z",
        },
      ],
      count: 1,
      from_date: "2026-02-09",
      summary: { deposits: 0, withdrawals: -72_000, dividends: 0, net: -72_000 },
    });

    const { GET } = await import("@/app/api/cash-flows/route");
    const res = await GET(new Request("http://localhost/api/cash-flows?days=90") as never);
    expect(res.status).toBe(200);
    expectNoStore(res);

    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe("39803040384");
    expect(body.rows[0].amount).toBe(-72_000);
  });

  it("returns Cache-Control: no-store on FastAPI failure (502 path)", async () => {
    radonFetchMock.mockRejectedValueOnce(new Error("upstream-down"));

    const { GET } = await import("@/app/api/cash-flows/route");
    const res = await GET(new Request("http://localhost/api/cash-flows?days=90") as never);
    expect(res.status).toBe(502);
    expectNoStore(res);

    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.error).toContain("upstream-down");
  });

  it("forwards days + types query params to FastAPI", async () => {
    radonFetchMock.mockResolvedValueOnce({
      rows: [],
      count: 0,
      from_date: "2026-04-09",
      summary: { deposits: 0, withdrawals: 0, dividends: 0, net: 0 },
    });

    const { GET } = await import("@/app/api/cash-flows/route");
    await GET(new Request("http://localhost/api/cash-flows?days=30&types=Withdrawal") as never);
    expect(radonFetchMock).toHaveBeenCalledWith(
      "/cash-flows?days=30&types=Withdrawal",
    );
  });
});

describe("useCashFlows hook fetch options", () => {
  let originalFetch: typeof fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rows: [],
          count: 0,
          from_date: "2026-02-09",
          summary: { deposits: 0, withdrawals: 0, dividends: 0, net: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("passes cache: no-store to /api/cash-flows", async () => {
    const { useCashFlows } = await import("@/lib/useCashFlows");
    const { renderHook, waitFor } = await import("@testing-library/react");

    const { result } = renderHook(() => useCashFlows(90));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toMatch(/\/api\/cash-flows\?days=90/);
    expect(call[1]).toMatchObject({ cache: "no-store" });
  });
});
