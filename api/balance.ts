import type { NextApiRequest, NextApiResponse } from "next";
import { callPanel } from "./_lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    const result = await callPanel("balance");
    return res.status(200).json(result);
  } catch (err: any) {
    console.error("balance handler crashed:", err?.message || err);
    return res.status(500).json({ error: "internal" });
  }
}