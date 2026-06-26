/**
 * Bug guard: /api/blotter must return Cache-Control: no-store on every
 * response so browsers and intermediaries never serve a stale snapshot.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }),
}));

vi.mock("@/lib/radonApi", () => ({
  radonFetch: vi.fn().mockResolvedValue({
    as_of: "2026-05-09",
    summary: { closed_trades: 0, open_trades: 0, total_commissions: 0, realized_pnl: 0 },
    closed_trades: [],
    open_trades: [],
  }),
}));

import { readFile } from "fs/promises";

const validCachePayload = JSON.stringify({
  as_of: "2026-05-09",
  summary: { closed_trades: 0, open_trades: 0, total_commissions: 0, realized_pnl: 0 },
  closed_trades: [],
  open_trades: [],
});

function expectNoStore(res: Response): void {
  const cc = res.headers.get("Cache-Control") ?? "";
  expect(cc.toLowerCase()).toContain("no-store");
}

describe("/api/blotter — Cache-Control: no-store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFile).mockResolvedValue(validCachePayload as unknown as string);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET sets no-store when serving the disk-fallback cache file", async () => {
    const { GET } = await import("../app/api/blotter/route");
    const res = await GET();
    expectNoStore(res);
  });

  it("GET sets no-store on the empty-payload envelope when DB and disk are both empty", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const { GET } = await import("../app/api/blotter/route");
    const res = await GET();
    expectNoStore(res);
  });

  it("POST sets no-store on the FastAPI-passthrough response", async () => {
    const { POST } = await import("../app/api/blotter/route");
    const res = await POST();
    expectNoStore(res);
  });
});
