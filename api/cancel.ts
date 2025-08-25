import type { NextApiRequest, NextApiResponse } from "next";
import { callPanel } from "./_lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: "missing order_id" });

    const result = await callPanel("cancel", { order_id });
    return res.status(200).json(result);
  } catch (err: any) {
    console.error("cancel handler crashed:", err?.message || err);
    return res.status(500).json({ error: "internal" });
  }
}