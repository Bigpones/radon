/**
 * Bug guard: /api/journal must return Cache-Control: no-store on every
 * response so browsers and intermediaries never serve a stale snapshot.
 *
 * Same class of bug as flow-analysis (commit ee8c401): `dynamic = "force-dynamic"`
 * only opts out of Next.js's static-page cache; the response itself was
 * heuristically cached by Caddy/the browser. The fix is to wrap every
 * NextResponse.json(...) in setNoStoreResponseHeaders(...).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }),
}));

vi.mock("@/lib/radonApi", () => ({
  radonFetch: vi.fn().mockResolvedValue({ trades: [] }),
}));

vi.mock("@/lib/journalSync", () => ({
  runJournalSync: vi.fn().mockResolvedValue(undefined),
}));

import { readFile, stat } from "fs/promises";

function expectNoStore(res: Response): void {
  const cc = res.headers.get("Cache-Control") ?? "";
  expect(cc.toLowerCase()).toContain("no-store");
}

describe("/api/journal — Cache-Control: no-store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ trades: [{ ticker: "AAPL", filled_at: "2026-05-08", date: "2026-05-08" }] }) as unknown as string,
    );
    vi.mocked(stat).mockResolvedValue({
      mtimeMs: Date.now(),
    } as unknown as Awaited<ReturnType<typeof stat>>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET sets no-store when serving the disk fallback", async () => {
    const { GET } = await import("../app/api/journal/route");
    const res = await GET();
    expectNoStore(res);
  });

  it("GET sets no-store on the 500 error envelope when both reads fail", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
    const { GET } = await import("../app/api/journal/route");
    const res = await GET();
    expectNoStore(res);
  });

  it("POST sets no-store on the FastAPI-passthrough success path", async () => {
    const { POST } = await import("../app/api/journal/route");
    const res = await POST();
    expectNoStore(res);
  });
});
