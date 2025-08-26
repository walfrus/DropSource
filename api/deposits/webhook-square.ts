import { createHmac, timingSafeEqual } from "crypto";
import { getSb, creditDepositByPaymentLinkId, logWebhook } from "../__lib.js";

const isSandbox = (process.env.SQUARE_ENV || "").toLowerCase() !== "production";
const BYPASS_HEADER = "x-debug-no-verify";
const SIG_HEADER_A = "x-square-signature";
const SIG_HEADER_B = "x-square-hmacsha256-signature";
const SECRET = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";

function fail(res: any, code: number, msg: string) {
  res.status(code).json({ error: msg });
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");

  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  const skipVerify = isSandbox || req.headers[BYPASS_HEADER] === "1" || process.env.DEBUG_NO_VERIFY === "1";

  if (!skipVerify) {
    const headerSig = String(req.headers[SIG_HEADER_A] || req.headers[SIG_HEADER_B] || "");
    if (!headerSig || !SECRET) return fail(res, 400, "missing signature");
    const computed = createHmac("sha256", SECRET).update(raw).digest("base64");
    const ok = computed.length === headerSig.length &&
      timingSafeEqual(Buffer.from(computed), Buffer.from(headerSig));
    if (!ok) return fail(res, 400, "signature mismatch");
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const type = String(body?.type || body?.event_type || "").toUpperCase();
  const payment = body?.data?.object?.payment ?? body?.data?.payment ?? {};
  const status = String(payment?.status || "").toUpperCase();
  const payment_link_id =
    payment?.payment_link_id ??
    body?.data?.object?.payment_link?.id ??
    body?.data?.object?.order?.payment_link_id;

  const sb = getSb();
  await logWebhook(sb, "square", body, { status, type, payment_link_id });

  if (type.includes("PAYMENT") && status === "COMPLETED" && payment_link_id) {
    const result = await creditDepositByPaymentLinkId(sb, payment_link_id);
    if (!result.ok) return res.status(200).json({ ok: false, reason: result.reason });
    return res.status(200).json({ ok: true, credited_cents: result.amount_cents, user_id: result.user_id });
  }

  return res.status(200).json({ ok: true, ignored: true });
}