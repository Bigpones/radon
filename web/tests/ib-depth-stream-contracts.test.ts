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
    // Per-level base shape — fields populated per instrument kind below.
    expect(source).toContain("const level = { price: lvl.price, size: lvl.size, marketMaker, exchange };");
  });

  it("labels option venue code into BOTH marketMaker and exchange; equities keep marketMaker null", () => {
    // The web montage reads `level.marketMaker ?? level.exchange`. Options have
    // no MPID — the venue code IS the marketMaker — so populate both fields so
    // the Market column labels consistently with stocks.
    const ladder = source.match(/function serializeLadder\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(ladder).toContain('const isOption = kind === "option";');
    expect(ladder).toContain("const venue = isFutures ? null : (lvl.marketMaker || null);");
    expect(ladder).toContain("const marketMaker = isOption ? venue : null;");
    expect(ladder).toContain("const exchange = venue;");
    // serializeLadder now receives the instrument kind + side for option NBBO.
    expect(source).toContain('serializeLadder(state.ladders.bid, state.isFutures, state.kind, "bid")');
    expect(source).toContain('serializeLadder(state.ladders.ask, state.isFutures, state.kind, "ask")');
  });

  it("flags option NBBO rows: bid=max price, ask=min price, ties all flagged, options only", () => {
    const ladder = source.match(/function serializeLadder\([\s\S]*?\n\}/)?.[0] ?? "";
    // nbbo flag emitted ONLY for options (lean payload) and only when a price matches the inside.
    expect(ladder).toContain("if (isOption) level.nbbo = nbboPrice != null && lvl.price === nbboPrice;");
    const nbboFn = source.match(/function nbboPriceForOptionLadder\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(nbboFn).toContain("if (!isOption || rows.length === 0) return null;");
    // Bid inside = highest price; ask inside = lowest price. Ties: every row at
    // that price satisfies lvl.price === nbboPrice, so ALL are flagged.
    expect(nbboFn).toContain('return side === "bid" ? Math.max(...prices) : Math.min(...prices);');
  });

  it("attaches a cross-venue NBBO summary to option DepthBooks only", () => {
    expect(source).toContain('if (state.kind === "option") book.nbbo = summarizeOptionNbbo(bid, ask);');
    const summary = source.match(/function summarizeOptionNbbo\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(summary).toContain("const bestBid = bid.length ? Math.max(...bid.map((l) => l.price)) : null;");
    expect(summary).toContain("const bestAsk = ask.length ? Math.min(...ask.map((l) => l.price)) : null;");
    expect(summary).toContain("const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;");
  });

  it("keeps the honest OPRA BBO feed label (top-of-book per venue, not stacked depth)", () => {
    const label = source.match(/function depthFeedLabel\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(label).toContain('if (kind === "option") return "OPRA BBO";');
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
    expect(map).toContain('VIX: "CFE"');
    // VIX futures resolve under IB contract symbol "VIX" (not CBOE's "VX" product code);
    // Future(symbol:"VX") returns IB Error 200. The depth futures set must carry "VIX".
    expect(source).toContain('"VIX"]'); // DEPTH_FUTURES_SYMBOLS ends with "VIX"
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
