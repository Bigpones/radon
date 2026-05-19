/**
 * @vitest-environment jsdom
 *
 * Hook + proxy-route regression guards for the LLM Token Expenditure Index.
 *
 * Pins the contract surface the Regime card depends on: route forwards
 * `days` to FastAPI, hook uses cache:"no-store", payload survives the
 * round-trip end-to-end.
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

describe("/api/llm-token-index route", () => {
  beforeEach(() => {
    radonFetchMock.mockReset();
  });

  it("returns Cache-Control: no-store on success", async () => {
    radonFetchMock.mockResolvedValueOnce({
      rows: [
        { date: "2026-05-17", index_value: 1.0, raw_avg_usd: 15.0, methodology_version: 1 },
        { date: "2026-05-18", index_value: 1.10, raw_avg_usd: 16.5, methodology_version: 1 },
      ],
      count: 2,
      days: 180,
      fetched_at: "2026-05-19T06:30:00Z",
    });

    const { GET } = await import("@/app/api/llm-token-index/route");
    const res = await GET(new Request("http://localhost/api/llm-token-index?days=180") as never);
    expect(res.status).toBe(200);
    expectNoStore(res);

    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].index_value).toBe(1.0);
    expect(body.rows[1].index_value).toBe(1.10);
  });

  it("forwards `days` to FastAPI verbatim", async () => {
    radonFetchMock.mockResolvedValueOnce({ rows: [], count: 0, days: 30, fetched_at: "x" });

    const { GET } = await import("@/app/api/llm-token-index/route");
    await GET(new Request("http://localhost/api/llm-token-index?days=30") as never);

    expect(radonFetchMock).toHaveBeenCalledWith("/llm-token-index?days=30");
  });

  it("defaults to days=180 when not provided", async () => {
    radonFetchMock.mockResolvedValueOnce({ rows: [], count: 0, days: 180, fetched_at: "x" });

    const { GET } = await import("@/app/api/llm-token-index/route");
    await GET(new Request("http://localhost/api/llm-token-index") as never);

    expect(radonFetchMock).toHaveBeenCalledWith("/llm-token-index?days=180");
  });

  it("returns 502 + empty payload on FastAPI failure (no 5xx leakage)", async () => {
    radonFetchMock.mockRejectedValueOnce(new Error("upstream-down"));

    const { GET } = await import("@/app/api/llm-token-index/route");
    const res = await GET(new Request("http://localhost/api/llm-token-index?days=90") as never);
    expect(res.status).toBe(502);
    expectNoStore(res);

    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.error).toContain("upstream-down");
  });
});

describe("useLlmTokenIndex hook", () => {
  let originalFetch: typeof fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rows: [
            { date: "2026-05-19", index_value: 1.05, raw_avg_usd: 15.75, methodology_version: 1 },
          ],
          count: 1,
          days: 180,
          fetched_at: "2026-05-19T06:30:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requests with cache: no-store and parses the payload", async () => {
    const { useLlmTokenIndex } = await import("@/lib/useLlmTokenIndex");
    const { renderHook, waitFor } = await import("@testing-library/react");

    const { result } = renderHook(() => useLlmTokenIndex(180));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/llm-token-index?days=180");
    expect(opts).toMatchObject({ cache: "no-store" });

    expect(result.current.data?.rows).toHaveLength(1);
    expect(result.current.data?.rows[0].index_value).toBe(1.05);
    expect(result.current.error).toBeNull();
  });

  it("surfaces HTTP errors as `error` string, never throws", async () => {
    global.fetch = vi.fn(async () =>
      new Response("server boom", { status: 503 }),
    ) as unknown as typeof fetch;

    const { useLlmTokenIndex } = await import("@/lib/useLlmTokenIndex");
    const { renderHook, waitFor } = await import("@testing-library/react");

    const { result } = renderHook(() => useLlmTokenIndex(180));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/HTTP 503/);
    expect(result.current.data).toBeNull();
  });

  it("handles empty payload as data: rows=[], not as an error", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ rows: [], count: 0, days: 180 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const { useLlmTokenIndex } = await import("@/lib/useLlmTokenIndex");
    const { renderHook, waitFor } = await import("@testing-library/react");

    const { result } = renderHook(() => useLlmTokenIndex(180));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data?.rows).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
