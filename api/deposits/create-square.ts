// api/deposits/create-square.ts
import { randomBytes } from "crypto";
import { getSb, ensureUserAndWallet, recordDeposit } from "../wallet/_lib.js";

const isSandbox =
  (process.env.SQUARE_ENV ?? "sandbox").toLowerCase() !== "production";
const BASE = isSandbox
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN!;

type SquarePaymentLinkResponse = {
  payment_link?: { url?: string; id?: string };
  errors?: unknown;
};

function fail(res: any, code: number, msg: string) {
  res.status(code).json({ error: msg });
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");

  try {
    const uid = String(req.headers["x-user-id"] || "");
    const email = (req.headers["x-user-email"] || "") as string;
    if (!uid) return fail(res, 400, "missing user id");

    const amount_cents = Number(req.body?.amount_cents ?? 0);
    if (!Number.isFinite(amount_cents) || amount_cents <= 0) {
      return fail(res, 400, "invalid amount_cents");
    }

    const sb = getSb();
    await ensureUserAndWallet(sb, { id: uid, email });

    // location
    const locResp = await fetch(`${BASE}/v2/locations`, {
      method: "GET",
      headers: {
        "Square-Version": "2024-06-20",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    const locJson = (await locResp.json()) as any;
    const location_id =
      locJson?.locations?.find((l: any) => l.status === "ACTIVE")?.id ??
      locJson?.locations?.[0]?.id;
    if (!location_id) return fail(res, 500, "no_location");

    // redirect back to balance page
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host = req.headers["host"] as string;
    const redirectUrl = new URL(`${proto}://${host}/balance.html`);
    redirectUrl.searchParams.set("ok", "1");
    redirectUrl.searchParams.set("uid", uid);
    if (email) redirectUrl.searchParams.set("email", email);

    const payload = {
      idempotency_key: randomBytes(16).toString("hex"),
      quick_pay: {
        name: "Wallet Deposit",
        price_money: { amount: amount_cents, currency: "USD" },
        location_id,
      },
      checkout_options: { redirect_url: redirectUrl.toString() },
    };

    const resp = await fetch(`${BASE}/v2/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        "Square-Version": "2024-06-20",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = (await resp.json()) as SquarePaymentLinkResponse;
    if (!resp.ok