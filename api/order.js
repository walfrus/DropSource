import { callPanel } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { service, link, quantity, runs, interval } = req.body || {};
    if (!service || !link || !quantity) return res.status(400).json({ error: "missing_fields" });
    const extra = { service, link, quantity, ...(runs?{runs}:{}) , ...(interval?{interval}:{}) };
    const data = await callPanel("add", extra, process.env);
    if (data.error) return res.status(400).json({ error: data.error });
    res.status(200).json({ order: data.order });
  } catch (e) { res.status(500).json({ error: "order_failed", detail: String(e.message || e) }); }
}