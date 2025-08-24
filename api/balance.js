import { callPanel } from "./_lib.js";
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  try { res.status(200).json(await callPanel("balance", {}, process.env)); }
  catch (e) { res.status(500).json({ error: "balance_failed", detail: String(e.message || e) }); }
}