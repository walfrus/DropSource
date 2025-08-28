// api/smm.ts — single endpoint for services / order / balance / status
// No external types/imports needed

export const config = { runtime: 'nodejs' };

// ---- env helpers ----
function numFromEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// normalize booleans coming back as 1/0/"1"/"0"/"yes"/"no"
function toBool(v: any): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return false;
  const t = String(v).trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'y';
}

// accept both PANEL_* and SMM_* naming
const PANEL_API_URL = process.env.PANEL_API_URL || process.env.SMM_API_URL || process.env.SMM_API || "";
const PANEL_API_KEY = process.env.PANEL_API_KEY || process.env.SMM_API_KEY || process.env.SMM_KEY || "";

// pricing knobs
const PRICE_MULTIPLIER = numFromEnv('PRICE_MULTIPLIER', 1);     // e.g. 1.25
const PRICE_FLAT_FEE   = numFromEnv('PRICE_FLAT_FEE', 0);       // add per 1k, e.g. 0.10
const PRICE_MIN_PER_1K = numFromEnv('PRICE_MIN_PER_1K', 0);     // optional floor, 0 = off
const PRICE_MAX_PER_1K = numFromEnv('PRICE_MAX_PER_1K', 0);     // optional ceiling, 0 = off

export default async function handler(req: any, res: any) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (!PANEL_API_URL || !PANEL_API_KEY) {
      return res.status(500).json({ error: "Missing PANEL_API_URL/SMM_API or PANEL_API_KEY/SMM_API_KEY" });
    }

    if (req.method === "GET") {
      const action = String(url.searchParams.get('action') || "");

      if (action === "services") {
        const raw = await callPanel({ action: "services" });
        // Panel *usually* returns an array. Sometimes it can wrap or error.
        const list = Array.isArray(raw) ? raw : (raw?.services ?? []);
        const q = String(url.searchParams.get('q') || "").toLowerCase();
        const cat = String(url.searchParams.get('category') || "").toLowerCase();

        const services = list
          .filter(Boolean)
          .map((s: any) => normalizeService(s))
          .filter((s: any) =>
            (!q || (s.name?.toLowerCase().includes(q) || s.category?.toLowerCase().includes(q))) &&
            (!cat || s.category?.toLowerCase().includes(cat)) // substring match (platforms like "Instagram - Likes")
          );

        res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
        return res.status(200).json(services);
      }

      if (action === "balance") {
        const data = await callPanel({ action: "balance" });
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        return res.status(200).json(data);
      }

      if (action === "status") {
        const order = String(url.searchParams.get('order') || "");
        if (!order) return res.status(400).json({ error: "Missing order id" });
        const data = await callPanel({ action: "status", order });
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const { action, service, link, quantity, runs, interval } = body || {};

      if (action === "add") {
        const svcId = Number(service);
        const href = String(link || '').trim();
        const qty = Number(quantity);
        if (!svcId || !href || !Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ error: "Missing or invalid params" });
        }
        const payload: any = { action: "add", service: svcId, link: href, quantity: qty };
        if (runs) payload.runs = runs;
        if (interval) payload.interval = interval;

        const data = await callPanel(payload);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: "Unknown or missing action in POST" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err: any) {
    // show something useful in Vercel logs
    console.error("smm handler error:", err?.message || err, err?.stack);
    return res.status(500).json({ error: "Server error", details: err?.message || String(err) });
  }
}

// ---- helpers ----

async function readJsonBody(req: any): Promise<any> {
  try {
    if (req.body != null) {
      if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch { return {}; }
      }
      return req.body;
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => resolve());
      req.on('error', reject);
    });
    if (!chunks.length) return {};
    const raw = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(raw); } catch { return {}; }
  } catch {
    return {};
  }
}

async function callPanel(params: Record<string, string | number>) {
  const form = new URLSearchParams({ key: PANEL_API_KEY, ...objToStr(params) });

  const r = await fetch(PANEL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json, text/plain, */*"
    },
    body: form as any,
  });

  const text = await r.text();

  // parse safely; if JSON fails, return the text so frontend can show a message
  try {
    const json = JSON.parse(text);
    // panels often return { error: '...' } with 200
    if (json && typeof json === 'object' && json.error) {
      if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${JSON.stringify(json)}`);
      return json; // bubble the error object up so UI can show it
    }
    if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${JSON.stringify(json).slice(0, 400)}`);
    return json;
  } catch (_) {
    if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
    // non-JSON success (rare) — return as string so UI can show error gracefully
    return { error: "Non-JSON response from panel", body: text.slice(0, 500) };
  }
}

function objToStr(o: Record<string, any>) {
  const out: Record<string, string> = {};
  for (const k in o) out[k] = String(o[k]);
  return out;
}

function applyPricing(basePer1k: number): number {
  let p = (basePer1k * PRICE_MULTIPLIER) + PRICE_FLAT_FEE;
  if (PRICE_MIN_PER_1K > 0) p = Math.max(p, PRICE_MIN_PER_1K);
  if (PRICE_MAX_PER_1K > 0) p = Math.min(p, PRICE_MAX_PER_1K);
  // normalize to a sane precision; UI will format toFixed(2)
  return Number.isFinite(p) ? Number(p.toFixed(6)) : 0;
}

function normalizeService(raw: any) {
  const rate = Number(raw.rate ?? raw.price ?? raw.price_per_1k ?? raw.pricePer1000 ?? raw.price_per_1000) || 0; // provider price per 1k
  const price = applyPricing(rate);
  return {
    id: Number(raw.service ?? raw.id ?? 0),
    name: `[DropSource] — ${clean(raw.name ?? raw.title ?? "Service")}`,
    category: clean(String(raw.category || "Other")),
    price_per_1k: price,
    min: Number(raw.min ?? raw.min_order) || 0,
    max: Number(raw.max ?? raw.max_order) || 0,
    dripfeed: toBool(raw.dripfeed ?? raw.drip),
    refill: toBool(raw.refill ?? raw.refill_time),
    description: String(raw.description || raw.desc || ""),
  };
}

function clean(s: string) {
  return String(s || '').replace(/smmgoal/gi, "DropSource").trim();
}