import type { NextApiRequest, NextApiResponse } from "next";
import { callPanel } from "./_lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    // We simply proxy whatever the client sends. Typical fields:
    // service (number), link (string), quantity (number), runs, interval, comments, etc.
    const payload = req.body || {};
    if (!payload.service || !payload.link) {
      return res.status(400).json({ error: "missing service or link" });
    }

    const result = await callPanel("order", payload);
    return res.status(200).json(result);
  } catch (err: any) {
    console.error("order handler crashed:", err?.message || err);
    return res.status(500).json({ error: "internal" });
  }
}