/**
 * @vitest-environment node
 *
 * Verifies /api/portfolio derives `trade_log_dates` from the journal
 * table when DB rows exist, and falls back to data/trade_log.json on
 * disk only when the DB is empty or unreachable. Phase 4-followup of
 * the Turso source-of-truth migration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStat = vi.fn().mockResolvedValue({ mtimeMs: Date.now() - 5_000 });
const mockReadFile = vi.fn();
vi.mock("fs/promises", () => ({
  stat: mockStat,
  readFile: mockReadFile,
}));

const mockReadDataFile = vi.fn();
vi.mock("@tools/data-reader", () => ({ readDataFile: mockReadDataFile }));

vi.mock("@tools/schemas/ib-sync", () => ({ PortfolioData: {} }));

const mockRadonFetch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/radonApi", () => ({ radonFetch: mockRadonFetch }));

const mockExecute = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: mockExecute }) }));

function makePortfolio() {
  return {
    bankroll: 100_000,
    peak_value: 100_000,
    last_sync: "2026-05-07T12:00:00Z",
    positions: [],
    total_deployed_pct: 0,
    total_deployed_dollars: 0,
    remaining_capacity_pct: 100,
    position_count: 0,
    defined_risk_count: 0,
    undefined_risk_count: 0,
    avg_kelly_optimal: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  mockExecute.mockReset();
  mockReadFile.mockReset();
  mockReadDataFile.mockReset();
  mockReadDataFile.mockResolvedValue({ ok: true, data: makePortfolio() });
});

describe("GET /api/portfolio — trade_log_dates source", () => {
  it("derives trade_log_dates from the journal table when DB has rows", async () => {
    mockExecute.mockImplementation(async ({ sql }: { sql: string }) => {
      // First (and only) call should target the journal table.
      expect(sql).toMatch(/FROM\s+journal/i);
      return {
        rows: [
          { ticker: "INTC", date: "2026-05-05" },
          { ticker: "TSLA", date: "2026-04-22" },
        ],
      };
    });
    // Disk has STALE data — should be ignored when DB has rows.
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        trades: [{ ticker: "INTC", date: "2024-01-01" }],
      }),
    );

    const { GET } = await import("../app/api/portfolio/route");
    const res = await GET();
    const body = await res.json();

    expect(body.trade_log_dates).toEqual({
      INTC: "2026-05-05",
      TSLA: "2026-04-22",
    });
    // We must not even try the disk read once the DB returns rows.
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("falls back to trade_log.json when the journal table is empty", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        trades: [
          { ticker: "AMD", date: "2026-03-05" },
          { ticker: "AMD", date: "2026-04-10" }, // newer wins
          { ticker: "GOOG", date: "2026-02-14" },
        ],
      }),
    );

    const { GET } = await import("../app/api/portfolio/route");
    const res = await GET();
    const body = await res.json();

    expect(body.trade_log_dates).toEqual({
      AMD: "2026-04-10",
      GOOG: "2026-02-14",
    });
  });

  it("falls back to disk when the DB query throws", async () => {
    mockExecute.mockRejectedValue(new Error("WAL locked"));
    mockReadFile.mockResolvedValue(
      JSON.stringify({ trades: [{ ticker: "PLTR", date: "2026-04-23" }] }),
    );

    const { GET } = await import("../app/api/portfolio/route");
    const res = await GET();
    const body = await res.json();

    expect(body.trade_log_dates).toEqual({ PLTR: "2026-04-23" });
  });

  it("returns an empty trade_log_dates map when neither source has data", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const { GET } = await import("../app/api/portfolio/route");
    const res = await GET();
    const body = await res.json();

    expect(body.trade_log_dates).toEqual({});
  });
});
