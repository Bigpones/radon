import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const webDir = resolve(__dirname, "..");
const projectRoot = resolve(webDir, "..");
const source = readFileSync(resolve(projectRoot, "scripts", "ib_realtime_server.js"), "utf8");

describe("ib_realtime_server.js preserves typed contracts for cold-start restore", () => {
  it("seeds stock, option, and index subscriptions with their IB contract before the ibConnected gate", () => {
    expect(source).toContain("function ensureSymbolState");

    const stockBlock = source.match(/\/\/ Stock subscriptions[\s\S]*?\/\/ Option contract subscriptions/s)?.[0] ?? "";
    // Stock symbols seed a stock contract; a futures ROOT seeds the resolved
    // front-month future for L1 (so the quote bar matches the depth ladder).
    expect(stockBlock).toContain('stockContract(symbol, "SMART", "USD")');
    expect(stockBlock).toContain("resolveFuturesFrontMonth(symbol)");
    expect(stockBlock).toContain("ensureSymbolState(symbol, ibContract);");

    const optionBlock = source.match(/\/\/ Option contract subscriptions[\s\S]*?\/\/ Index subscriptions/s)?.[0] ?? "";
    expect(optionBlock).toContain("const ibContract = optionContract(c.symbol, c.expiry, c.strike, c.right);");
    expect(optionBlock).toContain("ensureSymbolState(key, ibContract);");

    const indexBlock = source.match(/\/\/ Index subscriptions[\s\S]*?sendSubscribedConfirmation/s)?.[0] ?? "";
    expect(indexBlock).toContain('const ibContract = indexContract(idx.symbol, "USD", idx.exchange);');
    expect(indexBlock).toContain("ensureSymbolState(key, ibContract);");
  });

  it("uses the @stoqey/ib API surface (IBApi + EventName) instead of the dead ib@0.2.9 package", () => {
    expect(source).toMatch(/import \{ IBApi, EventName, SecType, OptionType(, TickByTickDataType)? \} from "@stoqey\/ib";/);
    expect(source).not.toMatch(/from ["']ib["']/);
    expect(source).toContain("new IBApi({");
    // Contracts are plain object literals built from the @stoqey enums.
    expect(source).toContain("secType: SecType.STK");
    expect(source).toContain("secType: SecType.OPT");
    expect(source).toContain("secType: SecType.IND");
    expect(source).toContain("lastTradeDateOrContractMonth: expiry");
    expect(source).toContain("right: right === \"C\" ? OptionType.Call : OptionType.Put");
    // Events wired via the EventName enum.
    expect(source).toContain("ib.on(EventName.connected");
    expect(source).toContain("ib.on(EventName.tickPrice");
    expect(source).toContain("ib.on(EventName.error");
    // @stoqey error arity is (error, code, reqId) — reqId maps to tickerId.
    expect(source).toContain("ib.on(EventName.error, (error, code, reqId) =>");
  });

  it("restores subscriptions from the stored contract instead of rebuilding everything as stocks", () => {
    const restoreBlock = source.match(/function restoreSubscriptions\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(restoreBlock).toContain("const ibContract = existing?.contract;");
    expect(restoreBlock).not.toContain('?? ib.contract.stock(key, "SMART", "USD")');
  });
});
