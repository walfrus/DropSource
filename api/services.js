import { callPanel, mapService } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const data = await callPanel("services", {}, process.env);
    const arr = Array.isArray(data) ? data : data.services || [];
    let out = arr.map(mapService);

    const q = (req.query.q || "").toString().toLowerCase();
    const cat = (req.query.category || "").toString().toLowerCase();
    if (cat) out = out.filter(s => (s.category || "").toLowerCase() === cat);
    if (q) out = out.filter(s => (s.name + " " + s.category).toLowerCase().includes(q));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: "services_failed", detail: String(e.message || e) });
  }
}