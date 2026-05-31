import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const webDir = resolve(__dirname, "..");
const projectRoot = resolve(webDir, "..");
const source = readFileSync(resolve(projectRoot, "scripts", "ib_realtime_server.js"), "utf8");

describe("ib_realtime_server.js exposes the flag-gated L2 depth channel", () => {
  it("gates the entire depth feature behind RADON_DEPTH_ENABLED", () => {
    expect(source).toContain("process.env.RADON_DEPTH_ENABLED");
    expect(source).toContain("const DEPTH_ENABLED");
    // Request side must be guarded: no tickets / no realtime flip when off.
    expect(source).toContain("if (!DEPTH_ENABLED || !ibConnected) return;");
    expect(source).toContain("if (DEPTH_ENABLED) restoreDepthSubscriptions();");
  });

  it("opens and cancels reqMktDepth tickets within an explicit budget, passing isSmartDepth both ways", () => {
    // @stoqey/ib: reqMktDepth(reqId, contract, numRows, isSmartDepth) and
    // cancelMktDepth(reqId, isSmartDepth) — true equity/option, false futures.
    expect(source).toContain("ib.reqMktDepth(depthTickerId, contract, numRows, isSmartDepth)");
    expect(source).toContain("const isSmartDepth = !isFutures;");
    expect(source).toContain("ib.cancelMktDepth(state.depthTickerId, !state.isFutures)");
    expect(source).toContain("const MAX_CONCURRENT_DEPTH = 3");
    expect(source).toContain("function evictOldestDepth");
  });

  it("handles both the futures and equity/SMART depth events via the EventName enum", () => {
    const depthHandlers = source.match(/if \(DEPTH_ENABLED\) \{[\s\S]*?updateMktDepthL2[\s\S]*?\}\);\s*\}/)?.[0] ?? "";
    expect(depthHandlers).toContain("ib.on(EventName.updateMktDepth, (id, position, operation, side, price, size)");
    // L2 gains a trailing isSmartDepth arg under @stoqey/ib; we accept-and-ignore it.
    expect(depthHandlers).toContain("ib.on(EventName.updateMktDepthL2, (id, position, marketMaker, operation, side, price, size, _isSmartDepth)");
  });

  it("broadcasts a depth-batch reusing the 100ms flush and cleans buffers per client", () => {
    expect(source).toContain('type: "depth-batch"');
    expect(source).toContain("function flushDepthBatches");
    expect(source).toContain("if (DEPTH_ENABLED) flushDepthBatches();");
    expect(source).toContain("clientDepthBuffers.delete(client)");
  });

  it("routes the single-symbol subscribe-depth / unsubscribe-depth actions", () => {
    expect(source).toContain('depthAction === "subscribe-depth"');
    expect(source).toContain('depthAction === "unsubscribe-depth"');
    expect(source).toContain("function resolveDepthSubject");
  });

  it("treats no-entitlement (10089) as soft — cancel the ticket, emit depth-unavailable, never latch a fault", () => {
    expect(source).toContain("code === 10089");
    expect(source).toContain("/depth.*not (allowed|eligible)/i");
    expect(source).toContain('type: "depth-unavailable"');
    expect(source).toContain('emitDepthUnavailable(depthSymbol, "no-entitlement", 10089)');
  });

  it("emits a DepthBook matching the web type shape", () => {
    const book = source.match(/const book = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(book).toContain("kind: state.kind");
    expect(book).toContain("isSmartDepth: !state.isFutures");
    expect(book).toContain("entitled: true");
    expect(book).toContain("feed: depthFeedLabel");
    // Per-level: equity exchange = marketMaker code, marketMaker null; futures both null.
    expect(source).toContain("return { price: lvl.price, size: lvl.size, marketMaker: null, exchange };");
  });
});
