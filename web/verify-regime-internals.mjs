import { chromium } from 'playwright';

const base = 'http://localhost:3000';
const targets = ['/regime', '/internals'];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1600 } });

for (const path of targets) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const bodyText = await page.locator('body').innerText();
  const hasSkewTerm = bodyText.toLowerCase().includes('skew') || bodyText.toLowerCase().includes('nasdaq');
  const screenshot = `./${path.replace('/', '') || 'root'}-panel.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ path, title: await page.title(), hasSkewTerm, screenshot }));
}

await browser.close();
