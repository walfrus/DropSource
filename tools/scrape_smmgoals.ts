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
import type { Page, Locator } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

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

// --- Output & timebox ------------------------------------------------------
const OUT_FILE = process.env.OUT_FILE || './smmgoals.services.json';
const TIMEBOX_MS = (() => { const n = Number(process.env.TIMEBOX_MS || 0); return Number.isFinite(n) && n > 0 ? n : 240_000; })();

async function writeOut(raw: Svc[]) {
  // Normalize, apply markup, and de-dup by lowest rate per 1k
  const services: Svc[] = raw
    .filter((s) => s.rate_per_1k_cents > 0 && s.name)
    .map((s) => ({
      ...s,
      our_price_cents: Math.max(
        1,
        Math.round(
          s.rate_per_1k_cents *
            (parseFloat(process.env.MARKUP || '1.20') || 1.2)
        )
      ),
    }))
    .reduce((acc: Svc[], cur) => {
      const existing = acc.find((x) => x.code === cur.code);
      if (!existing) acc.push(cur);
      else if (cur.rate_per_1k_cents < existing.rate_per_1k_cents)
        Object.assign(existing, cur);
      return acc;
    }, []);

  // Ensure directory exists
  await mkdir(path.dirname(OUT_FILE), { recursive: true }).catch(() => {});

  // JSON output (unchanged structure)
  await writeFile(OUT_FILE, JSON.stringify(services, null, 2));

  // CSV output with your requested order/columns
  const outCsv =
    OUT_FILE.endsWith('.json')
      ? OUT_FILE.replace(/\.json$/i, '.csv')
      : OUT_FILE + '.csv';

  const toCsvRow = (fields: (string | number)[]) =>
    fields
      .map((f) => `"${String(f).replace(/"/g, '""')}"`)
      .join(',');

  const header = toCsvRow(['name', 'rate_per_1k_usd', 'min', 'max']);
  const rows = services.map((s) =>
    toCsvRow([
      s.name,
      (s.rate_per_1k_cents / 100).toFixed(2),
      s.min,
      s.max,
    ])
  );
  await writeFile(outCsv, [header, ...rows].join('\n'));

  console.log(
    `[scrape] Wrote ${services.length} services → ${OUT_FILE} and ${outCsv}`
  );
}

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

// Helper: Try selectors in order, return first non-empty textContent
async function cellText(row: Locator, selectors: string[]): Promise<string> {
  for (const sel of selectors) {
    const loc = row.locator(sel).first();
    try {
      if (await loc.count()) {
        const raw = await loc.textContent();
        const t = (raw ?? '').trim();
        if (t) return t;
      }
    } catch {}
  }
  return '';
}

// Price extractor: `$12.34 / 1k`, `$12 / 1000`, or first money amount, also accepts bare numbers and "USD"
function extractPricePer1kCents(text: string): number {
  const t = String(text || '').toLowerCase();
  let m = t.match(/([$€£])?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)?\s*(?:1k|1000)\b/);
  if (m) return parseCents(m[2]);
  m = t.match(/\b([0-9]+(?:\.[0-9]+)?)\s*usd\b/);
  if (m) return parseCents(m[1]);
  m = t.match(/([$€£])\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) return parseCents(m[2]);
  m = t.match(/\b([0-9]+(?:\.[0-9]+)?)\b/); // bare number (assume per 1k)
  return m ? parseCents(m[1]) : 0;
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
    if (!hasPass) { console.log('[scrape] already logged in (no password field)'); return; }
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

  // Try to detect table rows first
  let rows = page.locator('table tbody tr:has(td)');
  let useTable = await rows.count() >= 3;

  if (!useTable) {
    rows = page.locator('table tr:has(td), .service-row, .services-row, .services-list .row, .pricing-table tr');
  }

  let currentCategory = categoryHint || '';
  const rowCount = await rows.count();
  console.log(`[parse] rows on page: ${rowCount} (useTable=${useTable})`);

  // If the table has headers, map them to indexes so we can pick the right columns regardless of order.
  let headerMap: Record<string, number> = {};
  try {
    const heads = await page.locator('table thead th').allTextContents();
    heads.forEach((h, i) => {
      const k = h.trim().toLowerCase();
      if (!k) return;
      if (k.includes('service') || k.includes('name')) headerMap.service = i + 1; // nth-child is 1-based
      if (k.includes('rate') || k.includes('price')) headerMap.price = i + 1;
      if (k.includes('min')) headerMap.min = i + 1;
      if (k.includes('max')) headerMap.max = i + 1;
      if (k.includes('id')) headerMap.id = i + 1;
    });
  } catch {}

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const rowText = (await row.textContent().catch(() => '')) || '';

    // Update category if the row looks like a header-only line
    if (/instagram|facebook|tiktok|twitter|youtube|soundcloud|spotify|discord|whatsapp|reddit|linkedin|telegram/i.test(rowText) && rowText.length < 160 && !/\$|\d\s*\/\s*1k/i.test(rowText)) {
      currentCategory = slug(rowText.trim());
    }

    // Flexible cell resolution (tries data-label/data-title first, then header-mapped nth-child, then generic positions)
    const id = await cellText(row, [
      'td[data-label*="id" i]', 'td[data-title*="id" i]',
      headerMap.id ? `td:nth-child(${headerMap.id})` : 'td:nth-child(1)'
    ]);

    const name = await cellText(row, [
      'td[data-label*="service" i]', 'td[data-title*="service" i]', 'td .service-title', 'td .title',
      headerMap.service ? `td:nth-child(${headerMap.service})` : 'td:nth-child(2)'
    ]);
    if (!name) continue; // skip non-service rows

    const priceStr = await cellText(row, [
      'td[data-label*="rate" i]', 'td[data-label*="price" i]', 'td[data-title*="rate" i]', 'td[data-title*="price" i]', 'td:has-text("$")',
      headerMap.price ? `td:nth-child(${headerMap.price})` : 'td:nth-child(3)'
    ]);

    const minStr = await cellText(row, [
      'td[data-label*="min" i]', 'td[data-title*="min" i]',
      headerMap.min ? `td:nth-child(${headerMap.min})` : 'td:nth-child(4)'
    ]);

    const maxStr = await cellText(row, [
      'td[data-label*="max" i]', 'td[data-title*="max" i]',
      headerMap.max ? `td:nth-child(${headerMap.max})` : 'td:nth-child(5)'
    ]);

    // Price parsing: accept "$x / 1k", "$x", or bare numbers (many panels show rate per 1k without currency)
    let ratePer1kCents = extractPricePer1kCents(priceStr);
    if (!ratePer1kCents) ratePer1kCents = parseCents(priceStr);

    // If still zero, try to sniff a bare number from any cell that looks price-ish
    if (!ratePer1kCents) {
      const alt = await cellText(row, ['td:has-text("/ 1k")', 'td:has-text("1k")', 'td:has-text("1000")']);
      if (alt) ratePer1kCents = extractPricePer1kCents(alt) || parseCents(alt);
    }

    if (!ratePer1kCents) continue;

    const min = toInt(minStr) || extractMinMax(rowText).min;
    const max = toInt(maxStr) || extractMinMax(rowText).max;

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

async function fallbackScrape(page: Page, categoryHint?: string): Promise<Svc[]> {
  // Use a raw function string to avoid esbuild/tsx injecting __name helpers in the browser context.
  const browserFnSource = `
    (function(catHint){
      const slug = (s) => String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      const toInt = (s) => {
        const v = String(s || '').replace(/[^0-9]/g, '');
        return v ? parseInt(v, 10) : 0;
      };

      const extractPrice = (s) => {
        const t = String(s || '').toLowerCase();
        let m = t.match(/([0-9]+(?:\\.[0-9]+)?)\\s*(?:\\/|per)?\\s*(?:1k|1000)\\b/);
        if (m) return Math.round(parseFloat(m[1]) * 100);
        m = t.match(/([$€£])\\s*([0-9]+(?:\\.[0-9]+)?)/);
        if (m) return Math.round(parseFloat(m[2]) * 100);
        m = t.match(/\\b([0-9]+(?:\\.[0-9]+)?)\\b/);
        return m ? Math.round(parseFloat(m[1]) * 100) : 0;
      };

      const out = [];
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const heads = Array.from(table.querySelectorAll('thead th'))
          .map(th => (th.textContent || '').trim().toLowerCase());

        const idx = {
          id: (heads.findIndex(h => /\\bid\\b/.test(h)) + 1) || 1,
          name: (heads.findIndex(h => /(service|name)/.test(h)) + 1) || 2,
          price: (heads.findIndex(h => /(rate|price)/.test(h)) + 1) || 3,
          min: (heads.findIndex(h => /min/.test(h)) + 1) || 4,
          max: (heads.findIndex(h => /max/.test(h)) + 1) || 5,
        };

        const rows = Array.from(table.querySelectorAll('tbody tr'));
        for (const tr of rows) {
          const td = (n) => {
            const el = tr.querySelector(\`td:nth-child(\${n})\`);
            // prefer innerText to mimic what you see; fallback to textContent
            return (el && (el.innerText || el.textContent) || '').trim();
          };

          const name = td(idx.name) ||
            ((tr.querySelector('td[data-label*="service" i]') || {}).innerText || '').trim() ||
            ((tr.querySelector('td[data-title*="service" i]') || {}).innerText || '').trim();

          if (!name) continue;

          const priceStr = td(idx.price) ||
            ((tr.querySelector('td[data-label*="rate" i], td[data-label*="price" i]') || {}).innerText || '').trim() ||
            ((tr.querySelector('td[data-title*="rate" i], td[data-title*="price" i]') || {}).innerText || '').trim();

          const price = extractPrice(priceStr);
          if (!price) continue;

          const min = toInt(td(idx.min) ||
            ((tr.querySelector('td[data-label*="min" i]') || {}).innerText || '') ||
            ((tr.querySelector('td[data-title*="min" i]') || {}).innerText || '')) || 100;

          const max = toInt(td(idx.max) ||
            ((tr.querySelector('td[data-label*="max" i]') || {}).innerText || '') ||
            ((tr.querySelector('td[data-title*="max" i]') || {}).innerText || '')) || 100000;

          out.push({
            provider: 'smmgoals',
            code: \`\${slug(catHint || 'services')}_\${slug(name)}\`,
            name,
            rate_per_1k_cents: price,
            min,
            max,
            category: slug(catHint || 'services')
          });
        }
      }
      return out;
    })
  `;

  // Build a real Function so Playwright serializes a clean function without esbuild helpers.
  const browserFn = new Function('catHint', `return (${browserFnSource})(catHint);`) as (catHint?: string) => any;

  const items = await page.evaluate(browserFn, categoryHint);
  return items as unknown as Svc[];
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

  let timebox: NodeJS.Timeout | null = setTimeout(async () => {
    console.warn('[scrape] TIMEBOX hit — writing whatever we collected so far');
    try { await writeOut(out); } catch {}
    try { await context.close(); } catch {}
    process.exit(0);
  }, TIMEBOX_MS);
  const clearBox = () => { if (timebox) { clearTimeout(timebox); timebox = null; } };

  try {
    await ensureLoggedIn(page);
    console.log('[scrape] login step done');

    for (const url of urls) {
      console.log('[scrape] Visiting', url);
      await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      const rcTable = await page.locator('table tbody tr:has(td)').count().catch(()=>0);
      const rcCustom = await page.locator('.service-row, .services-list .row').count().catch(()=>0);
      console.log(`[scrape] initial row candidates: table=${rcTable} custom=${rcCustom}`);

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

      let got: Svc[] = [];
      // FAST PATH: if the table is huge, use the in-page parser to avoid thousands of roundtrips
      if (rcTable >= 800 || rcCustom >= 800) {
        console.log('[scrape] Large table detected — switching to fast in-page parser');
        got = await fallbackScrape(page, category);
      } else {
        const batch = await scrapeServicesFromCurrentPage(page, category);
        got = batch;
        if (!got.length) {
          console.log('[scrape] Primary parser found 0 services — trying fallback parser');
          got = await fallbackScrape(page, category);
        }
      }

      console.log(`[scrape] Found ${got.length} services on this page`);
      if (!got.length) {
        await page.screenshot({ path: `.playwright/no-services-${Date.now()}.png`, fullPage: true }).catch(()=>{});
        console.log('[scrape] WARN: 0 services parsed on this page, wrote a debug screenshot.');
      }
      out.push(...got);
    }
  } finally {
    await context.close();
  }

  await writeOut(out);
  clearBox();
})().catch(async (err) => {
  console.error('[scrape] Failed:', err);
  try { await mkdir(path.dirname(OUT_FILE), { recursive: true }); } catch {}
  try { await writeFile('.playwright/error.txt', String(err)); } catch {}
  try { await writeFile(OUT_FILE, JSON.stringify([], null, 2)); } catch {}
  process.exitCode = 1;
});