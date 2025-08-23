// --- pricing brain ---
// base = panel rate per 1k
function calcPrice(base) {
  base = Number(base || 0);
  if (!isFinite(base) || base <= 0) return 0;

  // Tiered markup: smaller for expensive services, bigger for cheap ones.
  let mult, add;
  if (base < 1)        { mult = 2.2; add = 0.25; }   // hooks: likes/views etc.
  else if (base < 5)   { mult = 2.0; add = 0.25; }   // bread & butter followers
  else if (base < 20)  { mult = 1.6; add = 0.50; }   // mid-tier
  else if (base < 100) { mult = 1.35; add = 1.00; }  // premium
  else if (base < 300) { mult = 1.20; add = 2.00; }  // high-end
  else                 { mult = 1.12; add = 4.00; }  // ultra-premium/combos

  // Compute candidate
  let out = base * mult + add;

  // Safety: never undercut panel (add at least +5%) and avoid rounding to panel
  const floor = base * 1.05;
  if (out < floor) out = floor;

  // Clean psychology
  out = Math.max(out, 0.99);
  return Number(out.toFixed(2));
}

function toPublicService(s) {
  const baseRatePer1k = parseFloat(s.rate ?? s['rate(1k)'] ?? s.price ?? 0);
  const yourRatePer1k = calcPrice(baseRatePer1k);

  return {
    id: s.service ?? s.id,
    name: s.name ?? s.title ?? 'Service',
    category: s.category ?? s['service_category'] ?? 'General',
    min: Number(s.min || 0),
    max: Number(s.max || 0),
    dripfeed: Boolean(s.dripfeed) || s['dripfeed'] === 'true',
    refill: Boolean(s.refill) || s['refill'] === 'true',
    cancel: Boolean(s.cancel) || s['cancel'] === 'true',
    panel_rate_per_1k: baseRatePer1k,
    price_per_1k: yourRatePer1k,
    tier:
      baseRatePer1k < 20 ? 'Budget'
      : baseRatePer1k < 100 ? 'Premium'
      : 'Specialty',
    details: s.description || s.note || ''
  };
}