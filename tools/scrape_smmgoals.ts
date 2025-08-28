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
    PLAYWRIGHT_PROFILE_DIR -> optional dir to store a persistent session (default .playwright/smmgoal)
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

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
const WAIT_UNTIL: WaitUntil = (process.env.WAIT_UNTIL as WaitUntil) || 'domcontentloaded';

async function ensureLoggedIn(page: Page) {
  // First try hitting /services directly; if already logged-in, bail early
  try {
    await page.goto(`${process.env.SMMGOAL_BASE?.replace(/\/$/, '') || 'https://smmgoal.com'}/services`, { waitUntil: WAIT_UNTIL, timeout: 30_000 });
    // If there's no password field visible, assume we're in
    const hasPass = await page.locator('input[type="password"], input[name="password" i], #password').first().count();
    if (!hasPass) return;
  } catch {}

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
      await page.goto(`${BASE}${p}`, { waitUntil: WAIT_UNTIL, timeout: 30_000 });
      landed = true; break;
    } catch (_) {}
  }
  if (!landed) {
    // As a fallback, go to home and click any visible Login link
    await page.goto(BASE, { waitUntil: WAIT_UNTIL }).catch(() => {});
    await smartClick(page, 'a:has-text("Login"), a:has-text("Sign in"), a[href*="login" i]');
  }

  // If Cloudflare / bot check appears, give it time
  if (await page.locator('text=Just a moment, text=Checking your browser').first().count()) {
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
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
  const userDir = process.env.PLAYWRIGHT_PROFILE_DIR || '.playwright/smmgoal';
  const context = await chromium.launchPersistentContext(userDir, {
    headless,
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  });
  await context.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  const page = await context.newPage();
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));

  try {
    await ensureLoggedIn(page);

    for (const url of urls) {
      console.log('[scrape] Visiting', url);
      await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      // Try to ensure some service DOM is present; if not, take a debug shot
      await page.locator('table, .service-row, tr').first().waitFor({ timeout: 15_000 }).catch(() => {});
      await page.screenshot({ path: '.playwright/after-goto.png', fullPage: true }).catch(() => {});

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
    await context.close();
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
})().catch(async (err) => {
  console.error('[scrape] Failed:', err);
  try { await writeFile('.playwright/error.txt', String(err)); } catch {}
  process.exitCode = 1;
});