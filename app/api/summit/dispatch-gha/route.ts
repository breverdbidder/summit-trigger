import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN = process.env.SUMMIT_TRIGGER_HMAC_SECRET!;
const GH_PAT = process.env.GH_PAT!;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_REPOS = new Set([
  'breverdbidder/summit-trigger',
  'breverdbidder/everest-vault',
  'breverdbidder/everest-compliance',
]);

const WORKFLOW_RE = /^[a-zA-Z0-9_-]+\.(yml|yaml)$/;
const META_KEYS = new Set(['token', 'repo', 'workflow', 'ref', 'log_dispatch']);

export async function GET(req: NextRequest) {
  if (!TOKEN || !GH_PAT) {
    return NextResponse.json({
      error: 'server_not_configured',
      missing: { TOKEN: !TOKEN, GH_PAT: !GH_PAT },
    }, { status: 500 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const repo = url.searchParams.get('repo');
  const workflow = url.searchParams.get('workflow');
  const ref = url.searchParams.get('ref') || 'main';

  if (!token || !repo || !workflow) {
    return NextResponse.json({ error: 'missing_required', need: ['token', 'repo', 'workflow'] }, { status: 400 });
  }
  if (token !== TOKEN) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
  if (!ALLOWED_REPOS.has(repo)) {
    return NextResponse.json({ error: 'repo_not_allowed', repo, allowed: Array.from(ALLOWED_REPOS) }, { status: 403 });
  }
  if (!WORKFLOW_RE.test(workflow)) {
    return NextResponse.json({ error: 'invalid_workflow_filename', workflow }, { status: 400 });
  }

  const inputs: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (!META_KEYS.has(k)) inputs[k] = v;
  });

  const ghUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const ghResp = await fetch(ghUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GH_PAT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'summit-trigger-vercel',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs }),
  });

  if (ghResp.status !== 204) {
    const text = await ghResp.text();
    return NextResponse.json({
      error: 'github_dispatch_failed',
      gh_status: ghResp.status,
      gh_response: text,
      attempted: { url: ghUrl, ref, inputs },
    }, { status: 502 });
  }

  let dispatch_id: string | null = null;
  if (url.searchParams.get('log_dispatch') === '1' && SUPABASE_URL && SERVICE_ROLE) {
    try {
      const logResp = await fetch(`${SUPABASE_URL}/rest/v1/summit_chat_dispatch`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify([{
          chat_session_id: `claude_chat_gha_${Date.now()}`,
          ai_architect_model: 'claude-opus-4-7',
          summit_title: `GHA Direct: ${workflow}`,
          summit_body: `Direct workflow_dispatch via summit-trigger.\n\nRepo: ${repo}\nWorkflow: ${workflow}\nRef: ${ref}\n\nInputs:\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\``,
          target_repo: repo,
          target_workflow: workflow,
          priority: 'normal',
          state: 'dispatched',
          dispatch_inputs: inputs,
          attempt_number: 1,
          max_attempts: 1,
        }]),
      });
      if (logResp.ok) {
        const data = await logResp.json();
        dispatch_id = data[0]?.id ?? null;
      }
    } catch (e) {
      // log failure non-fatal
    }
  }

  return NextResponse.json({
    ok: true,
    dispatched: workflow,
    repo,
    ref,
    inputs,
    dispatch_id,
    next_check: `https://github.com/${repo}/actions/workflows/${workflow}`,
  });
}
