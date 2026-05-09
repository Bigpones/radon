/**
 * Bug guard: /api/flow-analysis/[ticker] must return Cache-Control: no-store
 * on every response so browsers and intermediaries never serve a stale snapshot.
 *
 * The sibling /api/flow-analysis route was fixed in ee8c401; this dynamic
 * route was missed by that commit and got the same audit-driven fix.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, statSync: vi.fn() };
});

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("@/lib/radonApi", () => ({
  radonFetch: vi.fn().mockResolvedValue({
    ticker: "AAPL",
    analysis_time: "2026-05-09T02:04:09.999Z",
  }),
}));

import * as fs from "fs";
import { readFile } from "fs/promises";

function expectNoStore(res: Response): void {
  const cc = res.headers.get("Cache-Control") ?? "";
  expect(cc.toLowerCase()).toContain("no-store");
}

const tickerCtx = { params: Promise.resolve({ ticker: "AAPL" }) };
const invalidCtx = { params: Promise.resolve({ ticker: "lowercase" }) };

describe("/api/flow-analysis/[ticker] — Cache-Control: no-store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ ticker: "AAPL", analysis_time: "2026-05-09T02:04:09.999Z" }) as unknown as string,
    );
    vi.mocked(fs.statSync).mockReturnValue({ mtime: new Date() } as unknown as fs.Stats);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET sets no-store when serving the disk-fallback report", async () => {
    const { GET } = await import("../app/api/flow-analysis/[ticker]/route");
    const res = await GET(new Request("http://test/api/flow-analysis/AAPL"), tickerCtx);
    expectNoStore(res);
  });

  it("GET sets no-store on the 404 missing-report envelope", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { GET } = await import("../app/api/flow-analysis/[ticker]/route");
    const res = await GET(new Request("http://test/api/flow-analysis/AAPL"), tickerCtx);
    expectNoStore(res);
  });

  it("GET sets no-store on the 400 invalid-ticker envelope", async () => {
    const { GET } = await import("../app/api/flow-analysis/[ticker]/route");
    const res = await GET(new Request("http://test/api/flow-analysis/lowercase"), invalidCtx);
    expectNoStore(res);
  });

  it("POST sets no-store on the FastAPI-passthrough response", async () => {
    const { POST } = await import("../app/api/flow-analysis/[ticker]/route");
    const res = await POST(new Request("http://test", { method: "POST" }), tickerCtx);
    expectNoStore(res);
  });
});
