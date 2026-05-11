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

const META_KEYS = new Set([
  'task', 'token', 'target_repo', 'target_workflow',
  'priority', 'title', 'body', 'model',
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

  const dispatch_inputs: Record<string, string> = { task };
  url.searchParams.forEach((v, k) => {
    if (!META_KEYS.has(k)) dispatch_inputs[k] = v;
  });

  const target_repo = url.searchParams.get('target_repo') || 'breverdbidder/everest-vault';
  const target_workflow = url.searchParams.get('target_workflow') || 'claude-code-direct.yml';
  const priority = url.searchParams.get('priority') || 'high';
  const summit_title = url.searchParams.get('title') || `Summit: ${task}`;
  const summit_body = url.searchParams.get('body') ||
    `Task: ${task}\n\nDispatched from Claude chat via summit-trigger Vercel endpoint.\n\nInputs:\n\`\`\`json\n${JSON.stringify(dispatch_inputs, null, 2)}\n\`\`\``;
  const ai_architect_model = url.searchParams.get('model') || 'claude-opus-4-7';

  const row = {
    chat_session_id: `claude_chat_${Date.now()}`,
    ai_architect_model,
    summit_title,
    summit_body,
    target_repo,
    target_workflow,
    priority,
    state: 'queued',


      
    dispatch_inputs,
    attempt_number: 0,
    max_attempts: 3,
  };

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/summit_chat_dispatch`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([row]),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return NextResponse.json({ error: 'supabase_insert_failed', detail: text, attempted: row }, { status: 502 });
  }
  const data = await resp.json();
  return NextResponse.json({
    ok: true,
    dispatched: task,
    dispatch_id: data[0]?.id ?? null,
    row: data[0] ?? null,
  });
}
