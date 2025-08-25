// api/smm.ts — single endpoint for services / order / balance / status
// No external types/imports needed

const PANEL_API_URL = process.env.PANEL_API_URL || "";
const PANEL_API_KEY = process.env.PANEL_API_KEY || "";

export default async function handler(req: any, res: any) {
  try {
    if (!PANEL_API_URL || !PANEL_API_KEY) {
      return res.status(500).json({ error: "Missing PANEL_API_URL or PANEL_API_KEY" });
    }

    if (req.method === "GET") {
      const action = String(req.query.action || "");

      if (action === "services") {
        const raw = await callPanel({ action: "services" });
        // Panel *usually* returns an array. Sometimes it can wrap or error.
        const list = Array.isArray(raw) ? raw : (raw?.services ?? []);
        const q = String(req.query.q || "").toLowerCase();
        const cat = String(req.query.category || "");

        const services = list
          .filter(Boolean)
          .map((s: any) => normalizeService(s))
          .filter((s: any) =>
            (!q || (s.name?.toLowerCase().includes(q) || s.category?.toLowerCase().includes(q))) &&
            (!cat || s.category === cat)
          );

        res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
        return res.status(200).json(services);
      }

      if (action === "balance") {
        const data = await callPanel({ action: "balance" });
        return res.status(200).json(data);
      }

      if (action === "status") {
        const order = String(req.query.order || "");
        if (!order) return res.status(400).json({ error: "Missing order id" });
        const data = await callPanel({ action: "status", order });
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    if (req.method === "POST") {
      const { action, service, link, quantity, runs, interval } = req.body || {};

      if (action === "add") {
        if (!service || !link || !quantity) {
          return res.status(400).json({ error: "Missing required params" });
        }
        const payload: any = { action: "add", service, link, quantity };
        if (runs) payload.runs = runs;
        if (interval) payload.interval = interval;

        const data = await callPanel(payload);
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

async function callPanel(params: Record<string, string | number>) {
  const form = new URLSearchParams({ key: PANEL_API_KEY, ...objToStr(params) });

  const r = await fetch(PANEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form as any,
  });

  const text = await r.text();

  // parse safely; if JSON fails, return the text so frontend can show a message
  try {
    const json = JSON.parse(text);
    if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${JSON.stringify(json)}`);
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

function normalizeService(raw: any) {
  const price = Number(raw.rate) || 0;
  return {
    id: Number(raw.service),
    name: `[DropSource] — ${clean(raw.name ?? raw.title ?? "Service")}`,
    category: raw.category || "Other",
    price_per_1k: price,
    min: Number(raw.min) || 0,
    max: Number(raw.max) || 0,
    dripfeed: Boolean(raw.dripfeed),
    refill: Boolean(raw.refill),
    description: String(raw.description || raw.desc || ""),
  };
}

function clean(s: string) {
  return s.replace(/smmgoal/gi, "DropSource").trim();
}