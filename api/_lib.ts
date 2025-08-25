// api/_lib.ts

/**
 * POST helper for SMM panel APIs.
 * Most panels expect: key, action, plus any extra params, with
 * application/x-www-form-urlencoded encoding.
 */
export async function callPanel(
  action: string,
  extra: Record<string, string | number | boolean> = {}
) {
  const url = process.env.SMM_API_URL || '';
  const key = process.env.SMM_API_KEY || '';

  if (!url || !key) {
    throw new Error('SMM_API_URL or SMM_API_KEY missing');
  }

  const body = new URLSearchParams({
    key,
    action,
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, String(v)])
    ),
  });

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Panel error ${r.status}: ${text.slice(0, 200)}`);
  }

  // Panel sometimes returns non-JSON during outages. Try JSON first.
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // Fallback: caller can decide what to do (we’ll treat as error upstream)
    throw new Error(`Panel returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Normalize a raw service row from the panel into a consistent shape
 * the UI expects.
 */
export function mapService(s: any) {
  // Typical panel keys:
  // service,id, name, category, rate, min, max, dripfeed, refill, type...
  const price = Number(s.rate ?? s.price ?? 0);

  return {
    id: s.service ?? s.id,
    name: String(s.name ?? s.service ?? 'Unnamed'),
    category: String(s.category ?? 'Other'),
    price_per_1k: isNaN(price) ? 0 : price,
    min: Number(s.min ?? s.min_order ?? 0),
    max: Number(s.max ?? s.max_order ?? 0),
    dripfeed: Boolean(s.dripfeed ?? s.dripfeed_enabled ?? s.drip ?? false),
    refill: Boolean(s.refill ?? s.refill_enabled ?? false),
    // keep any other raw fields if you need them later:
    _raw: s,
  };
}