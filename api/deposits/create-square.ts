// api/deposits/create-square.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { sb } from "../../lib/db";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  // You already have a “soft auth” getUser helper — use whatever you wired:
  const user = { id: req.headers["x-user-id"] as string, email: req.headers["x-user-email"] as string };
  if (!user?.id) return res.status(401).json({ error: "no user" });

  const cents = Number(req.body?.amount_cents);
  if (!Number.isFinite(cents) || cents < 100) {
    return res.status(400).json({ error: "min $1.00" });
  }

  // 1) make a pending deposit row
  const { data: dep, error } = await sb.from("deposits").insert({
    user_id: user.id,
    method: "square",
    amount_cents: cents,
    status: "pending",
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });

  // 2) Create a Payment Link
  const r = await fetch("https://connect.squareup.com/v2/online-checkout/payment-links", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-06-20",
    },
    body: JSON.stringify({
      idempotency_key: `${dep.id}-${Date.now()}`,
      quick_pay: {
        name: "DropSource Credits",
        price_money: { amount: cents, currency: "USD" },
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: String(dep.id), // <-- we’ll read this in the webhook
      },
      checkout_options: {
        redirect_url: `${process.env.PUBLIC_URL}/balance?ok=1`,
      }
    }),
  });

  const json = await r.json();
  if (!r.ok) return res.status(400).json({ error: json.errors?.[0]?.detail || "square failed" });

  // 3) return the hosted link
  return res.json({ url: json.payment_link?.url });
}