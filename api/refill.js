import { callPanel } from "./_lib.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try { res.status(200).json(await callPanel("refill", { order: (req.body||{}).order }, process.env)); }
  catch (e) { res.status(500).json({ error: "refill_failed", detail: String(e.message || e) }); }
}