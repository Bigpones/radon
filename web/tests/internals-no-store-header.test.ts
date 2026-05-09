/**
 * Bug guard: /api/internals must return Cache-Control: no-store on every
 * response so browsers and intermediaries never serve a stale snapshot.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/radonApi", () => ({
  radonFetch: vi.fn().mockResolvedValue({}),
}));

import { readFile, stat } from "fs/promises";

function expectNoStore(res: Response): void {
  const cc = res.headers.get("Cache-Control") ?? "";
  expect(cc.toLowerCase()).toContain("no-store");
}

const validCriPayload = JSON.stringify({
  scan_time: "2026-05-08T20:00:00Z",
  date: "2026-05-08",
  vix: 15,
  vvix: 80,
  spy: 500,
  cri: { score: 1, level: "LOW" },
  cta: { realized_vol: 10, exposure_pct: 200, forced_reduction_pct: 0, est_selling_bn: 0 },
  history: [],
  spy_closes: [],
});

describe("/api/internals — Cache-Control: no-store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFile).mockResolvedValue(validCriPayload as unknown as string);
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET sets no-store on the success path", async () => {
    const { GET } = await import("../app/api/internals/route");
    const res = await GET();
    expectNoStore(res);
  });

  it("POST sets no-store on the success path", async () => {
    const { POST } = await import("../app/api/internals/route");
    const res = await POST();
    expectNoStore(res);
  });
});
