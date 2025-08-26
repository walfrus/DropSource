// Returns (and ensures) the user's wallet

import { getSb, ensureUserAndWallet } from "../../api/__lib.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const uid = String(req.headers["x-user-id"] || "");
  const email = (req.headers["x-user-email"] || "") as string;
  if (!uid) return res.status(400).json({ error: "missing user id" });

  const sb = getSb();
  await ensureUserAndWallet(sb, { id: uid, email });

  const { data: w } = await sb.from("wallets").select("balance_cents,currency").eq("user_id", uid).single();

  res.status(200).json({
    balance_cents: w?.balance_cents ?? 0,
    currency: w?.currency ?? "usd",
  });
}