// api/status/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { callPanel } from '../_lib'; // 👈 up one level

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const id = (req.query.id as string) || '';
  if (!id) return res.status(400).json({ error: 'missing_id' });

  try {
    // most panels expect POST with { order: <id> }
    const result = await callPanel('status', { order: id });
    return res.status(200).json(result);
  } catch (err: any) {
    console.error('status handler crashed:', err?.message || err);
    return res.status(500).json({ error: 'internal' });
  }
}