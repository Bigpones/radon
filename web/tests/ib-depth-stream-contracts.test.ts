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
    expect(source).toContain("flushDepthBatches();");
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

  it("resolves a futures root to a qualified front-month contract via reqContractDetails", () => {
    // @stoqey/ib has no ContFuture auto-resolution — depth on a bare root needs
    // a qualified contract (conId), resolved via reqContractDetails on the
    // native exchange, picking the nearest non-expired expiry.
    expect(source).toContain("function resolveFuturesFrontMonth");
    expect(source).toContain("ib.reqContractDetails(reqId, probe)");
    expect(source).toContain("includeExpired: false");
    expect(source).toContain("secType: SecType.FUT");
    expect(source).toContain("function pickFrontMonth");
    expect(source).toContain("ib.on(EventName.contractDetails");
    expect(source).toContain("ib.on(EventName.contractDetailsEnd");
    // Cache the resolved contract per root so we don't re-resolve every subscribe.
    expect(source).toContain("resolvedFuturesContracts");
  });

  it("maps each futures root to its native depth exchange", () => {
    const map = source.match(/const FUTURES_ROOT_EXCHANGES = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(map).toContain('ES: "CME"');
    expect(map).toContain('NQ: "CME"');
    expect(map).toContain('CL: "NYMEX"');
    expect(map).toContain('NG: "NYMEX"');
    expect(map).toContain('GC: "COMEX"');
    expect(map).toContain('SI: "COMEX"');
    expect(map).toContain('HG: "COMEX"');
    expect(map).toContain('ZB: "CBOT"');
    expect(map).toContain('ZN: "CBOT"');
    expect(map).toContain('VX: "CFE"');
  });

  it("bounds the futures resolution await and degrades to futures-no-depth without hanging", () => {
    expect(source).toContain("const FUTURES_RESOLVE_TIMEOUT_MS");
    expect(source).toContain("setTimeout(() => {");
    // The subscribe path awaits resolution; null → emit futures-no-depth, bail.
    expect(source).toContain("const resolved = await resolveFuturesFrontMonth(subject.root)");
    expect(source).toContain('emitDepthUnavailable(subject.key, "futures-no-depth")');
  });

  it("labels futures depth feed with the resolved venue (CME DEPTH)", () => {
    const label = source.match(/function depthFeedLabel\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(label).toContain("`${exchange} DEPTH`");
    expect(label).toContain('"NATIVE DEPTH"');
  });

  it("opens a Time & Sales tape on the focused depth symbol via reqTickByTickData(AllLast)", () => {
    // @stoqey/ib: reqTickByTickData(reqId, contract, tickType, numberOfTicks, ignoreSize)
    // and cancelTickByTickData(reqId). AllLast is realtime-only (no backfill).
    expect(source).toContain("ib.reqTickByTickData(tapeTickerId, contract, TickByTickDataType.AllLast, 0, false)");
    expect(source).toContain("ib.cancelTickByTickData(state.tapeTickerId)");
    expect(source).toContain("function startTapeSubscription");
    expect(source).toContain("function stopTapeSubscription");
    // Tape rides the focused symbol — started alongside depth, stopped with it.
    expect(source).toContain("startTapeSubscription(subject.key, contract)");
    expect(source).toContain("stopTapeSubscription(key)");
    expect(source).toContain("import { IBApi, EventName, SecType, OptionType, TickByTickDataType }");
  });

  it("consumes the tickByTickAllLast event with the @stoqey arity and rings the buffer", () => {
    // (reqId, tickType, time, price, size, tickAttribLast, exchange, specialConditions)
    expect(source).toContain("ib.on(EventName.tickByTickAllLast, (reqId, _tickType, time, price, size, _tickAttribLast, exchange, _specialConditions)");
    expect(source).toContain("const TAPE_RING_SIZE = 50");
    expect(source).toContain("function applyTrade");
    // Trade shape must match web/lib Trade = {price, size, exchange, time}.
    expect(source).toContain("state.trades.push({ price, size, exchange: exchange || null, time })");
  });

  it("broadcasts a tape-batch reusing the 100ms flush and cleans tape buffers per client", () => {
    expect(source).toContain('type: "tape-batch"');
    expect(source).toContain("function flushTapeBatches");
    expect(source).toContain("flushTapeBatches();");
    expect(source).toContain("clientTapeBuffers.delete(client)");
  });
});
