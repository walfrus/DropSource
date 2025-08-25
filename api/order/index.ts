// api/order/index.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { sb } from "../../lib/db";
import { getUser } from "../../lib/auth";
import { ensureUserAndWallet, callPanel } from "../_lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  try {
    await ensureUserAndWallet(user);

    const { service, link, quantity, runs, interval, comments } = req.body || {};
    if (!service || !link || !quantity) {
      return res.status(400).json({ error: "missing fields" });
    }

    // figure out the cost from the service (1k price * qty/1000)
    const { data: svc } = await sb.from("services_cache") // if you cached services
      .select("price_per_1k")
      .eq("id", service)
      .single();

    if (!svc) {
      return res.status(400).json({ error: "unknown service" });
    }

    const costCents = Math.round((svc.price_per_1k / 1000) * quantity * 100);

    // check wallet
    const { data: wallet } = await sb.from("wallets")
      .select("balance_cents")
      .eq("user_id", user.id)
      .single();

    if (!wallet || wallet.balance_cents < costCents) {
      return res.status(400).json({ error: "insufficient_balance" });
    }

    // debit wallet first
    await sb.from("wallets")
      .update({ balance_cents: wallet.balance_cents - costCents })
      .eq("user_id", user.id);

    // place order with panel
    const panelResp = await callPanel("add", {
      service,
      link,
      quantity,
      runs,
      interval,
      comments,
    });

    // record order in db (optional)
    await sb.from("orders").insert({
      user_id: user.id,
      service_id: service,
      link,
      quantity,
      cost_cents: costCents,
      provider_order_id: panelResp.order ?? null,
    });

    return res.status(200).json({ ok: true, panel: panelResp });
  } catch (err: any) {
    console.error("order handler crashed:", err?.message || err);
    return res.status(500).json({ error: "internal" });
  }
}