import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN = process.env.SUMMIT_TRIGGER_HMAC_SECRET!;
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

export async function GET(req: NextRequest) {
  if (!TOKEN || !SUPABASE_URL || !SERVICE_ROLE) {
    return NextResponse.json({ error: 'server_not_configured' }, { status: 500 });
  }
  const url = new URL(req.url);
  const task = url.searchParams.get('task');
  const token = url.searchParams.get('token');

  if (!task || !token) {
    return NextResponse.json({ error: 'missing_task_or_token' }, { status: 400 });
  }
  if (token !== TOKEN) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
  if (!ALLOWED_TASKS.has(task)) {
    return NextResponse.json({ error: 'task_not_allowed', task }, { status: 403 });
  }

  const payload: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== 'task' && k !== 'token') payload[k] = v;
  });

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/summit_chat_dispatch`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([{
      task_type: task,
      task_spec: payload,
      priority: 'high',
    }]),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return NextResponse.json({ error: 'supabase_insert_failed', detail: text }, { status: 502 });
  }
  const data = await resp.json();
  return NextResponse.json({
    ok: true,
    dispatched: task,
    dispatch_id: data[0]?.id ?? null,
  });
}
