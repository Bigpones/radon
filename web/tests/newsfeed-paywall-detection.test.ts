// Cycle-level paywall guard.
//
// Bug being prevented (2026-05-16): themarketear.com flipped Joe's session
// to free-tier mid-window — same /newsfeed URL, same article cards, but
// every body was replaced with:
//
//   "This article is part of our Premium coverage, please click here to
//    login and access it or sign up for a Premium account."
//
// The 6h auth gate in index.js was inside its window so authenticateIfNeeded
// short-circuited without re-checking the DOM, and the cycle silently
// persisted paywall stubs into posts.json for ~21h before someone noticed.
//
// Fix: scan each extracted body for the canonical paywall string. On
// detection, force re-auth on the NEXT cycle (don't block this one with a
// 30s login flow), discard the paywalled posts from this cycle's write,
// and write service_health=error so the banner surfaces the regression.
//
// These tests pin all four guarantees plus a couple of edge cases.

import { describe, expect, it } from "vitest";

const PAYWALL_FULL =
  "This article is part of our Premium coverage, please click here to login and access it or sign up for a Premium account.";

// Stable cycle deps factory — every test overrides only what it cares about.
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    cycleStartIso: "2026-05-17T12:00:00Z",
    loadExistingPosts: async () => [],
    scrapePosts: async () => ({ items: [] }),
    mergePosts: (existing: unknown[], items: unknown[]) => ({
      merged: items.map((item) => ({ ...(item as object) })),
      changed: true,
    }),
    hydrateLocalImages: async () => false,
    persistPosts: async () => ({ archived: false }),
    pushMedia: async () => ({ ok: true, transferred: 0 }),
    upsertPosts: async () => {},
    hydrateTagsDual: async () => false,
    recordServiceHealth: async () => {},
    buildTextTagger: () => ({ tagPost: async () => null }),
    buildVisionTagger: () => ({ tagPost: async () => null }),
    onNewTags: async () => {},
    requestReauth: () => {},
    paths: {
      dataDir: "/tmp/x",
      archiveDir: "/tmp/x/archive",
      mediaDir: "/tmp/x/media",
      postsFile: "/tmp/x/posts.json",
      projectRoot: "/tmp/x",
      publicRoot: "/tmp/x/public",
    },
    ...overrides,
  };
}

describe("isPaywalledItem", () => {
  it("detects the exact canonical paywall message", async () => {
    const { isPaywalledItem } = await import("../../scripts/newsfeed/cycle.js");
    expect(
      isPaywalledItem({
        id: "p1",
        title: "Whatever",
        content: PAYWALL_FULL,
        timestamp: "2026-05-17T12:00:00Z",
      }),
    ).toBe(true);
  });

  it("detects the secondary substring even when embedded in surrounding prose", async () => {
    const { isPaywalledItem } = await import("../../scripts/newsfeed/cycle.js");
    expect(
      isPaywalledItem({
        id: "p1",
        title: "Whatever",
        content: "Some intro… this is part of our Premium coverage. Subscribe!",
        timestamp: "2026-05-17T12:00:00Z",
      }),
    ).toBe(true);
  });

  it("returns false for legitimate post bodies", async () => {
    const { isPaywalledItem } = await import("../../scripts/newsfeed/cycle.js");
    expect(
      isPaywalledItem({
        id: "p1",
        title: "BTC ripping",
        content: "Real content about markets, no stub here.",
        timestamp: "2026-05-17T12:00:00Z",
      }),
    ).toBe(false);
  });

  it("returns false for items with no body", async () => {
    const { isPaywalledItem } = await import("../../scripts/newsfeed/cycle.js");
    expect(isPaywalledItem({ id: "p1", title: "x", content: "", timestamp: "" })).toBe(false);
    expect(isPaywalledItem({ id: "p1", title: "x", timestamp: "" } as never)).toBe(false);
  });

  it("returns false for null/undefined input without throwing", async () => {
    const { isPaywalledItem } = await import("../../scripts/newsfeed/cycle.js");
    expect(isPaywalledItem(null as never)).toBe(false);
    expect(isPaywalledItem(undefined as never)).toBe(false);
  });
});

describe("runScrapeCycle — paywall detection on the exact canonical message", () => {
  it("invokes requestReauth and records service_health=error when ALL items are paywall stubs", async () => {
    const { runScrapeCycle } = await import("../../scripts/newsfeed/cycle.js");

    let reauthCalls = 0;
    const healthCalls: Array<{ state: string; error?: { message?: string } }> = [];
    const persistCalls: string[] = [];
    const upsertCalls: number[] = [];

    const result = await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({
          items: [
            {
              id: "p1",
              title: "Stub 1",
              content: PAYWALL_FULL,
              timestamp: "2026-05-17T12:00:00Z",
            },
            {
              id: "p2",
              title: "Stub 2",
              content: PAYWALL_FULL,
              timestamp: "2026-05-17T12:01:00Z",
            },
          ],
        }),
        requestReauth: () => {
          reauthCalls += 1;
        },
        recordServiceHealth: async (_service: string, state: string, extra?: { error?: { message?: string } }) => {
          healthCalls.push({ state, error: extra?.error });
        },
        persistPosts: async () => {
          persistCalls.push("persist");
          return { archived: false };
        },
        upsertPosts: async (posts: unknown[]) => {
          upsertCalls.push((posts as unknown[]).length);
        },
      }),
    );

    expect(reauthCalls).toBe(1);
    expect(result.changed).toBe(false);
    expect(result.count).toBe(0);
    // Banner must show the regression — no `ok` heartbeat allowed to mask it.
    expect(healthCalls.length).toBeGreaterThanOrEqual(1);
    expect(healthCalls.some((c) => c.state === "error")).toBe(true);
    expect(healthCalls.every((c) => c.state !== "ok")).toBe(true);
    const errorRow = healthCalls.find((c) => c.state === "error");
    expect(errorRow?.error?.message).toMatch(/paywall stubs detected/i);
    // Paywalled posts MUST NOT reach posts.json or the DB.
    expect(persistCalls.length).toBe(0);
    expect(upsertCalls.length).toBe(0);
  });

  it("filters out only the paywalled posts on a mixed cycle (keeps the clean ones)", async () => {
    const { runScrapeCycle } = await import("../../scripts/newsfeed/cycle.js");

    let reauthCalls = 0;
    const persistedCounts: number[] = [];
    const upsertCounts: number[] = [];

    await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({
          items: [
            {
              id: "clean-1",
              title: "Real post",
              content: "Genuine content about NVDA earnings.",
              timestamp: "2026-05-17T12:00:00Z",
            },
            {
              id: "stub-1",
              title: "Stub",
              content: PAYWALL_FULL,
              timestamp: "2026-05-17T12:01:00Z",
            },
            {
              id: "clean-2",
              title: "Another real post",
              content: "More legit content about CPI prints.",
              timestamp: "2026-05-17T12:02:00Z",
            },
          ],
        }),
        requestReauth: () => {
          reauthCalls += 1;
        },
        persistPosts: async (posts: unknown[]) => {
          persistedCounts.push((posts as unknown[]).length);
          return { archived: false };
        },
        upsertPosts: async (posts: unknown[]) => {
          upsertCounts.push((posts as unknown[]).length);
        },
      }),
    );

    // Re-auth still scheduled — partial paywall still indicates the session
    // is degrading.
    expect(reauthCalls).toBe(1);
    // Only the two clean posts should be persisted; the stub must be dropped.
    expect(persistedCounts.length).toBeGreaterThanOrEqual(1);
    persistedCounts.forEach((n) => expect(n).toBe(2));
    upsertCounts.forEach((n) => expect(n).toBe(2));
  });

  it("does NOT write service_health=ok on a paywall-only empty cycle (preserves the error banner)", async () => {
    const { runScrapeCycle } = await import("../../scripts/newsfeed/cycle.js");

    const healthStates: string[] = [];

    await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({
          items: [
            {
              id: "p1",
              title: "Stub",
              content: PAYWALL_FULL,
              timestamp: "2026-05-17T12:00:00Z",
            },
          ],
        }),
        recordServiceHealth: async (_service: string, state: string) => {
          healthStates.push(state);
        },
      }),
    );

    expect(healthStates).toContain("error");
    expect(healthStates).not.toContain("ok");
  });

  it("does NOT crash when scrape returns zero items even with the paywall path armed", async () => {
    const { runScrapeCycle } = await import("../../scripts/newsfeed/cycle.js");

    const result = await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({ items: [] }),
      }),
    );

    expect(result).toEqual({ changed: false, count: 0, paywalled: 0 });
  });

  it("two consecutive paywall cycles each fire requestReauth (recovers after the next re-auth flow)", async () => {
    // Confirms there is no internal latch suppressing a second alert if the
    // server-side downgrade persists across cycles. Each detection forces
    // the gate open so the wrapping authenticateIfNeeded re-runs the login
    // flow next time.
    const { runScrapeCycle } = await import("../../scripts/newsfeed/cycle.js");

    let reauthCalls = 0;
    const requestReauth = () => {
      reauthCalls += 1;
    };

    const paywallItems = [
      {
        id: "p1",
        title: "Stub",
        content: PAYWALL_FULL,
        timestamp: "2026-05-17T12:00:00Z",
      },
    ];

    await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({ items: paywallItems }),
        requestReauth,
      }),
    );

    await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({ items: paywallItems }),
        requestReauth,
      }),
    );

    expect(reauthCalls).toBe(2);
  });

  it("survives a throwing requestReauth without breaking the cycle", async () => {
    const { runScrapeCycle } = await import("../../scripts/newsfeed/cycle.js");

    const result = await runScrapeCycle(
      makeDeps({
        scrapePosts: async () => ({
          items: [
            {
              id: "p1",
              title: "Stub",
              content: PAYWALL_FULL,
              timestamp: "2026-05-17T12:00:00Z",
            },
          ],
        }),
        requestReauth: () => {
          throw new Error("simulated reauth-flag failure");
        },
      }),
    );

    // Cycle must complete cleanly; the regression-recovery hook is best-effort.
    expect(result.changed).toBe(false);
  });
});

describe("auth.js — pageHasPremiumContent catches the canonical full message", () => {
  it("returns false when every article body contains the EXACT user-quoted paywall message", async () => {
    // The existing newsfeed-auth.test.ts coverage uses the loose substring
    // marker. This test pins that the full canonical message — the one the
    // user quoted verbatim — also trips the auth probe. If themarketear.com
    // tweaks the substring later, this test guards the canonical anchor.
    //
    // We replicate pageHasPremiumContent's exact DOM-side branch:
    //   - 0 article bodies → unauthenticated (return false)
    //   - any body without the marker → premium (return true)
    //   - every body contains the marker → stubbed (return false)
    const { PAYWALL_STUB_MARKER, PAYWALL_FULL_MESSAGE } = await import(
      "../../scripts/newsfeed/auth.js"
    );

    // The exact full message must contain the loose marker — that's the
    // contract that lets the auth DOM probe catch it.
    expect(PAYWALL_FULL_MESSAGE.includes(PAYWALL_STUB_MARKER)).toBe(true);

    // Simulate the page.evaluate body: every "article body" contains the
    // full canonical paywall string → probe must return false.
    const bodies = [PAYWALL_FULL_MESSAGE, PAYWALL_FULL_MESSAGE];
    const isPremium = (() => {
      if (bodies.length === 0) return false;
      for (const text of bodies) {
        if (text && !text.includes(PAYWALL_STUB_MARKER)) return true;
      }
      return false;
    })();
    expect(isPremium).toBe(false);
  });
});
