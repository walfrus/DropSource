// api/deposits/webhook-square.ts
// Verifies Square webhook signature and credits the wallet on COMPLETED.

import crypto from 'crypto';
import { sb } from '../../lib/db';

export const config = { api: { bodyParser: false } };

function readRaw(req: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Square signs: base64( HMAC_SHA256( notificationURL + rawBody ) )
function webhookValid(req: any, rawBody: Buffer, signatureBase64: string, secret: string) {
  const host = (req.headers['x-forwarded-host'] as string) || (req.headers.host as string);
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const url = `${proto}://${host}${req.url}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(url + rawBody.toString());
  const expected = hmac.digest('base64');
  return expected === signatureBase64;
}

export default async function handler(req: any, res: any) {
  const raw = await readRaw(req);
  const sig = (req.headers['x-square-hmacsha256-signature'] as string) || '';
  const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY!;
  if (!secret) return res.status(500).json({ error: 'missing webhook secret' });

  if (!webhookValid(req, raw, sig, secret)) {
    return res.status(400).json({ error: 'bad signature' });
  }

  const evt = JSON.parse(raw.toString());
  const type = evt?.type; // e.g., "payment.updated"
  const payment = evt?.data?.object?.payment;
  const status = payment?.status; // "COMPLETED" when paid

  // We set quick_pay.reference_id = depositId when creating the link.
  // Square payments surface that as payment.reference_id (for Payment Links).
  const depositId = payment?.reference_id || null;

  if (status === 'COMPLETED' && depositId) {
    const { data: dep } = await sb.from('deposits').select('*').eq('id', depositId).single();
    if (dep && dep.status === 'pending') {
      // credit wallet via your RPC
      await sb.rpc('perform_wallet_credit', {
        p_user_id: dep.user_id,
        p_amount_cents: dep.amount_cents,
        p_ref: payment?.id || 'square',
        p_meta: { provider: 'square', type, payment_id: payment?.id },
      });
      await sb.from('deposits').update({ status: 'confirmed' }).eq('id', dep.id);
    }
  }

  // Always 200 so Square stops retrying
  res.json({ ok: true });
}