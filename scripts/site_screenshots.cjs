#!/usr/bin/env node
// Capture Radon marketing-site screenshots in dark + light themes.
// Usage: node scripts/site_screenshots.cjs [baseUrl] [outDir]
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://localhost:3333";
const OUT = process.argv[3] || path.join(__dirname, "..", "reports", "site-screenshots");

const SECTIONS = [
  { id: "top", name: "hero-terminal" },
  { id: "strategies", name: "strategy-matrix" },
  { id: "execution", name: "execution-rail" },
  { id: "surfaces", name: "surface-stack" },
  { id: "methodology", name: "audit-methodology" },
];

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const captured = [];

  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    // Seed the theme before any page script runs so the bootstrap picks it up.
    await context.addInitScript((t) => {
      try { window.localStorage.setItem("theme", t); } catch (e) {}
    }, theme);

    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(700); // let staggered load-in settle

    const resolved = await page.getAttribute("html", "data-theme");
    if (resolved !== theme) throw new Error(`theme mismatch: wanted ${theme}, got ${resolved}`);

    // Above-the-fold chrome (header + hero)
    const fold = path.join(OUT, `${theme}-00-fold.png`);
    await page.screenshot({ path: fold });
    captured.push(fold);

    // Full page
    const full = path.join(OUT, `${theme}-99-fullpage.png`);
    await page.screenshot({ path: full, fullPage: true });
    captured.push(full);

    // Per-section
    let i = 1;
    for (const s of SECTIONS) {
      const el = page.locator(`#${s.id}`).first();
      const count = await el.count();
      if (!count) { console.warn(`  ! #${s.id} not found`); continue; }
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const file = path.join(OUT, `${theme}-${String(i).padStart(2, "0")}-${s.name}.png`);
      await el.screenshot({ path: file });
      captured.push(file);
      i++;
    }

    await context.close();
    console.log(`[${theme}] captured ${i + 1} shots`);
  }

  await browser.close();
  console.log(`\nWrote ${captured.length} files to ${OUT}`);
  captured.forEach((f) => console.log("  " + path.relative(path.join(__dirname, ".."), f)));
}

run().catch((e) => { console.error(e); process.exit(1); });
