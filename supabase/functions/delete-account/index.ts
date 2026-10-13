// Supabase Edge Function: permanently delete the CALLER's account.
//
// 1. Verifies the caller from their own login token (never trusts a user id
//    in the request body).
// 2. Snapshots their weekly totals as anonymous "Former member" rows and
//    deletes every log, body record, profile and membership (SQL function).
// 3. Deletes every file under media/<their id>/ (meal + body photos).
// 4. Deletes the login itself.
//
// The service-role key is only available here on the server (Supabase sets
// SUPABASE_SERVICE_ROLE_KEY automatically for Edge Functions). It must never
// be placed in the web app.
//
// Deploy:  npx supabase functions deploy delete-account
// Call from the app:  supabase.functions.invoke('delete-account', { body: { confirm: 'DELETE' } })

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const appOrigin = Deno.env.get('APP_ORIGIN');
const cors = {
  'Access-Control-Allow-Origin': appOrigin ?? 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (!appOrigin) return json(503, { error: 'Account deletion is not configured.' });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in required' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json(401, { error: 'Sign in required' });
  const userId = userData.user.id;

  let body: { confirm?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  if (body.confirm !== 'DELETE') return json(400, { error: 'Confirmation missing' });

  // 2. Database: anonymize totals, delete personal rows.
  const { error: dbError } = await admin.rpc('service_prepare_account_removal', { p_user: userId });
  if (dbError) return json(500, { error: 'Could not delete your data. Nothing was removed from storage yet.' });

  // 3. Storage: remove everything under the user's folder (paged).
  for (const folder of ['meals', 'body']) {
    const prefix = `${userId}/${folder}`;
    for (;;) {
      const { data: files, error } = await admin.storage.from('media').list(prefix, { limit: 100 });
      if (error) return json(500, { error: 'Your logs were deleted but some photos could not be removed. Try again.' });
      if (!files || files.length === 0) break;
      const { error: rmError } = await admin.storage.from('media').remove(files.map((f) => `${prefix}/${f.name}`));
      if (rmError) return json(500, { error: 'Your logs were deleted but some photos could not be removed. Try again.' });
    }
  }

  // 4. Login.
  const { error: delError } = await admin.auth.admin.deleteUser(userId);
  if (delError) return json(500, { error: 'Your data was deleted but the login could not be removed. Try again.' });

  return json(200, { ok: true });
});
