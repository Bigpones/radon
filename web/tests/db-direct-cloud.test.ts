import { afterEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.fn((config: unknown) => ({ config }));
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

vi.mock("@libsql/client", () => ({
  createClient: createClientMock,
}));

async function freshDbModule() {
  vi.resetModules();
  createClientMock.mockClear();
  delete process.env.RADON_DB_USE_REPLICA;
  delete process.env.RADON_DB_NO_REPLICA;
  process.env.TURSO_DB_URL = "libsql://example.turso.io";
  process.env.TURSO_AUTH_TOKEN = "token";
  return import("../lib/db");
}

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  delete process.env.RADON_DB_USE_REPLICA;
  delete process.env.RADON_DB_NO_REPLICA;
  delete process.env.TURSO_DB_URL;
  delete process.env.TURSO_AUTH_TOKEN;
});

describe("getDb direct-cloud default", () => {
  it("does not open an embedded replica unless explicitly opted in", async () => {
    const db = await freshDbModule();

    db.getDb();

    expect(createClientMock).toHaveBeenCalledWith({
      url: "libsql://example.turso.io",
      authToken: "token",
    });
  });

  it("allows replica mode only when explicitly enabled and not disabled", async () => {
    const db = await freshDbModule();
    process.env.NODE_ENV = "development";
    process.env.RADON_DB_USE_REPLICA = "1";

    db.getDb();

    expect(createClientMock).toHaveBeenCalledWith(expect.objectContaining({
      syncUrl: "libsql://example.turso.io",
      authToken: "token",
    }));
  });

  it("lets RADON_DB_NO_REPLICA override the opt-in flag", async () => {
    const db = await freshDbModule();
    process.env.RADON_DB_USE_REPLICA = "1";
    process.env.RADON_DB_NO_REPLICA = "1";

    db.getDb();

    expect(createClientMock).toHaveBeenCalledWith({
      url: "libsql://example.turso.io",
      authToken: "token",
    });
  });
});
