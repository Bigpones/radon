/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { dbFirstRead } from "../lib/dbFirstRead";

describe("dbFirstRead", () => {
  it("returns DB data when fromDb resolves with non-null", async () => {
    const result = await dbFirstRead({
      fromDb: async () => ({ value: 42 }),
      fromDisk: async () => ({ value: 99 }),
    });
    expect(result).toEqual({ ok: true, source: "db", data: { value: 42 } });
  });

  it("falls back to disk when fromDb returns null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dbFirstRead({
      fromDb: async () => null,
      fromDisk: async () => ({ value: 99 }),
      label: "test-route",
    });
    expect(result).toEqual({ ok: true, source: "disk", data: { value: 99 } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to disk when fromDb throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dbFirstRead({
      fromDb: async () => {
        throw new Error("WAL locked");
      },
      fromDisk: async () => ({ value: 99 }),
    });
    expect(result).toEqual({ ok: true, source: "disk", data: { value: 99 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WAL locked"));
    warn.mockRestore();
  });

  it("returns ok=false when both fromDb and fromDisk return null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dbFirstRead({
      fromDb: async () => null,
      fromDisk: async () => null,
    });
    expect(result).toEqual({ ok: false });
    warn.mockRestore();
  });

  it("returns ok=false when fromDb throws AND fromDisk throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dbFirstRead({
      fromDb: async () => {
        throw new Error("db");
      },
      fromDisk: async () => {
        throw new Error("disk");
      },
    });
    expect(result).toEqual({ ok: false });
    warn.mockRestore();
  });

  it("treats undefined as null on fromDb (falls through)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dbFirstRead({
      fromDb: async () => undefined as unknown as null,
      fromDisk: async () => ({ value: 5 }),
    });
    expect(result).toEqual({ ok: true, source: "disk", data: { value: 5 } });
    warn.mockRestore();
  });

  it("includes label in warn message when label provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dbFirstRead({
      fromDb: async () => null,
      fromDisk: async () => ({ value: 1 }),
      label: "portfolio",
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("portfolio"))).toBe(true);
    warn.mockRestore();
  });
});
