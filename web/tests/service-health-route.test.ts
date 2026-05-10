/**
 * @vitest-environment node
 *
 * Tests for /api/service-health — DB-only route added in Phase 0.
 * Validates failing-row classification + graceful DB-down behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type MockRow = Record<string, unknown>;

function mockGetDb(rows: MockRow[]): void {
  vi.doMock("@/lib/db", () => ({
    getDb: () => ({
      execute: vi.fn().mockResolvedValue({ rows }),
    }),
  }));
}

function mockDbThrows(message: string): void {
  vi.doMock("@/lib/db", () => ({
    getDb: () => ({
      execute: vi.fn().mockRejectedValue(new Error(message)),
    }),
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("/api/service-health", () => {
  it("returns empty list with summary when no rows exist", async () => {
    mockGetDb([]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.services).toEqual([]);
    expect(body.failing).toEqual([]);
    expect(body.summary).toEqual({ total: 0, failing_count: 0 });
  });

  it("classifies state=ok rows as not failing", async () => {
    const recent = new Date().toISOString();
    mockGetDb([
      {
        service: "portfolio-sync",
        state: "ok",
        last_attempt_started_at: recent,
        last_attempt_finished_at: recent,
        last_error: null,
        updated_at: recent,
      },
    ]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.services).toHaveLength(1);
    expect(body.failing).toHaveLength(0);
  });

  it("classifies state=error as failing", async () => {
    const now = new Date().toISOString();
    mockGetDb([
      {
        service: "cri-scan",
        state: "error",
        last_attempt_started_at: now,
        last_attempt_finished_at: now,
        last_error: "WAL locked",
        updated_at: now,
      },
    ]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.failing).toHaveLength(1);
    expect(body.failing[0].service).toBe("cri-scan");
    expect(body.failing[0].last_error).toBe("WAL locked");
  });

  it("does NOT classify within-window OK rows as failing — daily-cadence services tolerate hours of silence", async () => {
    // cash-flow-sync has a 25h window regardless of market state, so 6h
    // ago is unambiguously fresh.
    const recent = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockGetDb([
      {
        service: "cash-flow-sync",
        state: "ok",
        last_attempt_started_at: recent,
        last_attempt_finished_at: recent,
        last_error: null,
        updated_at: recent,
      },
    ]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.failing).toHaveLength(0);
  });

  it("does NOT classify state=syncing or state=paused as failing", async () => {
    const now = new Date().toISOString();
    mockGetDb([
      { service: "a", state: "syncing", last_attempt_started_at: now, last_attempt_finished_at: null, last_error: null, updated_at: now },
      { service: "b", state: "paused", last_attempt_started_at: now, last_attempt_finished_at: now, last_error: null, updated_at: now },
    ]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.failing).toHaveLength(0);
  });

  it("returns warning + empty list when DB is unreachable", async () => {
    mockDbThrows("connection refused");
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    expect(res.status).toBe(200); // graceful, not 500
    const body = await res.json();
    expect(body.services).toEqual([]);
    expect(body.failing).toEqual([]);
    expect(body.warning).toContain("connection refused");
  });

  it("sets cache: no-store / force-dynamic headers", async () => {
    mockGetDb([]);
    const { GET, dynamic } = await import("../app/api/service-health/route");
    expect(dynamic).toBe("force-dynamic");
    const res = await GET();
    expect(res.headers.get("cache-control") || "").toMatch(/no-store/);
  });

  it("normalises JSON-encoded last_error into a plain error_summary", async () => {
    const now = new Date().toISOString();
    mockGetDb([
      {
        service: "cash-flow-sync",
        state: "error",
        last_attempt_started_at: now,
        last_attempt_finished_at: now,
        last_error: JSON.stringify({
          message: "ERR: cash flow fetch failed: Flex SendRequest failed (code 1001)",
        }),
        updated_at: now,
      },
    ]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.failing).toHaveLength(1);
    const row = body.failing[0];
    // Raw payload preserved on the wire for diagnostic clients.
    expect(row.last_error).toContain("{");
    // But the summary used by the banner is plain prose.
    expect(typeof row.error_summary).toBe("string");
    expect(row.error_summary).toContain("ERR: cash flow fetch failed");
    expect(row.error_summary).not.toContain("{");
    expect(row.error_summary).not.toContain('"');
  });

  it("emits null error_summary when last_error itself is null", async () => {
    const now = new Date().toISOString();
    mockGetDb([
      {
        service: "scanner",
        state: "error",
        last_attempt_started_at: now,
        last_attempt_finished_at: now,
        last_error: null,
        updated_at: now,
      },
    ]);
    const { GET } = await import("../app/api/service-health/route");
    const res = await GET();
    const body = await res.json();
    expect(body.failing[0].error_summary).toBeNull();
  });
});
