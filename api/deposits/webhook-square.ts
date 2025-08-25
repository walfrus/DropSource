// api/deposits/webhook-square.ts
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { buffer } from "micro";
import { sb } from "../../lib/db";

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["x-square-hmacsha256"] as string | undefined;
  const buf = await buffer(req);

  // verify signature
  const expected = crypto
    .createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string)
    .update(buf)
    .digest("base64");

  if (!sig || sig !== expected) {
    return res.status(400).json({ error: "bad signature" });
  }

  const body = JSON.parse(buf.toString("utf8"));

  // We care about payment events. Use reference_id to locate our deposit.
  const type = body?.type as string; // e.g., "payment.created" or "payment.updated"
  const payment = body?.data?.object?.payment;
  const ref = payment?.reference_id;        // we set this to deposit.id
  const status = payment?.status;           // e.g., "COMPLETED", "APPROVED", "CANCELED"

  if (!ref) return res.json({ ok: true });

  if (type === "payment.updated" || type === "payment.created") {
    if (status === "COMPLETED") {
      // mark deposit confirmed & credit wallet
      const { data: dep, error } = await sb
        .from("deposits")
        .update({ status: "confirmed", provider_id: payment?.id ?? null })
        .eq("id", ref)
        .select()
        .single();

      if (!error && dep) {
        await sb.rpc("wallet_credit", { user_id_input: dep.user_id, amount_cents_input: dep.amount_cents });
      }
    } else if (status === "CANCELED" || status === "FAILED") {
      await sb.from("deposits").update({ status: "failed", provider_id: payment?.id ?? null }).eq("id", ref);
    }
  }

  res.json({ ok: true });
}