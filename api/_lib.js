import axios from "axios";

export async function callPanel(action, extra, env) {
  const body = new URLSearchParams({ key: env.PANEL_API_KEY, action, ...extra });
  const { data } = await axios.post(env.PANEL_API_URL, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000
  });
  return data;
}

const clean = (s="") => s.replace(/smmgoal/gi,"").replace(/🔥|💎|⚡️|⭐️/g,"").replace(/\s+/g," ").trim();

export function priceOf(base0) {
  const base = +base0 || 0;
  if (base <= 0) return 0.99;
  let mult, add;
  if (base < 1) { mult = 2.2; add = 0.25; }
  else if (base < 5) { mult = 2.0; add = 0.25; }
  else if (base < 20) { mult = 1.6; add = 0.50; }
  else if (base < 100) { mult = 1.35; add = 1.00; }
  else if (base < 300) { mult = 1.20; add = 2.00; }
  else { mult = 1.12; add = 4.00; }
  let out = base * mult + add;
  const floor = base * 1.05; // never below provider
  if (out < floor) out = floor;
  return +out.toFixed(2);
}

export function mapService(raw) {
  const base = parseFloat(raw.rate ?? raw["rate(1k)"] ?? raw.price ?? 0) || 0;
  return {
    id: raw.service ?? raw.id,
    name: `DropSource — ${clean(raw.name ?? raw.title ?? "Service")}`,
    category: clean(raw.category ?? raw["service_category"] ?? "General"),
    min: +raw.min || 0,
    max: +raw.max || 0,
    dripfeed: !!(raw.dripfeed || raw["dripfeed"] === "true"),
    refill: !!(raw.refill || raw["refill"] === "true"),
    cancel: !!(raw.cancel || raw["cancel"] === "true"),
    panel_rate_per_1k: base,
    price_per_1k: priceOf(base),
    details: clean(raw.description || raw.note || "")
  };
}