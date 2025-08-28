export default async function handler(req, res) {
  const haveUrl = !!process.env.SUPABASE_URL;
  const haveSrv = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const haveAnon = !!process.env.SUPABASE_ANON_KEY;
  const success = process.env.DEPOSIT_SUCCESS_STATUS || null;
  res.setHeader('content-type','application/json');
  res.status(200).end(JSON.stringify({
    ok: true, haveUrl, haveSrv, haveAnon,
    DEPOSIT_SUCCESS_STATUS: success
  }));
}