import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");

// Disk-backed GET routes that read live JSON state from the data/ tree.
// All of these MUST opt out of Next.js's static-route cache, otherwise the
// first GET response gets frozen for the lifetime of the dev server and
// subsequent calls serve stale data even after the underlying file changes.
// The CTA route was the canary; commit 0575bc1 fixed it. This contract test
// keeps the rest of the family in line.
const DYNAMIC_ROUTES = [
  "app/api/menthorq/cta/route.ts",
  "app/api/journal/route.ts",
  "app/api/discover/route.ts",
  "app/api/flow-analysis/route.ts",
  "app/api/blotter/route.ts",
  "app/api/vcg/route.ts",
  "app/api/internals/route.ts",
  "app/api/portfolio/route.ts",
  "app/api/performance/route.ts",
  "app/api/scanner/route.ts",
  "app/api/regime/route.ts",
  "app/api/gex/route.ts",
  "app/api/cash-flows/route.ts",
  "app/api/service-health/route.ts",
];

// Client-side fetch sites that hit a disk-backed dynamic route. Each fetch
// MUST request a fresh response with `cache: "no-store"` so the browser/
// Next-data layers never serve a stale snapshot. Defense in depth alongside
// the route-level dynamic export.
//
// `useSyncHook.ts` is the shared GET path for useVcg, useRegime, useBlotter,
// useFlowAnalysis, useGex, usePerformance, useScanner — patching it once
// covers all seven downstream hooks.
const NO_STORE_HOOKS = [
  "lib/useMenthorqCta.ts",
  "lib/useSyncHook.ts",
  "lib/useJournal.ts",
  "lib/usePortfolio.ts",
  "lib/useDiscover.ts",
  "lib/useOrders.ts",
  "lib/useCashFlows.ts",
  "lib/useServiceHealth.ts",
];

describe("API route handlers — must export dynamic = 'force-dynamic'", () => {
  it.each(DYNAMIC_ROUTES)("%s opts out of static caching", async (route) => {
    const src = await readFile(join(REPO_ROOT, route), "utf8");
    expect(src).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });
});

describe("client hooks/components — every fetch must use cache: 'no-store'", () => {
  it.each(NO_STORE_HOOKS)("%s requests fresh responses", async (hook) => {
    const src = await readFile(join(REPO_ROOT, hook), "utf8");

    // Find every fetch(...) call. useSyncHook fetches a parameterised URL
    // (`fetch(endpoint, ...)`), the others fetch literal /api/ strings —
    // either way the same cache-policy rule applies.
    const fetchPositions = [...src.matchAll(/\bfetch\s*\(/g)];
    expect(fetchPositions.length).toBeGreaterThan(0);

    for (const match of fetchPositions) {
      const start = match.index!;
      // Scan up to the matching closing paren or 600 chars, whichever is sooner.
      const window = src.slice(start, start + 600);
      expect(window).toMatch(/cache\s*:\s*["']no-store["']/);
    }
  });
});

// Phase 1 of the Turso source-of-truth migration: routes that already
// dual-write to a Turso table MUST query the DB before falling back to the
// disk JSON cache. This test prevents regressions where someone refactors
// the route and accidentally drops the DB read path.
//
// Each route has its own `readXFromDb` helper that returns the parsed
// payload or null. The pattern is:
//   const fromDb = await readXFromDb();
//   if (fromDb) return ...;
//   // fall through to disk
// Routes that already dual-write to a Turso table (Phase 1 of the
// source-of-truth migration). Each must invoke a DB read function from
// inside its GET handler — the DB-first contract.
const DB_FIRST_ROUTES: { path: string; dbHelperPattern: RegExp }[] = [
  { path: "app/api/vcg/route.ts", dbHelperPattern: /readCachedVcgFromDb\s*\(/ },
  { path: "app/api/gex/route.ts", dbHelperPattern: /readCachedGexFromDb\s*\(/ },
  { path: "app/api/discover/route.ts", dbHelperPattern: /readDiscoverFromDb\s*\(/ },
  { path: "app/api/menthorq/cta/route.ts", dbHelperPattern: /readLatestCtaFromDb\s*\(/ },
  { path: "app/api/regime/route.ts", dbHelperPattern: /readLatestDbCri\s*\(/ },
  { path: "app/api/scanner/route.ts", dbHelperPattern: /readScannerFromDb\s*\(/ },
  { path: "app/api/flow-analysis/route.ts", dbHelperPattern: /readFlowAnalysisFromDb\s*\(/ },
  { path: "app/api/performance/route.ts", dbHelperPattern: /readPerformanceFromDb\s*\(/ },
  { path: "app/api/portfolio/route.ts", dbHelperPattern: /readPortfolioFromDb\s*\(/ },
  // cash-flows reads via FastAPI proxy which queries Turso server-side
  { path: "app/api/cash-flows/route.ts", dbHelperPattern: /radonFetch\s*\(\s*[`"']\/cash-flows/ },
  { path: "app/api/service-health/route.ts", dbHelperPattern: /\bgetDb\s*\(/ },
];

describe("Turso source-of-truth — routes must invoke a DB read", () => {
  it.each(DB_FIRST_ROUTES)(
    "$path imports + invokes its DB read helper",
    async ({ path, dbHelperPattern }) => {
      const src = await readFile(join(REPO_ROOT, path), "utf8");
      // Strip imports — we want the helper to be CALLED, not just imported.
      const withoutImports = src.replace(/^import .+?(?:;|$)/gms, "");
      expect(withoutImports).toMatch(dbHelperPattern);
    },
  );
});
