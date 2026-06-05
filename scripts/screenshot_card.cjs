#!/usr/bin/env node
/**
 * Screenshot a card element from a local HTML file to a PNG using Playwright.
 *
 * Replaces the missing `agent-browser` CLI. Resolves Playwright from the repo
 * node_modules when invoked with cwd at the repo root. Runs headless so it has
 * no display dependency.
 *
 * Usage:
 *   node scripts/screenshot_card.cjs <htmlPath> <pngPath> [selector]
 *
 * Exits 0 on success. On any error, prints to stderr and exits 1.
 */
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_SELECTOR = ".card";
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 300;

async function screenshotCard(htmlPath, pngPath, selector) {
  const fileUrl = "file://" + path.resolve(htmlPath);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    try {
      await page.goto(fileUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    } catch (_) {
      await page.goto(fileUrl, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    }
    const el = await waitForCard(page, selector);
    await page.waitForTimeout(SETTLE_MS);
    if (el) {
      await el.screenshot({ path: pngPath });
    } else {
      await page.screenshot({ path: pngPath, fullPage: true });
    }
  } finally {
    await browser.close();
  }
}

async function waitForCard(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: NAV_TIMEOUT_MS });
  } catch (_) {
    // Fall back to full-page screenshot below.
  }
  return page.$(selector);
}

function parseArgs(argv) {
  const [htmlPath, pngPath, selector] = argv.slice(2);
  if (!htmlPath || !pngPath) {
    throw new Error("Usage: node scripts/screenshot_card.cjs <htmlPath> <pngPath> [selector]");
  }
  return { htmlPath, pngPath, selector: selector || DEFAULT_SELECTOR };
}

async function main() {
  const { htmlPath, pngPath, selector } = parseArgs(process.argv);
  await screenshotCard(htmlPath, pngPath, selector);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  }
);
