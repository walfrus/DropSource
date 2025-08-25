// /api/services.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { callPanel, mapService } from "./_lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  try {
    // most SMM panels want POST even for "services" (some allow GET)
    const raw = await callPanel("services");

    const list = Array.isArray(raw?.data) ? raw.data : raw; // be defensive
    if (!Array.isArray(list)) {
      console.error("Unexpected services payload:", raw);
      return res.status(502).json({ error: "unexpected_upstream" });
    }

    return res.status(200).json(list.map(mapService));
  } catch (err: any) {
    console.error("services handler crashed:", err?.message || err);
    return res.status(500).json({ error: "internal" });
  }
}