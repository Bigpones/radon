#!/usr/bin/env node

/**
 * Interactive Brokers Real-Time Price Server (Node.js)
 *
 * This is a direct replacement for the Python websocket server.
 */

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });
// .env.ib-mode (managed by scripts/ib mode) overlays after .env so its
// IB_GATEWAY_MODE/HOST values win — single switch, no .env rewriting.
dotenv.config({ path: resolve(__dirname, "../.env.ib-mode"), override: true });

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
import { IBApi, EventName, SecType, OptionType, TickByTickDataType } from "@stoqey/ib";
import { classifyIBConnectionError } from "./ib_connection_status.js";
import {
  createPriceData,
  createFundamentalsData,
  parseFundamentalRatios,
  updatePriceFromTickPrice,
  updatePriceFromTickSize,
} from "./ib_tick_handler.js";
import { LRUCache } from "./lib/lru-cache.js";
import { RateLimiter } from "./lib/rate-limiter.js";

const DEFAULT_WS_PORT = 8765;
const DEFAULT_IB_HOST = process.env.IB_GATEWAY_HOST || "127.0.0.1";
const DEFAULT_IB_PORT = parseInt(process.env.IB_GATEWAY_PORT || "4001", 10);
const RECONNECT_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 5000;

/* ─── Keep-Alive Ping/Pong ─────────────────────────────────────────────── */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 65_000; // 30s * 2 + 5s grace

function parseArgs(argv) {
  const args = {
    port: DEFAULT_WS_PORT,
    ibHost: DEFAULT_IB_HOST,
    ibPort: DEFAULT_IB_PORT,
    ibClientId: 10,  // RELAY_ID_RANGE start (10-19)
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(value)) {
        args.port = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--ib-host") {
      args.ibHost = argv[i + 1] ?? DEFAULT_IB_HOST;
      i += 1;
      continue;
    }
    if (arg === "--ib-port") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(value)) {
        args.ibPort = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--client-id") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(value)) {
        args.ibClientId = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      args.verbose = true;
    }
  }

  return args;
}

function normalizeSymbols(raw) {
  return raw
    .map((symbol) => String(symbol).trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
}

/** Build composite key for an option contract: SYMBOL_YYYYMMDD_STRIKE_RIGHT */
function optionKey(c) {
  return `${c.symbol}_${c.expiry}_${c.strike}_${c.right}`;
}

/**
 * Validate and normalize a raw contracts array from client messages.
 * Each contract must have symbol (string), expiry (8-digit string),
 * strike (positive number), and right ("C" or "P").
 */
function normalizeContracts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (typeof c !== "object" || c === null) return null;
      const symbol = typeof c.symbol === "string" ? c.symbol.trim().toUpperCase() : null;
      const expiry = typeof c.expiry === "string" ? c.expiry.trim() : null;
      const strike = typeof c.strike === "number" && Number.isFinite(c.strike) && c.strike > 0 ? c.strike : null;
      const right = c.right === "C" || c.right === "P" ? c.right : null;
      if (!symbol || !expiry || expiry.length !== 8 || !strike || !right) return null;
      return { symbol, expiry, strike, right };
    })
    .filter(Boolean);
}

/**
 * Validate and normalize index contract descriptors from client messages.
 * Each must have symbol (string) and exchange (string, e.g. "CBOE").
 */
function normalizeIndexes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (typeof c !== "object" || c === null) return null;
      const symbol = typeof c.symbol === "string" ? c.symbol.trim().toUpperCase() : null;
      const exchange = typeof c.exchange === "string" ? c.exchange.trim().toUpperCase() : null;
      if (!symbol || !exchange) return null;
      return { symbol, exchange };
    })
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function parseActionMessage(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const payload = raw;
  if (typeof payload.action !== "string") {
    return null;
  }

  const action = payload.action.trim().toLowerCase();
  if (!action) {
    return null;
  }

  const symbols = Array.isArray(payload.symbols) ? normalizeSymbols(payload.symbols) : [];
  const contracts = Array.isArray(payload.contracts) ? normalizeContracts(payload.contracts) : [];
  const indexes = Array.isArray(payload.indexes) ? normalizeIndexes(payload.indexes) : [];
  return { action, symbols, contracts, indexes };
}

const cli = parseArgs(process.argv.slice(2));
const WS_HOST = "0.0.0.0";
const wsUrl = `ws://${WS_HOST}:${cli.port}`;

function verbose(...args) {
  if (cli.verbose) console.log(`\x1b[90m[verbose]\x1b[0m`, ...args);
}

const IB_CLIENT_ID_POOL = [cli.ibClientId, cli.ibClientId + 1, cli.ibClientId + 2];
let activeClientIdIndex = 0;

let ib = createIBClient(IB_CLIENT_ID_POOL[0]);

function createIBClient(clientId) {
  return new IBApi({
    host: cli.ibHost,
    port: cli.ibPort,
    clientId,
  });
}

/* ─── Contract builders ────────────────────────────────────────────────────
 * @stoqey/ib has no ib.contract.* factory helpers — contracts are plain
 * objects. These mirror the field shapes the old `ib` lib produced
 * (expiry → lastTradeDateOrContractMonth; right → OptionType), so every
 * downstream consumer (ensureSymbolState, optionKey, etc.) is unaffected.
 */
function stockContract(symbol, exchange = "SMART", currency = "USD") {
  return { symbol, secType: SecType.STK, exchange, currency };
}

function optionContract(symbol, expiry, strike, right, exchange = "SMART", currency = "USD") {
  return {
    symbol,
    secType: SecType.OPT,
    exchange,
    currency,
    lastTradeDateOrContractMonth: expiry,
    strike,
    right: right === "C" ? OptionType.Call : OptionType.Put,
    multiplier: "100",
  };
}

function indexContract(symbol, currency = "USD", exchange = "CBOE") {
  return { symbol, secType: SecType.IND, exchange, currency };
}

function futureContract(symbol, expiry, currency = "USD", exchange = "ONE") {
  return { symbol, secType: SecType.FUT, currency, exchange, lastTradeDateOrContractMonth: expiry };
}

async function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();

    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      console.error(`Failed to probe websocket port ${host}:${port}:`, error?.message ?? String(error));
      resolve(false);
    });

    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });

    probe.listen({ host, port, exclusive: true });
  });
}

if (!(await isPortAvailable(WS_HOST, cli.port))) {
  console.log(`WebSocket port already in use at ${wsUrl}; assuming an existing IB realtime server and skipping duplicate startup.`);
  console.log(`IB target ${cli.ibHost}:${cli.ibPort}`);
  process.exit(0);
}

// Create HTTP server for WebSocket upgrade with ticket validation
const TICKET_VALIDATE_URL = process.env.TICKET_VALIDATE_URL || "http://127.0.0.1:8321/ws-ticket/validate";

const httpServer = http.createServer((_req, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("WebSocket upgrade required");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", async (req, socket, head) => {
  // Skip ticket validation if Clerk is not configured (local dev)
  // or if the connection is from localhost (server-to-server / local browser)
  const remoteAddr = socket.remoteAddress || "";
  const isLocalhost = !process.env.CLERK_JWKS_URL ||
    remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
  if (isLocalhost) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const ticket = url.searchParams.get("ticket");

  if (!ticket) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  try {
    const res = await fetch(TICKET_VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });

    if (!res.ok) {
      verbose("WS ticket validation failed: " + res.status);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (err) {
    verbose("WS ticket validation error: " + (err instanceof Error ? err.message : err));
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
  }
});

httpServer.listen(cli.port, WS_HOST);

const clients = new Set();
const symbolSubscribers = new Map();
const clientSymbols = new Map();
const symbolStates = new Map();
const requestIdToSymbol = new Map();
const snapshotRequests = new Map();
const fundamentalsStore = new LRUCache(500); // symbol → FundamentalsData (LRU-capped)

/* ─── L2 Depth Channel (flag-gated) ────────────────────────────────────────
 * Entire feature is gated on RADON_DEPTH_ENABLED. When falsy, NO depth
 * handlers are registered, NO reqMktDepth tickets are opened, and the relay
 * behaves byte-for-byte as before. Default OFF.
 *
 * Depth budget: IB allows ~3 concurrent reqMktDepth tickets on a baseline
 * account, so we cap concurrency and LRU-recycle the oldest non-focused
 * ladder before opening a new one.
 *
 * NOTE on the @stoqey/ib surface: reqMktDepth(reqId, contract, numRows,
 * isSmartDepth) and cancelMktDepth(reqId, isSmartDepth) BOTH carry the
 * smart-depth flag — true for equity/option (SMART aggregation), false for
 * futures (single-venue native depth). The DepthBook also emits isSmartDepth
 * (= !isFutures) to match the web type. updateMktDepth emits
 * (id, position, operation, side, price, size) with NO marketMaker (futures /
 * single-venue); updateMktDepthL2 emits
 * (id, position, marketMaker, operation, side, price, size, isSmartDepth)
 * (equity/SMART) — the trailing isSmartDepth arg is @stoqey-specific.
 *
 * REALTIME TRADEOFF (Phase 1): depth + tick-by-tick require realtime market
 * data (type 1), but the main relay connection requests delayed-frozen
 * (type 4) at the ib "connected" handler BY DESIGN so closed-market L1
 * queries return last known prices. reqMarketDataType is per-connection /
 * global, so when depth is enabled we flip the shared connection to type 1.
 * This makes the watchlist L1 realtime too while depth is on. The production
 * follow-up is a DEDICATED realtime depth IB client (its own clientId in the
 * 10-19 relay range) that owns all reqMktDepth tickets so the watchlist L1
 * can stay delayed-frozen. That second connection is intentionally NOT built
 * in this phase to keep the change surgical.
 */
const DEPTH_ENABLED = Boolean(process.env.RADON_DEPTH_ENABLED && process.env.RADON_DEPTH_ENABLED !== "0" && process.env.RADON_DEPTH_ENABLED !== "false");
const MAX_CONCURRENT_DEPTH = 3;
const DEPTH_NUM_ROWS_EQUITY = 5;
const DEPTH_NUM_ROWS_FUTURES = 10;
// Symbols treated as futures for depth purposes (single-venue native depth).
const DEPTH_FUTURES_SYMBOLS = new Set(["ES", "NQ", "RTY", "YM", "CL", "NG", "GC", "SI", "HG", "ZB", "ZN", "ZC", "ZS", "VX"]);
// Futures root → native exchange. Front-month depth requires a qualified
// contract (conId), which we resolve via reqContractDetails on this exchange.
const FUTURES_ROOT_EXCHANGES = {
  ES: "CME", NQ: "CME", RTY: "CME", YM: "CME",
  CL: "NYMEX", NG: "NYMEX",
  GC: "COMEX", SI: "COMEX", HG: "COMEX",
  ZB: "CBOT", ZN: "CBOT", ZC: "CBOT", ZS: "CBOT",
  VX: "CFE",
};
function futuresExchangeForRoot(root) {
  return FUTURES_ROOT_EXCHANGES[root] || "CME";
}
const FUTURES_RESOLVE_TIMEOUT_MS = 6000;
// key → { depthTickerId, contract, kind, isFutures, ladders:{bid:Map,ask:Map}, focusedAt }
const symbolDepthStates = new Map();
const depthRequestIdToSymbol = new Map(); // depthTickerId → key
// Per-client depth buffer: Map<client, Map<symbol, DepthBook>>
const clientDepthBuffers = new Map();
const depthSubscribers = new Map(); // key → Set<client>
// Resolved front-month futures contracts, cached per root so we don't
// re-resolve on every subscribe. root → qualified Contract (with conId).
const resolvedFuturesContracts = new Map();
// In-flight reqContractDetails resolutions: reqId → { root, resolve, timer, candidates }
const futuresResolveRequests = new Map();

/* ─── Time & Sales tape (flag-gated, rides the focused depth symbol) ─────────
 * On subscribe-depth we also open a reqTickByTickData(AllLast) stream for the
 * same contract; on unsubscribe-depth we cancel it. Trades land in a bounded
 * per-symbol ring buffer and broadcast as {type:"tape-batch"} on the same
 * 100ms flush as depth. tick-by-tick shares the depth line allowance, so the
 * existing focused-symbol-only model + 3-ticket cap keep us inside budget.
 *
 * @stoqey/ib surface (verified against dist/api/api.d.ts):
 *   reqTickByTickData(reqId, contract, tickType, numberOfTicks, ignoreSize)
 *   cancelTickByTickData(reqId)
 *   EventName.tickByTickAllLast: (reqId, tickType, time, price, size,
 *     tickAttribLast, exchange, specialConditions)
 * AllLast is realtime-only (no historical backfill) — start empty, fill forward.
 *
 * ORDERING CONVENTION: the ring buffer (and the emitted Trade[]) is
 * NEWEST-LAST — index 0 is the oldest retained print, the final element is the
 * most recent. classifyTicks consumes an ordered array (prior-tick test) and
 * reads forward, so chronological/newest-last matches the prior-tick semantics.
 */
const TAPE_RING_SIZE = 50;
const tapeRequestIdToSymbol = new Map(); // tapeTickerId → key
// key → { tapeTickerId, trades: Trade[] (newest-last, bounded TAPE_RING_SIZE) }
const symbolTapeStates = new Map();
const clientTapeBuffers = new Map(); // client → Map<symbol, Trade[]>

/* ─── Symbol Search Cache ─────────────────────────────────────────────── */
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map(); // pattern → { results, ts }
const searchRequestClients = new Map(); // reqId → { client, pattern }

/* ─── Option close price cache ─────────────────────────────────────────────
 * IB sends previous-close for option contracts only during market hours.
 * After hours, delayed-frozen data omits close. We persist close prices to
 * disk so they survive server restarts and are available after hours.
 * File: data/option_close_cache.json  { "AAOI_20260320_105_C": 16.5, ... }
 */
const CLOSE_CACHE_PATH = path.resolve(process.cwd(), "data", "option_close_cache.json");
const optionCloseCache = new Map(); // symbol → close price

function loadCloseCache() {
  try {
    if (fs.existsSync(CLOSE_CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CLOSE_CACHE_PATH, "utf8"));
      for (const [key, val] of Object.entries(raw)) {
        if (typeof val === "number" && val > 0) optionCloseCache.set(key, val);
      }
      console.log(`Loaded ${optionCloseCache.size} cached option close prices`);
    }
  } catch (err) {
    console.warn("Failed to load option close cache:", err.message);
  }
}

let closeCacheDirty = false;
let closeCacheTimer = null;

function persistCloseCache() {
  if (!closeCacheDirty) return;
  closeCacheDirty = false;
  try {
    const dir = path.dirname(CLOSE_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(optionCloseCache);
    fs.writeFileSync(CLOSE_CACHE_PATH, JSON.stringify(obj), "utf8");
    verbose(`Persisted ${optionCloseCache.size} option close prices`);
  } catch (err) {
    console.warn("Failed to persist option close cache:", err.message);
  }
}

function scheduleCloseCachePersist() {
  closeCacheDirty = true;
  if (closeCacheTimer) return;
  closeCacheTimer = setTimeout(() => {
    closeCacheTimer = null;
    persistCloseCache();
  }, 5000); // batch writes every 5s
}

function updateOptionCloseCache(symbol, closePrice) {
  if (!symbol.includes("_") || closePrice == null || closePrice <= 0) return;
  const existing = optionCloseCache.get(symbol);
  if (existing === closePrice) return;
  optionCloseCache.set(symbol, closePrice);
  scheduleCloseCachePersist();
}

function applyCachedClose(data) {
  if (data.close != null && data.close > 0) return; // already has close
  if (!data.symbol.includes("_")) return; // only for options
  const cached = optionCloseCache.get(data.symbol);
  if (cached != null) {
    data.close = cached;
  }
}

loadCloseCache();

/* ─── Keep-Alive State ──────────────────────────────────────────────────── */
const clientLastPong = new Map(); // client → timestamp (ms)
let pingIntervalTimer = null;

/* ─── Snapshot Rate Limiter ──────────────────────────────────────────────
 * IB allows ~100 snapshot requests/sec. We cap at 50 to leave headroom. */
const snapshotLimiter = new RateLimiter(50);

let ibConnected = false;
let shuttingDown = false;
let reconnectTimer = null;
let nextRequestId = 1;
let statusBroadcastTick = null;
let ibConnectionIssue = null;

/* ─── Stale Data Detection ─────────────────────────────────────────────────
 * IB Gateway can enter a state where the TCP connection is alive but the
 * data plane stops delivering ticks. Detect this by tracking the last tick
 * timestamp: if we have active subscriptions during market hours but haven't
 * received a tick in STALE_DATA_THRESHOLD_MS, restart IB Gateway.
 */
const STALE_DATA_THRESHOLD_MS = 45_000; // 45s without a tick during market hours
const STALE_CHECK_INTERVAL_MS = 30_000; // Check every 30s
let lastTickTimestamp = Date.now();
let staleCheckTimer = null;
let ibGatewayRestarting = false;

function isUSMarketHours() {
  // Convert to ET and check if within 9:30-16:00 Mon-Fri
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const timeMinutes = hours * 60 + minutes;
  return timeMinutes >= 9 * 60 + 30 && timeMinutes <= 16 * 60;
}

const GATEWAY_MODE = process.env.IB_GATEWAY_MODE || "docker";

async function restartIBGateway() {
  if (ibGatewayRestarting) return;
  ibGatewayRestarting = true;
  console.log("\x1b[31m[stale-data] No ticks received during market hours — handling stale data\x1b[0m");

  if (GATEWAY_MODE === "cloud" || GATEWAY_MODE === "docker") {
    // Cloud/Docker — no local restart capability. Just reconnect the IB socket.
    console.log(`[stale-data] ${GATEWAY_MODE} mode — disconnecting and scheduling reconnect`);
  } else {
    // Local launchd mode — do NOT restart IBC from the relay.
    // Repeated local restarts thrash the auth session and can trigger more 2FA prompts.
    console.log("[stale-data] launchd mode — reconnecting IB socket only; manual IBC restart required if Gateway stays down");
  }

  try { ib.disconnect(); } catch { /* ignore */ }
  scheduleReconnect();

  // Allow another attempt after 120s cooldown
  setTimeout(() => { ibGatewayRestarting = false; }, 120_000);
}

/* ─── Batched Price Relay ──────────────────────────────────────────────────
 * Buffers price ticks per symbol (last-write-wins) and flushes to each
 * subscribed client as a single {"type": "batch", "updates": {...}} message
 * every BATCH_INTERVAL_MS. Reduces React re-renders from N per-tick updates
 * to 1 batched update per interval.
 */
const BATCH_INTERVAL_MS = 100;

// Per-client batch buffer: Map<client, Map<symbol, PriceData>>
const clientBatchBuffers = new Map();
const BATCH_THRESHOLD = 50; // Adaptive: flush early when any client has this many buffered symbols
let lastFlushTime = 0;

let batchFlushTimer = null;

function bufferPriceForClient(client, symbol, data) {
  let buf = clientBatchBuffers.get(client);
  if (!buf) {
    buf = new Map();
    clientBatchBuffers.set(client, buf);
  }
  buf.set(symbol, data);

  // Adaptive flush: trigger early when buffer exceeds threshold and min interval elapsed
  if (buf.size >= BATCH_THRESHOLD && Date.now() - lastFlushTime >= BATCH_INTERVAL_MS) {
    flushBatches();
  }
}

function flushBatches() {
  lastFlushTime = Date.now();
  for (const [client, buf] of clientBatchBuffers) {
    if (buf.size === 0) continue;
    const updates = Object.fromEntries(buf);
    buf.clear();
    sendMessage(client, { type: "batch", updates });
  }
}

function bufferDepthForClient(client, symbol, book) {
  let buf = clientDepthBuffers.get(client);
  if (!buf) {
    buf = new Map();
    clientDepthBuffers.set(client, buf);
  }
  buf.set(symbol, book);
}

function flushDepthBatches() {
  for (const [client, buf] of clientDepthBuffers) {
    if (buf.size === 0) continue;
    const updates = Object.fromEntries(buf);
    buf.clear();
    sendMessage(client, { type: "depth-batch", updates });
  }
}

function bufferTapeForClient(client, symbol, trades) {
  let buf = clientTapeBuffers.get(client);
  if (!buf) {
    buf = new Map();
    clientTapeBuffers.set(client, buf);
  }
  buf.set(symbol, trades);
}

function flushTapeBatches() {
  for (const [client, buf] of clientTapeBuffers) {
    if (buf.size === 0) continue;
    const updates = Object.fromEntries(buf);
    buf.clear();
    sendMessage(client, { type: "tape-batch", updates });
  }
}

function startBatchFlush() {
  if (batchFlushTimer) return;
  batchFlushTimer = setInterval(() => {
    flushBatches();
    if (DEPTH_ENABLED) {
      flushDepthBatches();
      flushTapeBatches();
    }
  }, BATCH_INTERVAL_MS);
}

function stopBatchFlush() {
  if (batchFlushTimer) {
    clearInterval(batchFlushTimer);
    batchFlushTimer = null;
  }
}

function removeBatchBuffer(client) {
  clientBatchBuffers.delete(client);
  clientDepthBuffers.delete(client);
  clientTapeBuffers.delete(client);
}

function sendMessage(client, payload) {
  try {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  } catch {
    // Ignore send failures.
  }
}

function sendToSymbolSubscribers(symbol, payload) {
  const subscribers = symbolSubscribers.get(symbol);
  if (!subscribers || subscribers.size === 0) return;
  for (const client of subscribers) {
    sendMessage(client, payload);
  }
}

function sendStatus(client) {
  const subscriptions = Array.from(symbolSubscribers.keys()).filter((symbol) => symbolSubscribers.get(symbol)?.size);
  sendMessage(client, {
    type: "status",
    ib_connected: ibConnected,
    ib_issue: ibConnectionIssue?.code ?? null,
    ib_status_message: ibConnectionIssue?.operatorMessage ?? null,
    subscriptions,
  });
}

function broadcastStatus() {
  for (const client of clients) {
    sendStatus(client);
  }
}

function clearSnapshot(requestId) {
  const req = snapshotRequests.get(requestId);
  if (!req) return;
  clearTimeout(req.timer);
  snapshotRequests.delete(requestId);
  requestIdToSymbol.delete(requestId);
}

function completeSnapshot(symbol, requestId) {
  const req = snapshotRequests.get(requestId);
  if (!req) return;
  sendMessage(req.client, {
    type: "snapshot",
    symbol,
    data: req.data,
  });
  clearSnapshot(requestId);
  try {
    ib.cancelMktData(requestId);
  } catch {
    // Ignore cleanup failures.
  }
}

function ensureSymbolState(key, ibContract) {
  const existing = symbolStates.get(key);
  if (existing) {
    existing.contract = ibContract;
    return existing;
  }

  const state = {
    tickerId: null,
    contract: ibContract,
    data: createPriceData(key),
  };
  symbolStates.set(key, state);
  return state;
}

function startLiveSubscription(key, ibContract) {
  if (!ibConnected) return;

  const existing = ensureSymbolState(key, ibContract);
  const nextTickerId = nextRequestId += 1;
  const state = existing;

  if (state.tickerId != null) {
    try {
      ib.cancelMktData(state.tickerId);
    } catch {
      // Ignore.
    }
    requestIdToSymbol.delete(state.tickerId);
  }

  try {
    ib.reqMktData(nextTickerId, ibContract, "233,165", false, false);
    state.tickerId = nextTickerId;
    state.contract = ibContract;
    state.data.timestamp = nowIso();
    symbolStates.set(key, state);
    requestIdToSymbol.set(nextTickerId, key);

    // Request fundamentals data for stocks (one-shot, cached)
    requestFundamentals(key, ibContract);
  } catch (error) {
    console.error(`Failed to subscribe ${key}:`, error);
  }
}

function stopLiveSubscription(symbol) {
  const state = symbolStates.get(symbol);
  if (!state || state.tickerId == null) return;
  try {
    ib.cancelMktData(state.tickerId);
  } catch {
    // Ignore.
  }
  requestIdToSymbol.delete(state.tickerId);
  symbolStates.delete(symbol);
}

function cleanupSymbolStateForReconnect() {
  for (const state of symbolStates.values()) {
    if (state.tickerId != null) {
      try {
        ib.cancelMktData(state.tickerId);
      } catch {
        // Ignore.
      }
      requestIdToSymbol.delete(state.tickerId);
      state.tickerId = null;
    }
  }
}

/* ─── L2 Depth lifecycle + ladder maintenance ──────────────────────────────
 * All functions in this block are no-ops on the request side unless
 * DEPTH_ENABLED; callers also guard, but the cap/LRU logic lives here.
 */

function depthFeedLabel(kind, isFutures, exchange) {
  // Futures: native single-venue depth — label with the venue when known
  // (e.g. "CME DEPTH"), else generic "NATIVE DEPTH".
  if (isFutures) return exchange ? `${exchange} DEPTH` : "NATIVE DEPTH";
  if (kind === "option") return "OPRA BBO";
  return "SMART DEPTH";
}

function activeDepthCount() {
  let n = 0;
  for (const state of symbolDepthStates.values()) {
    if (state.depthTickerId != null) n += 1;
  }
  return n;
}

function emitDepthUnavailable(symbol, reason, code) {
  const subscribers = depthSubscribers.get(symbol);
  const payload = { type: "depth-unavailable", symbol, reason };
  if (code != null) payload.code = code;
  if (subscribers) {
    for (const client of subscribers) sendMessage(client, payload);
  }
}

function stopDepthSubscription(key, { keepState = false } = {}) {
  const state = symbolDepthStates.get(key);
  if (!state) return;
  if (state.depthTickerId != null) {
    try {
      ib.cancelMktDepth(state.depthTickerId, !state.isFutures);
    } catch {
      // Ignore.
    }
    depthRequestIdToSymbol.delete(state.depthTickerId);
    state.depthTickerId = null;
  }
  if (!keepState) symbolDepthStates.delete(key);
}

// Cancel the oldest non-focused depth ticket to stay within the budget.
function evictOldestDepth(exceptKey) {
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, state] of symbolDepthStates) {
    if (key === exceptKey || state.depthTickerId == null) continue;
    if (state.focusedAt < oldestAt) {
      oldestAt = state.focusedAt;
      oldestKey = key;
    }
  }
  if (oldestKey != null) {
    stopDepthSubscription(oldestKey);
    emitDepthUnavailable(oldestKey, "recycled");
  }
}

/* Resolve a futures root (e.g. "ES") to its qualified front-month contract.
 * @stoqey/ib has no ContFuture auto-resolution, so reqMktDepth on a bare root
 * fails — we need a conId. reqContractDetails on the native exchange returns
 * every listed expiry; we pick the NEAREST non-expired one. Cached per root.
 * Bounded await: resolves null on timeout/error so the caller never hangs. */
function resolveFuturesFrontMonth(root) {
  const cached = resolvedFuturesContracts.get(root);
  if (cached) return Promise.resolve(cached);
  if (!ibConnected) return Promise.resolve(null);

  const exchange = futuresExchangeForRoot(root);
  const probe = {
    symbol: root,
    secType: SecType.FUT,
    exchange,
    currency: "USD",
    includeExpired: false,
  };
  const reqId = nextRequestId += 1;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      futuresResolveRequests.delete(reqId);
      resolve(value);
    };

    const timer = setTimeout(() => {
      verbose(`futures resolve ${root} timed out`);
      finish(null);
    }, FUTURES_RESOLVE_TIMEOUT_MS);

    futuresResolveRequests.set(reqId, { root, finish, candidates: [] });

    try {
      ib.reqContractDetails(reqId, probe);
    } catch (error) {
      verbose(`reqContractDetails(${root}) failed: ${error}`);
      finish(null);
    }
  });
}

// Pick the nearest non-expired expiry from the collected contractDetails.
function pickFrontMonth(candidates) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const dated = candidates
    .map((c) => ({ contract: c, expiry: String(c.lastTradeDateOrContractMonth || "").slice(0, 8) }))
    .filter((e) => e.expiry.length === 8 && e.expiry >= today)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  return dated.length ? dated[0].contract : null;
}

function onContractDetails(reqId, contractDetails) {
  const req = futuresResolveRequests.get(reqId);
  if (!req || !contractDetails?.contract) return;
  req.candidates.push(contractDetails.contract);
}

function onContractDetailsEnd(reqId) {
  const req = futuresResolveRequests.get(reqId);
  if (!req) return;
  const front = pickFrontMonth(req.candidates);
  if (front) {
    resolvedFuturesContracts.set(req.root, front);
    verbose(`futures resolve ${req.root} → ${front.localSymbol || front.lastTradeDateOrContractMonth} (conId ${front.conId})`);
    req.finish(front);
  } else {
    verbose(`futures resolve ${req.root}: no non-expired expiry`);
    req.finish(null);
  }
}

/* ─── Time & Sales tape lifecycle ────────────────────────────────────────── */
function startTapeSubscription(key, contract) {
  if (!DEPTH_ENABLED || !ibConnected) return;
  let state = symbolTapeStates.get(key);
  if (!state) {
    state = { tapeTickerId: null, trades: [] };
    symbolTapeStates.set(key, state);
  }
  if (state.tapeTickerId != null) return; // already streaming

  const tapeTickerId = nextRequestId += 1;
  try {
    // AllLast = every last-trade print (incl. combos/odd-lots). numberOfTicks=0
    // → continuous stream; ignoreSize=false keeps trade sizes.
    ib.reqTickByTickData(tapeTickerId, contract, TickByTickDataType.AllLast, 0, false);
    state.tapeTickerId = tapeTickerId;
    tapeRequestIdToSymbol.set(tapeTickerId, key);
    verbose(`tape subscribe ${key} ticket=${tapeTickerId}`);
  } catch (error) {
    console.error(`Failed to subscribe tape ${key}:`, error);
  }
}

function stopTapeSubscription(key) {
  const state = symbolTapeStates.get(key);
  if (!state) return;
  if (state.tapeTickerId != null) {
    try {
      ib.cancelTickByTickData(state.tapeTickerId);
    } catch {
      // Ignore.
    }
    tapeRequestIdToSymbol.delete(state.tapeTickerId);
    state.tapeTickerId = null;
  }
  symbolTapeStates.delete(key);
}

// Append a print to the bounded ring (newest-last) and buffer for broadcast.
function applyTrade(key, price, size, exchange, time) {
  const state = symbolTapeStates.get(key);
  if (!state) return;
  state.trades.push({ price, size, exchange: exchange || null, time });
  if (state.trades.length > TAPE_RING_SIZE) {
    state.trades.splice(0, state.trades.length - TAPE_RING_SIZE);
  }
  const subscribers = depthSubscribers.get(key);
  if (!subscribers || subscribers.size === 0) return;
  const snapshot = state.trades.slice();
  for (const client of subscribers) {
    bufferTapeForClient(client, key, snapshot);
  }
}

function cleanupTapeForReconnect() {
  for (const [, state] of symbolTapeStates) {
    if (state.tapeTickerId != null) {
      try {
        ib.cancelTickByTickData(state.tapeTickerId);
      } catch {
        // Ignore.
      }
      tapeRequestIdToSymbol.delete(state.tapeTickerId);
      state.tapeTickerId = null;
    }
  }
}

function startDepthSubscription(key, contract, { kind, isFutures }) {
  if (!DEPTH_ENABLED || !ibConnected) return;

  let state = symbolDepthStates.get(key);
  if (!state) {
    state = { depthTickerId: null, contract, kind, isFutures, ladders: { bid: new Map(), ask: new Map() }, focusedAt: Date.now() };
    symbolDepthStates.set(key, state);
  } else {
    state.contract = contract;
    state.kind = kind;
    state.isFutures = isFutures;
    state.focusedAt = Date.now();
  }

  if (state.depthTickerId != null) return; // already streaming

  // Cap-check: cancel the oldest non-focused ticket before exceeding the budget.
  while (activeDepthCount() >= MAX_CONCURRENT_DEPTH) {
    const before = activeDepthCount();
    evictOldestDepth(key);
    if (activeDepthCount() >= before) break; // nothing evictable — avoid spin
  }

  const numRows = isFutures ? DEPTH_NUM_ROWS_FUTURES : DEPTH_NUM_ROWS_EQUITY;
  const depthTickerId = nextRequestId += 1;
  const isSmartDepth = !isFutures;
  try {
    // @stoqey/ib: reqMktDepth(reqId, contract, numRows, isSmartDepth). Smart
    // depth (true) for equity/option SMART aggregation, native single-venue
    // depth (false) for futures. The same isSmartDepth is required on cancel.
    ib.reqMktDepth(depthTickerId, contract, numRows, isSmartDepth);
    state.depthTickerId = depthTickerId;
    state.ladders.bid.clear();
    state.ladders.ask.clear();
    depthRequestIdToSymbol.set(depthTickerId, key);
    verbose(`depth subscribe ${key} kind=${kind} rows=${numRows} ticket=${depthTickerId}`);
  } catch (error) {
    console.error(`Failed to subscribe depth ${key}:`, error);
  }
}

function applyDepthDelta(key, position, marketMaker, operation, side, price, size) {
  const state = symbolDepthStates.get(key);
  if (!state) return;
  const ladder = side === 1 ? state.ladders.bid : state.ladders.ask;
  if (operation === 2) {
    ladder.delete(position);
  } else {
    // 0 insert / 1 update — same write semantics keyed by position.
    ladder.set(position, { price, size, marketMaker: marketMaker || null });
  }
  hydrateAndBroadcastDepth(key);
}

function serializeLadder(ladder, isFutures, kind, side) {
  const rows = [...ladder.entries()].sort((a, b) => a[0] - b[0]);
  // OPRA options: each row is a venue's top-of-book BBO (no stacked depth). The
  // NBBO is the best bid (max price) / best ask (min price) across the venue
  // rows; ALL venues tied at that inside price are flagged nbbo=true.
  const isOption = kind === "option";
  const nbboPrice = nbboPriceForOptionLadder(rows, side, isOption);
  return rows.map(([, lvl]) => {
    // Equity/option (L2): the venue/MPID code arrives as marketMaker. For
    // options the marketMaker IS the venue, so populate BOTH fields so the web
    // montage (level.marketMaker ?? level.exchange) labels the Market column
    // consistently with stocks. Equities keep marketMaker null (MPID exposed
    // as exchange). Futures (single-venue): no attribution, both null.
    const venue = isFutures ? null : (lvl.marketMaker || null);
    const marketMaker = isOption ? venue : null;
    const exchange = venue;
    const level = { price: lvl.price, size: lvl.size, marketMaker, exchange };
    if (isOption) level.nbbo = nbboPrice != null && lvl.price === nbboPrice;
    return level;
  });
}

// Inside price across an option venue montage: max bid / min ask. Returns null
// for non-option ladders or empty rows (no flag emitted).
function nbboPriceForOptionLadder(rows, side, isOption) {
  if (!isOption || rows.length === 0) return null;
  const prices = rows.map(([, lvl]) => lvl.price).filter((p) => typeof p === "number");
  if (prices.length === 0) return null;
  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

// Cross-venue NBBO summary for an option montage: best bid / best ask / mid /
// total displayed size across the venue rows at the inside.
function summarizeOptionNbbo(bid, ask) {
  const bestBid = bid.length ? Math.max(...bid.map((l) => l.price)) : null;
  const bestAsk = ask.length ? Math.min(...ask.map((l) => l.price)) : null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const sumSize = (rows) => rows.reduce((acc, l) => acc + (typeof l.size === "number" ? l.size : 0), 0);
  return { bestBid, bestAsk, mid, bidSize: sumSize(bid), askSize: sumSize(ask) };
}

function hydrateAndBroadcastDepth(key) {
  const state = symbolDepthStates.get(key);
  if (!state) return;
  const subscribers = depthSubscribers.get(key);
  if (!subscribers || subscribers.size === 0) return;

  const bid = serializeLadder(state.ladders.bid, state.isFutures, state.kind, "bid");
  const ask = serializeLadder(state.ladders.ask, state.isFutures, state.kind, "ask");
  const book = {
    symbol: key,
    kind: state.kind,
    bid,
    ask,
    isSmartDepth: !state.isFutures,
    feed: depthFeedLabel(state.kind, state.isFutures, state.isFutures ? state.contract?.exchange : null),
    entitled: true,
    timestamp: nowIso(),
  };
  // Options: surface the cross-venue NBBO summary (cheap — derived from the
  // already-flagged inside rows). Honest framing: this is top-of-book per
  // venue, not stacked depth.
  if (state.kind === "option") book.nbbo = summarizeOptionNbbo(bid, ask);
  for (const client of subscribers) {
    bufferDepthForClient(client, key, book);
  }
}

function subscribeClientToDepth(client, key) {
  let subscribers = depthSubscribers.get(key);
  if (!subscribers) {
    subscribers = new Set();
    depthSubscribers.set(key, subscribers);
  }
  subscribers.add(client);
}

function unsubscribeClientFromDepth(client, key) {
  const subscribers = depthSubscribers.get(key);
  if (!subscribers) return;
  subscribers.delete(client);
  if (subscribers.size === 0) {
    depthSubscribers.delete(key);
    stopDepthSubscription(key);
    stopTapeSubscription(key); // tape rides the focused depth symbol
  }
}

function cleanupDepthForReconnect() {
  for (const [, state] of symbolDepthStates) {
    if (state.depthTickerId != null) {
      try {
        ib.cancelMktDepth(state.depthTickerId, !state.isFutures);
      } catch {
        // Ignore.
      }
      depthRequestIdToSymbol.delete(state.depthTickerId);
      state.depthTickerId = null;
    }
    state.ladders.bid.clear();
    state.ladders.ask.clear();
  }
  cleanupTapeForReconnect();
}

// Restore the focused depth ticket(s) + tape after a reconnect.
function restoreDepthSubscriptions() {
  if (!DEPTH_ENABLED) return;
  for (const key of depthSubscribers.keys()) {
    const state = symbolDepthStates.get(key);
    if (!state || !state.contract) continue;
    startDepthSubscription(key, state.contract, { kind: state.kind, isFutures: state.isFutures });
    startTapeSubscription(key, state.contract);
  }
}

function subscribeClientToSymbol(client, symbol) {
  let subscribers = symbolSubscribers.get(symbol);
  if (!subscribers) {
    subscribers = new Set();
    symbolSubscribers.set(symbol, subscribers);
  }
  subscribers.add(client);

  let clientSet = clientSymbols.get(client);
  if (!clientSet) {
    clientSet = new Set();
    clientSymbols.set(client, clientSet);
  }
  clientSet.add(symbol);
}

function unsubscribeClientFromSymbol(client, symbol) {
  const subscribers = symbolSubscribers.get(symbol);
  let unsubscribed = false;

  if (subscribers) {
    subscribers.delete(client);
    if (subscribers.size === 0) {
      symbolSubscribers.delete(symbol);
      stopLiveSubscription(symbol);
      unsubscribed = true;
    } else {
      unsubscribed = true;
    }
  }

  const clientSet = clientSymbols.get(client);
  if (clientSet) {
    clientSet.delete(symbol);
  }

  return unsubscribed;
}

function disconnectClient(client) {
  removeBatchBuffer(client);
  clientLastPong.delete(client);
  if (DEPTH_ENABLED) {
    for (const key of [...depthSubscribers.keys()]) {
      unsubscribeClientFromDepth(client, key);
    }
  }
  const clientSet = clientSymbols.get(client);
  if (!clientSet) {
    return;
  }

  for (const symbol of clientSet) {
    const subscribers = symbolSubscribers.get(symbol);
    if (!subscribers) continue;

    subscribers.delete(client);
    if (subscribers.size === 0) {
      symbolSubscribers.delete(symbol);
      stopLiveSubscription(symbol);
    }
  }

  clientSymbols.delete(client);
}

function sendSubscribedConfirmation(client, symbols) {
  sendMessage(client, {
    type: "subscribed",
    symbols,
  });
}

function sendUnsubscribedConfirmation(client, symbols) {
  sendMessage(client, {
    type: "unsubscribed",
    symbols,
  });
}

async function handleSnapshotRequest(client, symbols) {
  for (const symbol of symbols) {
    if (!ibConnected) {
      sendMessage(client, {
        type: "error",
        message: "IB not connected",
      });
      continue;
    }

    const requestId = nextRequestId += 1;
    const contract = stockContract(symbol, "SMART", "USD");
    const requestState = {
      symbol,
      client,
      timer: setTimeout(() => {
        sendMessage(client, {
          type: "error",
          message: `Timeout waiting for snapshot: ${symbol}`,
        });
        clearSnapshot(requestId);
        try {
          ib.cancelMktData(requestId);
        } catch {
          // Ignore.
        }
      }, SNAPSHOT_TIMEOUT_MS),
      data: createPriceData(symbol),
    };

    snapshotRequests.set(requestId, requestState);
    requestIdToSymbol.set(requestId, symbol);

    try {
      await snapshotLimiter.submit(() => {
        // IB rejects snapshot=true paired with generic ticks (233=RTVolume,
        // 165=Misc Stats) — both are streaming-only. Snapshot still returns
        // bid/ask/last/close/volume/high/low/open via default tick types,
        // which is what the snapshot consumer needs. The streaming path at
        // line 566 keeps "233,165" because snapshot=false there.
        ib.reqMktData(requestId, contract, "", true, false);
      });
    } catch (error) {
      clearSnapshot(requestId);
      try {
        ib.cancelMktData(requestId);
      } catch {
        // Ignore.
      }
      sendMessage(client, {
        type: "error",
        message: `Failed to request snapshot for ${symbol}: ${String(error)}`,
      });
    }
  }
}

/** Maximum age (ms) for cached bid/ask before we consider it stale.
 * Option quotes older than 8 hours come from a prior session and should
 * not be broadcast to new subscribers — they will be replaced once the
 * fresh reqMktData ticks arrive from IB. */
const QUOTE_STALE_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Return a copy of PriceData safe to send as an initial snapshot.
 * If the cached bid/ask timestamps are older than QUOTE_STALE_MS
 * (i.e. from a prior trading session), null them out so the UI shows
 * "---" instead of stale prices until fresh ticks arrive.
 */
function safeInitialState(data) {
  if (!data.timestamp) return data;
  const age = Date.now() - new Date(data.timestamp).getTime();
  if (age > QUOTE_STALE_MS) {
    return { ...data, bid: null, ask: null, bidSize: null, askSize: null, lastIsCalculated: false };
  }
  return data;
}

function hydrateAndBroadcast(symbol) {
  const state = symbolStates.get(symbol);
  if (!state) return;
  // Backfill close from cache for options that IB hasn't sent close for
  applyCachedClose(state.data);

  // Buffer the tick for batched delivery instead of sending immediately.
  // Each subscribed client gets the latest PriceData snapshot for this symbol
  // in their per-client buffer. The batch flush timer sends all buffered
  // updates as a single {"type": "batch", "updates": {...}} message.
  const subscribers = symbolSubscribers.get(symbol);
  if (!subscribers || subscribers.size === 0) return;
  const dataSnapshot = { ...state.data };
  for (const client of subscribers) {
    bufferPriceForClient(client, symbol, dataSnapshot);
  }
}

function onTickPrice(tickerId, tickType, price) {
  lastTickTimestamp = Date.now();
  const symbol = requestIdToSymbol.get(tickerId);
  const liveState = symbol ? symbolStates.get(symbol) : null;
  const snapshotState = snapshotRequests.get(tickerId);

  if (liveState) {
    updatePriceFromTickPrice(liveState.data, tickType, price);
    // Cache option close prices to disk for after-hours availability
    updateOptionCloseCache(symbol, liveState.data.close);
    verbose(`tick ${symbol} type=${tickType} price=${price}`);
    hydrateAndBroadcast(symbol);
  }
  if (snapshotState) {
    updatePriceFromTickPrice(snapshotState.data, tickType, price);
  }
}

function onTickSize(tickerId, sizeType, size) {
  lastTickTimestamp = Date.now();
  const symbol = requestIdToSymbol.get(tickerId);
  const liveState = symbol ? symbolStates.get(symbol) : null;
  const snapshotState = snapshotRequests.get(tickerId);

  if (liveState) {
    updatePriceFromTickSize(liveState.data, sizeType, size);
  }
  if (snapshotState) {
    updatePriceFromTickSize(snapshotState.data, sizeType, size);
  }
}

function onTickSnapshotEnd(tickerId) {
  const symbol = requestIdToSymbol.get(tickerId);
  if (!symbol) return;
  completeSnapshot(symbol, tickerId);
}

/* ─── Fundamentals via reqFundamentalData (IBIS subscription) ─── */

const fundamentalsRequestIds = new Map(); // reqId → symbol
const fundamentalsPending = new Set(); // symbols currently being fetched

function requestFundamentals(symbol, ibContract) {
  // Only for stock symbols, not options
  if (symbol.includes("_")) return;
  // Not for futures roots — reqFundamentalData(ReportSnapshot) is equities-only;
  // a FUT contract returns nothing useful and just logs noise.
  if (ibContract && ibContract.secType === SecType.FUT) return;
  // Already have data or request in-flight
  if (fundamentalsStore.has(symbol) || fundamentalsPending.has(symbol)) return;
  if (!ibConnected) return;

  const reqId = nextRequestId += 1;
  fundamentalsRequestIds.set(reqId, symbol);
  fundamentalsPending.add(symbol);

  try {
    ib.reqFundamentalData(reqId, ibContract, "ReportSnapshot");
    verbose(`reqFundamentalData ${symbol} reqId=${reqId}`);
  } catch (error) {
    verbose(`reqFundamentalData failed for ${symbol}: ${error}`);
    fundamentalsRequestIds.delete(reqId);
    fundamentalsPending.delete(symbol);
  }
}

function onFundamentalData(reqId, xmlData) {
  const symbol = fundamentalsRequestIds.get(reqId);
  if (!symbol) return;
  fundamentalsRequestIds.delete(reqId);
  fundamentalsPending.delete(symbol);

  const fundData = createFundamentalsData(symbol);

  // Parse XML ratio data — extract key financial ratios
  const extractRatio = (tag) => {
    const match = xmlData.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`));
    if (!match) return null;
    const val = parseFloat(match[1]);
    return Number.isFinite(val) ? val : null;
  };

  // IB ReportSnapshot XML has Ratio tags like:
  //   <Ratio FieldName="PEEXCLXOR">25.3</Ratio>
  const extractNamedRatio = (fieldName) => {
    const re = new RegExp(`<Ratio[^>]*FieldName="${fieldName}"[^>]*>([^<]+)</Ratio>`);
    const match = xmlData.match(re);
    if (!match) return null;
    const val = parseFloat(match[1]);
    return Number.isFinite(val) ? val : null;
  };

  fundData.peRatio = extractNamedRatio("PEEXCLXOR") ?? extractNamedRatio("APENORM");
  fundData.eps = extractNamedRatio("TTMEPSXCLX") ?? extractNamedRatio("AEPSNORM");
  fundData.dividendYield = extractNamedRatio("YIELD") ?? extractNamedRatio("TTMDIVSHR");
  fundData.week52High = extractNamedRatio("NHIG") ?? extractNamedRatio("NPRICE");
  fundData.week52Low = extractNamedRatio("NLOW");
  fundData.priceBookRatio = extractNamedRatio("PRICE2BK");
  fundData.roe = extractNamedRatio("TTMROEPCT");
  fundData.revenue = extractNamedRatio("TTMREV");

  const hasData = Object.entries(fundData).some(([k, v]) => k !== "symbol" && k !== "timestamp" && v !== null);
  if (hasData) {
    fundamentalsStore.set(symbol, fundData);
    verbose(`fundamentals ${symbol}: PE=${fundData.peRatio} EPS=${fundData.eps} DY=${fundData.dividendYield} 52H=${fundData.week52High} 52L=${fundData.week52Low}`);
    sendToSymbolSubscribers(symbol, {
      type: "fundamentals",
      symbol,
      data: fundData,
    });
  } else {
    verbose(`fundamentals ${symbol}: no usable data in XML (${xmlData.length} chars)`);
  }
}

function restoreSubscriptions() {
  const keys = [...symbolSubscribers.keys()];
  for (const key of keys) {
    const existing = symbolStates.get(key);
    const ibContract = existing?.contract;
    if (!ibContract) continue;
    startLiveSubscription(key, ibContract);
    const state = symbolStates.get(key);
    if (state) {
      sendToSymbolSubscribers(key, {
        type: "price",
        symbol: key,
        data: state.data,
      });
    }
  }
}

/* Resolve the IB contract + instrument kind for a single depth subject from
 * the raw client payload. Option → has expiry/strike; future → symbol in the
 * futures set; else stock. Returns null when the payload is unusable. */
function resolveDepthSubject(payload) {
  const rawSymbol = typeof payload.symbol === "string" ? payload.symbol.trim().toUpperCase() : null;
  if (!rawSymbol) return null;

  const hasOptionFields = typeof payload.expiry === "string" && typeof payload.strike === "number" && (payload.right === "C" || payload.right === "P");
  if (hasOptionFields) {
    const c = { symbol: rawSymbol, expiry: payload.expiry.trim(), strike: payload.strike, right: payload.right };
    return { key: optionKey(c), contract: optionContract(c.symbol, c.expiry, c.strike, c.right), kind: "option", isFutures: false };
  }

  const isFuture = DEPTH_FUTURES_SYMBOLS.has(rawSymbol) || payload.instrument === "future" || payload.secType === "FUT";
  if (isFuture) {
    // Depth on a bare futures root needs a QUALIFIED front-month contract
    // (conId), resolved via reqContractDetails in the handler. We carry the
    // root + a fallback bare-root contract; the handler swaps in the resolved
    // front-month before calling reqMktDepth.
    const exchange = typeof payload.exchange === "string" ? payload.exchange.trim().toUpperCase() : futuresExchangeForRoot(rawSymbol);
    return { key: rawSymbol, root: rawSymbol, contract: futureContract(rawSymbol, "", "USD", exchange), kind: "future", isFutures: true };
  }

  return { key: rawSymbol, contract: stockContract(rawSymbol, "SMART", "USD"), kind: "stock", isFutures: false };
}

async function handleClientMessage(client, data) {
  // Depth actions carry a single `symbol` (+ instrument fields), distinct from
  // the array subscribe. Route them off the raw payload before normalization.
  if (DEPTH_ENABLED && data && typeof data === "object" && typeof data.action === "string") {
    const depthAction = data.action.trim().toLowerCase();
    if (depthAction === "subscribe-depth" || depthAction === "unsubscribe-depth") {
      const subject = resolveDepthSubject(data);
      if (!subject) {
        sendMessage(client, { type: "error", message: "Invalid depth subscription" });
        return;
      }
      if (depthAction === "subscribe-depth") {
        subscribeClientToDepth(client, subject.key);
        let contract = subject.contract;
        if (subject.isFutures) {
          // Qualify the front month (conId) before reqMktDepth — bounded await
          // so a slow/failed resolution can't hang the relay. No depth without
          // a real contract: emit futures-no-depth and bail.
          const resolved = await resolveFuturesFrontMonth(subject.root);
          if (!resolved) {
            emitDepthUnavailable(subject.key, "futures-no-depth");
            return;
          }
          contract = resolved;
        }
        startDepthSubscription(subject.key, contract, { kind: subject.kind, isFutures: subject.isFutures });
        startTapeSubscription(subject.key, contract);
      } else {
        unsubscribeClientFromDepth(client, subject.key);
      }
      return;
    }
  }

  const message = parseActionMessage(data);
  if (!message) {
    sendMessage(client, { type: "error", message: "Invalid JSON" });
    return;
  }

  const symbols = message.symbols;
  const contracts = message.contracts;
  const indexes = message.indexes;
  verbose(`action=${message.action} symbols=[${symbols.join(",")}] contracts=${contracts.length} indexes=${indexes.length}`);
  switch (message.action) {
    case "subscribe": {
      const subscribed = [];
      // Stock subscriptions (backward compatible)
      for (const symbol of symbols) {
        subscribeClientToSymbol(client, symbol);
        // A bare futures ROOT (e.g. "ES") must subscribe L1 against the resolved
        // front-month FUTURE, not a stock — otherwise IB resolves the equity
        // ticker of the same name (ES = Eversource Energy ~$67) and the quote bar
        // shows the wrong instrument while the depth ladder shows the future.
        // Gated on DEPTH_ENABLED (front-month resolution lives in the depth path).
        let ibContract;
        if (DEPTH_ENABLED && DEPTH_FUTURES_SYMBOLS.has(symbol)) {
          const resolvedFut = await resolveFuturesFrontMonth(symbol);
          ibContract = resolvedFut || stockContract(symbol, "SMART", "USD");
        } else {
          ibContract = stockContract(symbol, "SMART", "USD");
        }
        ensureSymbolState(symbol, ibContract);
        if (ibConnected) {
          startLiveSubscription(symbol, ibContract);
          const state = symbolStates.get(symbol);
          if (state) {
            sendMessage(client, {
              type: "price",
              symbol,
              data: safeInitialState(state.data),
            });
          }
          // Send cached fundamentals if available
          const fund = fundamentalsStore.get(symbol);
          if (fund) {
            sendMessage(client, {
              type: "fundamentals",
              symbol,
              data: fund,
            });
          }
          subscribed.push(symbol);
        }
      }
      // Option contract subscriptions
      for (const c of contracts) {
        const key = optionKey(c);
        subscribeClientToSymbol(client, key);
        const ibContract = optionContract(c.symbol, c.expiry, c.strike, c.right);
        ensureSymbolState(key, ibContract);
        if (ibConnected) {
          startLiveSubscription(key, ibContract);
          const state = symbolStates.get(key);
          if (state) {
            sendMessage(client, {
              type: "price",
              symbol: key,
              data: safeInitialState(state.data),
            });
          }
          subscribed.push(key);
        }
      }
      // Index subscriptions (e.g. VIX, VVIX on CBOE)
      for (const idx of indexes) {
        const key = idx.symbol;
        subscribeClientToSymbol(client, key);
        const ibContract = indexContract(idx.symbol, "USD", idx.exchange);
        ensureSymbolState(key, ibContract);
        if (ibConnected) {
          startLiveSubscription(key, ibContract);
          const state = symbolStates.get(key);
          if (state) {
            sendMessage(client, {
              type: "price",
              symbol: key,
              data: safeInitialState(state.data),
            });
          }
          subscribed.push(key);
        }
      }
      sendSubscribedConfirmation(client, subscribed);
      return;
    }
    case "unsubscribe": {
      const unsubscribed = [];
      for (const symbol of symbols) {
        if (unsubscribeClientFromSymbol(client, symbol)) {
          unsubscribed.push(symbol);
        }
      }
      for (const idx of indexes) {
        if (unsubscribeClientFromSymbol(client, idx.symbol)) {
          if (!unsubscribed.includes(idx.symbol)) {
            unsubscribed.push(idx.symbol);
          }
        }
      }
      sendUnsubscribedConfirmation(client, unsubscribed);
      return;
    }
    case "snapshot": {
      await handleSnapshotRequest(client, symbols);
      return;
    }
    case "ping": {
      sendMessage(client, { type: "pong" });
      return;
    }
    case "pong": {
      clientLastPong.set(client, Date.now());
      return;
    }
    case "search": {
      const pattern = typeof data.pattern === "string" ? data.pattern.trim() : "";
      if (!pattern || pattern.length < 1) {
        sendMessage(client, { type: "error", message: "Search requires a non-empty pattern" });
        return;
      }
      if (!ibConnected) {
        sendMessage(client, {
          type: "searchResults",
          pattern,
          results: [],
          disconnected: true,
        });
        return;
      }

      // Check cache
      const cached = searchCache.get(pattern.toUpperCase());
      if (cached && (Date.now() - cached.ts) < SEARCH_CACHE_TTL_MS) {
        sendMessage(client, { type: "searchResults", pattern, results: cached.results });
        return;
      }

      const reqId = nextRequestId += 1;
      searchRequestClients.set(reqId, { client, pattern: pattern.toUpperCase() });
      try {
        ib.reqMatchingSymbols(reqId, pattern);
      } catch (error) {
        searchRequestClients.delete(reqId);
        sendMessage(client, { type: "searchResults", pattern, results: [] });
      }

      // Timeout: if IB doesn't respond in 5s, return empty
      setTimeout(() => {
        if (searchRequestClients.has(reqId)) {
          searchRequestClients.delete(reqId);
          sendMessage(client, { type: "searchResults", pattern, results: [] });
        }
      }, SNAPSHOT_TIMEOUT_MS);
      return;
    }
    default: {
      sendMessage(client, {
        type: "error",
        message: `Unknown action: ${message.action}`,
      });
    }
  }
}

function rotateIBClient(newClientId) {
  // Tear down old instance
  try { ib.disconnect(); } catch { /* ignore */ }
  try { ib.removeAllListeners(); } catch { /* ignore */ }

  // Create new instance and rewire all events
  ib = createIBClient(newClientId);
  wireIBEvents();

  // Reconnect after a short delay
  setTimeout(() => {
    try { ib.connect(); } catch { /* ignore — scheduleReconnect will retry */ }
  }, 2000);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log(`Attempting IB reconnect to ${cli.ibHost}:${cli.ibPort}...`);
    try {
      ib.disconnect();
    } catch {
      // Ignore.
    }
    try {
      ib.connect();
    } catch {
      // Ignore.
      ibConnected = false;
      broadcastStatus();
      scheduleReconnect();
    }
  }, RECONNECT_MS);
}

function wireIBEvents() {
  ib.on(EventName.connected, () => {
    ibConnected = true;
    ibConnectionIssue = null;
    console.log(`IB connected (clientId ${IB_CLIENT_ID_POOL[activeClientIdIndex]})`);
    reconnectTimer = null;
    if (DEPTH_ENABLED) {
      // Depth + tick-by-tick require realtime (type 1). reqMarketDataType is
      // per-connection/global, so enabling depth flips the shared connection
      // to realtime (the watchlist L1 becomes realtime too). The production
      // follow-up is a dedicated realtime depth client; see the DEPTH note.
      ib.reqMarketDataType(1);
    } else {
      // Request Delayed-Frozen data so closed-market queries return last known prices
      // Type 4 cascades: Live → Delayed → Frozen → Delayed-Frozen
      ib.reqMarketDataType(4);
    }
    cleanupSymbolStateForReconnect();
    if (DEPTH_ENABLED) cleanupDepthForReconnect();
    searchCache.clear(); // Invalidate stale search results from IB-down period
    restoreSubscriptions();
    if (DEPTH_ENABLED) restoreDepthSubscriptions();
    broadcastStatus();
  });

  ib.on(EventName.disconnected, () => {
    if (ibConnected) {
      console.log("IB disconnected");
    }
    ibConnected = false;
    broadcastStatus();
    scheduleReconnect();
  });

  // @stoqey/ib error signature: (error, code, reqId). reqId is the request
  // (ticker) id the error pertains to, or -1 when not request-scoped. The old
  // `ib` lib delivered (error, { id, code }); we map reqId → tickerId, code → code.
  ib.on(EventName.error, (error, code, reqId) => {
    const msg = String(error?.message ?? error);
    const tickerId = reqId != null && reqId >= 0 ? reqId : undefined;
    const symbol = tickerId != null ? requestIdToSymbol.get(tickerId) : null;
    const connectionIssue = classifyIBConnectionError(msg, {
      ibHost: cli.ibHost,
      ibPort: cli.ibPort,
    });

    if (/connection is OK|farm connection is OK/i.test(msg)) {
      console.log(`\x1b[32mIB status: ${msg}\x1b[0m`);
    } else if (code === 200 || /No security definition has been found/i.test(msg)) {
      verbose(`no security def for ${symbol ?? `tickerId:${tickerId}`}`);
      if (symbol) {
        const state = symbolStates.get(symbol);
        if (state && state.tickerId === tickerId) {
          requestIdToSymbol.delete(tickerId);
          state.tickerId = null;
        }
      } else if (tickerId != null) {
        requestIdToSymbol.delete(tickerId);
      }
    } else if (code === 354 || /market data is not subscribed/i.test(msg)) {
      console.warn(`\x1b[33mIB warning: no market data subscription for ${symbol ?? `tickerId:${tickerId}`}\x1b[0m`);
      if (symbol) {
        const state = symbolStates.get(symbol);
        if (state && state.tickerId === tickerId) {
          requestIdToSymbol.delete(tickerId);
          state.tickerId = null;
        }
      }
    } else if (DEPTH_ENABLED && (code === 10089 || /depth.*not (allowed|eligible)/i.test(msg)) && tickerId != null && depthRequestIdToSymbol.has(tickerId)) {
      // No L2 entitlement — soft, expected. Cancel the ticket and tell the
      // client; never latch a connection fault.
      const depthSymbol = depthRequestIdToSymbol.get(tickerId);
      console.warn(`\x1b[33mIB warning: depth not entitled for ${depthSymbol} (code ${code})\x1b[0m`);
      stopDepthSubscription(depthSymbol, { keepState: true });
      emitDepthUnavailable(depthSymbol, "no-entitlement", 10089);
    } else if (/Fundamentals data is not allowed/i.test(msg)) {
      verbose(`fundamentals not allowed for tickerId:${tickerId} — IBIS subscription may be inactive`);
      if (tickerId != null) {
        const fundSymbol = fundamentalsRequestIds.get(tickerId);
        if (fundSymbol) {
          fundamentalsRequestIds.delete(tickerId);
          fundamentalsPending.delete(fundSymbol);
        }
      }
    } else if (/Can't find EId/i.test(msg)) {
      console.warn(`\x1b[33mIB warning: ${msg}\x1b[0m`);
    } else if (/client id is already in use/i.test(msg)) {
      activeClientIdIndex = (activeClientIdIndex + 1) % IB_CLIENT_ID_POOL.length;
      const nextId = IB_CLIENT_ID_POOL[activeClientIdIndex];
      console.warn(`\x1b[33mIB warning: client ID ${IB_CLIENT_ID_POOL[(activeClientIdIndex - 1 + IB_CLIENT_ID_POOL.length) % IB_CLIENT_ID_POOL.length]} in use, rotating to ${nextId}\x1b[0m`);
      rotateIBClient(nextId);
      return;
    } else {
      console.error(`\x1b[31mIB error: ${msg}${symbol ? ` (${symbol})` : tickerId != null ? ` (tickerId:${tickerId})` : ""}\x1b[0m`);
    }

    if (connectionIssue) {
      ibConnected = false;
      ibConnectionIssue = connectionIssue;
      broadcastStatus();
      scheduleReconnect();
    }
  });

  ib.on(EventName.tickPrice, (tickerId, tickType, price) => {
    onTickPrice(tickerId, tickType, price);
  });

  ib.on(EventName.tickSize, (tickerId, sizeType, size) => {
    onTickSize(tickerId, sizeType, size);
  });

  ib.on(EventName.tickSnapshotEnd, (tickerId) => {
    onTickSnapshotEnd(tickerId);
  });

  ib.on(EventName.fundamentalData, (reqId, data) => {
    onFundamentalData(reqId, data);
  });

  ib.on(EventName.tickOptionComputation, (tickerId, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice) => {
    const symbol = requestIdToSymbol.get(tickerId);
    const liveState = symbol ? symbolStates.get(symbol) : null;
    if (!liveState) return;

    const validTickTypes = [13, 83, 12, 82];
    if (!validTickTypes.includes(tickType)) return;

    const pd = liveState.data;
    const isModel = tickType === 13 || tickType === 83;
    if (!isModel && pd.delta !== null) return;

    const valid = (v) => v !== undefined && v !== -2 && v !== -1 && Number.isFinite(v);

    if (valid(delta)) pd.delta = delta;
    if (valid(gamma)) pd.gamma = gamma;
    if (valid(theta)) pd.theta = theta;
    if (valid(vega)) pd.vega = vega;
    if (valid(impliedVol)) pd.impliedVol = impliedVol;
    if (valid(undPrice)) pd.undPrice = undPrice;

    pd.timestamp = nowIso();
    verbose(`greeks ${symbol} tickType=${tickType} delta=${delta} iv=${impliedVol}`);
    hydrateAndBroadcast(symbol);
  });

  ib.on(EventName.symbolSamples, (reqId, contracts) => {
    const req = searchRequestClients.get(reqId);
    if (!req) return;
    searchRequestClients.delete(reqId);

    const results = contracts.map((c) => ({
      conId: c.conId,
      symbol: c.symbol,
      secType: c.secType,
      primaryExchange: c.primaryExchange,
      currency: c.currency,
      derivativeSecTypes: c.derivativeSecTypes || [],
    }));

    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = searchCache.keys().next().value;
      searchCache.delete(oldest);
    }
    searchCache.set(req.pattern, { results, ts: Date.now() });

    sendMessage(req.client, {
      type: "searchResults",
      pattern: req.pattern,
      results,
    });

    verbose(`search "${req.pattern}" → ${results.length} results`);
  });

  if (DEPTH_ENABLED) {
    // Futures / single-venue depth — no market maker (arg order: id, position,
    // operation, side, price, size in the installed `ib` lib).
    ib.on(EventName.updateMktDepth, (id, position, operation, side, price, size) => {
      const key = depthRequestIdToSymbol.get(id);
      if (!key) return;
      lastTickTimestamp = Date.now();
      applyDepthDelta(key, position, null, operation, side, price, size);
    });

    // Equity / SMART L2 — marketMaker = exchange/MPID code. @stoqey/ib appends
    // a trailing isSmartDepth arg after size; we accept it but don't re-derive
    // from it (the ladder's smart-depth label comes from state.isFutures).
    ib.on(EventName.updateMktDepthL2, (id, position, marketMaker, operation, side, price, size, _isSmartDepth) => {
      const key = depthRequestIdToSymbol.get(id);
      if (!key) return;
      lastTickTimestamp = Date.now();
      applyDepthDelta(key, position, marketMaker, operation, side, price, size);
    });

    // Time & Sales tape — reqTickByTickData(AllLast). @stoqey/ib arity:
    // (reqId, tickType, time, price, size, tickAttribLast, exchange,
    // specialConditions). `time` is unix seconds (string); we emit ISO.
    ib.on(EventName.tickByTickAllLast, (reqId, _tickType, time, price, size, _tickAttribLast, exchange, _specialConditions) => {
      const key = tapeRequestIdToSymbol.get(reqId);
      if (!key) return;
      lastTickTimestamp = Date.now();
      const seconds = Number(time);
      const iso = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : nowIso();
      applyTrade(key, price, size, exchange, iso);
    });

    // Front-month futures contract resolution (reqContractDetails).
    ib.on(EventName.contractDetails, (reqId, contractDetails) => {
      onContractDetails(reqId, contractDetails);
    });
    ib.on(EventName.contractDetailsEnd, (reqId) => {
      onContractDetailsEnd(reqId);
    });
  }
}

// Wire events on initial instance
wireIBEvents();

wss.on("connection", (client) => {
  clients.add(client);
  clientLastPong.set(client, Date.now());
  verbose(`WS client connected (total: ${clients.size})`);
  sendStatus(client);

  client.on("message", (raw) => {
    const payload = (() => {
      if (typeof raw === "string") return raw;
      if (raw instanceof Buffer) return raw.toString("utf8");
      if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
      return "";
    })();

    if (!payload) return;

    try {
      const data = JSON.parse(payload);
      void handleClientMessage(client, data);
    } catch {
      sendMessage(client, { type: "error", message: "Invalid JSON" });
    }
  });

  client.on("close", () => {
    verbose(`WS client disconnected (remaining: ${clients.size - 1})`);
    disconnectClient(client);
    clients.delete(client);
  });

  client.on("error", () => {
    disconnectClient(client);
    clients.delete(client);
  });
});

ib.connect();
startBatchFlush();

/* ─── Keep-Alive Ping Interval ─────────────────────────────────────────── */
pingIntervalTimer = setInterval(() => {
  const now = Date.now();
  for (const client of clients) {
    sendMessage(client, { type: "ping" });
    const lastPong = clientLastPong.get(client);
    if (lastPong !== undefined && now - lastPong > PONG_TIMEOUT_MS) {
      console.log(`Closing unresponsive client (no pong for ${Math.round((now - lastPong) / 1000)}s)`);
      clientLastPong.delete(client);
      try { client.close(); } catch { /* ignore */ }
    }
  }
}, PING_INTERVAL_MS);

statusBroadcastTick = setInterval(() => {
  if (ibConnected) return;
  for (const client of clients) {
    sendStatus(client);
  }
}, 5000);

/* ─── Stale Data Health Check ──────────────────────────────────────────────
 * If connected to IB with active subscriptions during market hours but no
 * ticks received in STALE_DATA_THRESHOLD_MS, auto-restart IB Gateway.
 */
staleCheckTimer = setInterval(() => {
  if (!ibConnected || shuttingDown || ibGatewayRestarting) return;
  if (!isUSMarketHours()) return;

  const activeSubscriptions = symbolSubscribers.size;
  if (activeSubscriptions === 0) return;

  const elapsed = Date.now() - lastTickTimestamp;
  if (elapsed > STALE_DATA_THRESHOLD_MS) {
    console.warn(
      `\x1b[33m[stale-data] No ticks for ${Math.round(elapsed / 1000)}s with ${activeSubscriptions} active subscriptions during market hours\x1b[0m`,
    );
    restartIBGateway();
  }
}, STALE_CHECK_INTERVAL_MS);

process.on("SIGINT", () => {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  if (statusBroadcastTick) {
    clearInterval(statusBroadcastTick);
  }
  stopBatchFlush();
  if (pingIntervalTimer) {
    clearInterval(pingIntervalTimer);
    pingIntervalTimer = null;
  }
  if (staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }
  snapshotLimiter.clear();
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // Ignore.
    }
  }
  for (const [requestId] of snapshotRequests) {
    clearSnapshot(requestId);
  }
  for (const state of symbolStates.values()) {
    if (state.tickerId != null) {
      try {
        ib.cancelMktData(state.tickerId);
      } catch {
        // Ignore.
      }
    }
  }
  // Flush option close cache before exit
  persistCloseCache();
  try {
    wss.close();
    ib.disconnect();
  } catch {
    // Ignore.
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.emit("SIGINT");
});

httpServer.on("listening", () => {
  console.log(`WebSocket server listening on ${WS_HOST}:${cli.port}`);
});
console.log(`IB realtime server listening on ${wsUrl}`);
console.log(`IB target ${cli.ibHost}:${cli.ibPort}`);
