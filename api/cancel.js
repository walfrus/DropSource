import { callPanel } from "./_lib.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try { res.status(200).json(await callPanel("cancel", { orders: (req.body||{}).orders }, process.env)); }
  catch (e) { res.status(500).json({ error: "cancel_failed", detail: String(e.message || e) }); }
}