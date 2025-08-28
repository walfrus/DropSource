/// <reference types="node" />
/*
  Scrape SMMGoal services into a JSON list we can import.
  Run with:  npx tsx tools/scrape_smmgoals.ts

  ENV:
    MARKUP               -> multiplier (default 1.20)
    SMMGOALS_URLS        -> comma-separated list of category/listing URLs to visit (e.g. https://smmgoal.com/services)
    SMMGOAL_USERNAME     -> login username (preferred; use this if panel uses username)
    SMMGOAL_EMAIL        -> (optional) fallback if the panel specifically uses email
    SMMGOAL_PASSWORD     -> login password (required if the page requires auth)
    SMMGOAL_BASE         -> optional base URL (default https://smmgoal.com)
    HEADLESS             -> set to "0" to watch the browser, defaults to headless
*/
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { writeFile } from 'node:fs/promises';

// --- Types -----------------------------------------------------------------
export type Svc = {
  provider: 'smmgoals';
  code: string;
  name: string;
  rate_per_1k_cents: number;
  min: number;
  max: number;
  category?: string;
  our_price_cents?: number;
  remote_id?: string; // the panel service id, when we can detect it
};

// --- Helpers ---------------------------------------------------------------
const slug = (s: string) => s
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const parseCents = (n: string | number) => Math.max(0, Math.round(parseFloat(String(n).replace(/[^0-9.]/g, '')) * 100));
const toInt = (s: string | number | null | undefined) => {
  if (!s) return 0;
  const v = String(s).replace(/[^0-9]/g, '');
  return v ? parseInt(v, 10) : 0;
};

// Price extractor: `$12.34 / 1k`, `$12 / 1000`, or first money amount
function extractPricePer1kCents(text: string): number {
  const t = text.toLowerCase();
  let m = t.match(/([$€£])?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)?\s*(?:1k|1000)\b/);
  if (m) return parseCents(m[2]);
  m = t.match(/([$€£])\s*([0-9]+(?:\.[0-9]+)?)/); // first money amount as fallback
  return m ? parseCents(m[2]) : 0;
}

function extractMinMax(text: string): { min: number; max: number } {
  const t = text.toLowerCase();
  const minM = t.match(/min[^0-9]*([0-9,\s]+)/i);
  const maxM = t.match(/max[^0-9]*([0-9,\s]+)/i);
  const min = minM ? toInt(minM[1]) : 100;
  const max = maxM ? toInt(maxM[1]) : 100_000;
  return { min, max };
}

async function smartClick(page: Page, selector: string) {
  const el = page.locator(selector).first();
  if (await el.count()) {
    await el.click({ timeout: 10_000 }).catch(() => {});
  }
}

async function ensureLoggedIn(page: Page) {
  const BASE = process.env.SMMGOAL_BASE?.replace(/\/$/, '') || 'https://smmgoal.com';
  const username = process.env.SMMGOAL_USERNAME || process.env.SMMGOAL_EMAIL || '';
  const password = process.env.SMMGOAL_PASSWORD || '';

  // If no creds, just try to visit directly; some panels allow read-only access
  if (!username || !password) return;

  // Try a few likely login paths
  const loginPaths = ['/login', '/auth/login', '/signin', '/account/login'];
  let landed = false;
  for (const p of loginPaths) {
    try {
      await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      landed = true; break;
    } catch (_) {}
  }
  if (!landed) {
    // As a fallback, go to home and click any visible Login link
    await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await smartClick(page, 'a:has-text("Login"), a:has-text("Sign in"), a[href*="login" i]');
  }

  // Fill the form defensively
  const userSel = 'input[name="username" i], #username, input[type="text"], input[type="email"], input[name="email" i], #email';
  const passSel  = 'input[type="password"], input[name="password" i], #password';
  const btnSel   = 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), .btn-primary';

  if (await page.locator(userSel).count()) {
    await page.fill(userSel, username).catch(() => {});
  }
  if (await page.locator(passSel).count()) {
    await page.fill(passSel, password).catch(() => {});
  }
  await smartClick(page, btnSel);

  // Wait until the sidebar/menu is visible or we can reach /services
  await page.waitForLoadState('networkidle').catch(() => {});
  await Promise.race([
    page.locator('a:has-text("Services")').first().waitFor({ timeout: 10_000 }),
    page.waitForURL(/services/i, { timeout: 10_000 }).catch(() => {})
  ]).catch(() => {});
}

async function scrapeServicesFromCurrentPage(page: Page, categoryHint?: string): Promise<Svc[]> {
  const services: Svc[] = [];

  // Prefer a real table structure
  let rows = page.locator('table tbody tr');
  let useTable = await rows.count() > 5; // heuristic

  if (!useTable) {
    // Fallback to common row-like containers
    rows = page.locator('tr, .table-row, .service-row, .row');
  }

  // Track current category by scanning for obvious header rows (spanning & bold)
  let currentCategory = categoryHint || '';

  const rowCount = await rows.count();
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const rowText = (await row.textContent().catch(() => '')) || '';

    // Update category if the row looks like a section header
    if (/instagram|facebook|tiktok|twitter|youtube|soundcloud|spotify/i.test(rowText) && rowText.length < 120 && !rowText.includes('$')) {
      currentCategory = slug(rowText.trim());
    }

    // Try as a table first
    let id = (await row.locator('td:nth-child(1)').first().textContent().catch(() => ''))?.trim() || '';
    let name = (await row.locator('td:nth-child(2)').first().textContent().catch(() => ''))?.trim() || '';
    let priceStr = (await row.locator('td:nth-child(3)').first().textContent().catch(() => ''))?.trim() || '';
    let minStr = (await row.locator('td:nth-child(4)').first().textContent().catch(() => ''))?.trim() || '';
    let maxStr = (await row.locator('td:nth-child(5)').first().textContent().catch(() => ''))?.trim() || '';

    // If this doesn't look like a table row, try a generic card
    if (!name || name.length < 2) {
      const nameAlt = (await row.locator('h1, h2, h3, .title, .name, .service-title').first().textContent().catch(() => ''))?.trim();
      if (!nameAlt) continue;
      name = nameAlt;
      const block = rowText;
      const ratePer1kCents = extractPricePer1kCents(block);
      if (!ratePer1kCents) continue;
      const { min, max } = extractMinMax(block);
      const code = slug(`${currentCategory || 'misc'}_${name}`);
      services.push({
        provider: 'smmgoals',
        code,
        name,
        rate_per_1k_cents: ratePer1kCents,
        min,
        max,
        category: currentCategory || 'misc'
      });
      continue;
    }

    // Parse the more structured table-style row
    const ratePer1kCents = extractPricePer1kCents(priceStr) || parseCents(priceStr);
    const min = toInt(minStr);
    const max = toInt(maxStr);
    if (!ratePer1kCents || !name) continue;

    const code = slug(`${currentCategory || 'misc'}_${name}`);
    services.push({
      provider: 'smmgoals',
      code,
      name,
      rate_per_1k_cents: ratePer1kCents,
      min,
      max,
      category: currentCategory || 'misc',
      remote_id: id || undefined,
    });
  }

  return services;
}

(async () => {
  const MARKUP = parseFloat(process.env.MARKUP || '1.20');
  const BASE = process.env.SMMGOAL_BASE?.replace(/\/$/, '') || 'https://smmgoal.com';
  const urls = (process.env.SMMGOALS_URLS || `${BASE}/services`)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const headless = process.env.HEADLESS === '0' ? false : true;

  const out: Svc[] = [];
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (compatible; DropsourceBot/1.0; +https://drop-source.vercel.app)'
  });

  try {
    await ensureLoggedIn(page);

    for (const url of urls) {
      console.log('[scrape] Visiting', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      // Some panels lazy-load; scroll a bit to force render
      for (let k = 0; k < 5; k++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(300);
      }

      // Try to infer a category from a nearby title on the page
      const catTitle = (await page.locator('h1, h2, .category-title, title').first().textContent().catch(() => ''))?.trim() || 'services';
      const category = slug(catTitle) || 'services';

      const batch = await scrapeServicesFromCurrentPage(page, category);
      console.log(`[scrape] Found ${batch.length} services on this page`);
      out.push(...batch);
    }
  } finally {
    await browser.close();
  }

  const services: Svc[] = out
    .filter((s) => s.rate_per_1k_cents > 0 && s.name)
    .map((s) => ({
      ...s,
      our_price_cents: Math.max(1, Math.round(s.rate_per_1k_cents * MARKUP)),
    }))
    // de-dupe by code, keeping the cheapest rate we observed
    .reduce((acc: Svc[], cur) => {
      const existing = acc.find((x) => x.code === cur.code);
      if (!existing) acc.push(cur);
      else if (cur.rate_per_1k_cents < existing.rate_per_1k_cents) {
        Object.assign(existing, cur);
      }
      return acc;
    }, []);

  await writeFile('./smmgoals.services.json', JSON.stringify(services, null, 2));
  console.log(`[scrape] Wrote ${services.length} services to smmgoals.services.json`);
})().catch((err) => {
  console.error('[scrape] Failed:', err);
  process.exitCode = 1;
});