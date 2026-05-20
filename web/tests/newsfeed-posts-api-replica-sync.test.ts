// Replica-sync contract for /api/newsfeed/posts.
//
// Root cause (observed 2026-05-20): the radon-nextjs.service process on
// Hetzner opens the libsql embedded replica at boot. The replica relies on
// a background `syncInterval: 60` worker to pull updates from the cloud DB.
// In production that background sync silently stalled — the replica file at
// /home/radon/radon/data/replica.db was last written at 02:22 UTC while the
// scraper kept upserting fresh posts directly to the cloud Turso instance.
// The Next.js process kept serving 11-hour-stale rows out of the cached
// replica even though `cache-control: no-store` was set, because the cache
// it bypassed was Next.js's not the libsql replica's.
//
// Fix: the freshness-critical newsfeed route MUST call db.sync() before
// SELECT so a stalled background worker can never starve the dashboard
// of new posts. Other routes can keep using the cached replica because
// staleness is acceptable for them.
//
// This test guards the contract by injecting a libsql client with a
// trackable `sync` method and asserting that the GET handler invokes it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL,
  content     TEXT,
  timestamp   TEXT    NOT NULL,
  images      TEXT,
  raw_images  TEXT,
  tags        TEXT,
  tags_text   TEXT,
  tags_vision TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
`;

type ClientWithSync = Client & { sync: ReturnType<typeof vi.fn> };

async function makeClientWithSyncSpy(): Promise<ClientWithSync> {
  const raw = createClient({ url: ":memory:" });
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await raw.execute(stmt);
  }
  // In-memory clients have no `sync` method by default — patch one on so
  // the route's freshness call has a target.
  const sync = vi.fn(async () => undefined);
  return Object.assign(raw, { sync }) as ClientWithSync;
}

let db: ClientWithSync;

beforeEach(async () => {
  db = await makeClientWithSyncSpy();
  const dbModule = await import("../lib/db");
  dbModule.__setDbForTests(db);
});

afterEach(async () => {
  const dbModule = await import("../lib/db");
  dbModule.__resetDbForTests();
  db.close();
});

describe("/api/newsfeed/posts replica freshness", () => {
  it("calls db.sync() before reading so a stalled replica can't serve stale rows", async () => {
    await db.execute({
      sql: "INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        "fresh",
        "Fresh post",
        null,
        "2026-05-20T13:00:00Z",
        "[]",
        "[]",
        "[]",
        "[]",
        "[]",
        "2026-05-20T13:00:00Z",
        "2026-05-20T13:00:00Z",
      ],
    });

    const { GET } = await import("../app/api/newsfeed/posts/route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(db.sync).toHaveBeenCalledTimes(1);

    const data = await response.json();
    expect(data[0].id).toBe("fresh");
  });

  it("still returns posts when sync() throws (network blip must not blank the feed)", async () => {
    await db.execute({
      sql: "INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        "cached",
        "Cached post",
        null,
        "2026-05-20T12:00:00Z",
        "[]",
        "[]",
        "[]",
        "[]",
        "[]",
        "2026-05-20T12:00:00Z",
        "2026-05-20T12:00:00Z",
      ],
    });

    db.sync.mockRejectedValueOnce(new Error("upstream unreachable"));

    const { GET } = await import("../app/api/newsfeed/posts/route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(db.sync).toHaveBeenCalledTimes(1);

    const data = await response.json();
    expect(data[0].id).toBe("cached");
  });
});
