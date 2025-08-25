// api/services.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { callPanel, mapService } from "./_lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const raw = await callPanel("services");

    const list = Array.isArray(raw) ? raw : Array.isArray((raw as any).data) ? (raw as any).data : null;
    if (!list) {
      console.error("Unexpected services payload:", raw);
      return res.status(502).json({ error: "unexpected upstream payload" });
    }

    return res.json(list.map(mapService));
  } catch (err: any) {
    console.error("services handler crashed:", err?.message || err);
    return res.status(500).json({ error: "internal" });
  }
}