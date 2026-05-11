import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECRET = process.env.SUMMIT_TRIGGER_HMAC_SECRET!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ALLOWED_TASKS = new Set([
  'tpo_brevard_backfill',
  'tpo_volusia_backfill',
  'tpo_charlotte_backfill',
  'tpo_indian_river_backfill',
  'tpo_recompute_relationships',
  'auction_daily_scrape',
  'zonewise_parcel_sync',
]);

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyHmac(payloadB64: string, sigB64: string): boolean {
  const expected = createHmac('sha256', SECRET).update(payloadB64).digest();
  const provided = b64urlDecode(sigB64);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export async function GET(req: NextRequest) {
  if (!SECRET || !SUPABASE_URL || !SERVICE_ROLE) {
    return NextResponse.json({ error: 'server_not_configured' }, { status: 500 });
  }
  const url = new URL(req.url);
  const p = url.searchParams.get('p');
  const sig = url.searchParams.get('sig');
  if (!p || !sig) return NextResponse.json({ error: 'missing_p_or_sig' }, { status: 400 });
  if (!verifyHmac(p, sig)) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });

  let payload: { task: string; payload?: object; exp: number; nonce?: string };
  try {
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    return NextResponse.json({ error: 'invalid_payload_json' }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return NextResponse.json({ error: 'token_expired', now, exp: payload.exp }, { status: 401 });
  }
  if (!ALLOWED_TASKS.has(payload.task)) {
    return NextResponse.json({ error: 'task_not_allowed', task: payload.task }, { status: 403 });
  }

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/summit_chat_dispatch`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([{
      task_type: payload.task,
      task_spec: payload.payload ?? {},
      priority: 'high',
      dispatched_by: 'summit_trigger_endpoint',
      source: 'summit-trigger/api/summit/trigger',
    }]),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return NextResponse.json({ error: 'supabase_insert_failed', detail: text }, { status: 502 });
  }
  const data = await resp.json();
  return NextResponse.json({
    ok: true,
    dispatched: payload.task,
    dispatch_id: data[0]?.id ?? null,
  });
}
