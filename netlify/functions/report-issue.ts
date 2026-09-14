// Netlify serverless function: files a GitHub issue automatically for the
// in-game "Report a problem" tool, so non-technical players don't have to do
// anything after clicking a button. The GitHub token lives ONLY here, as a
// server-side environment variable (Netlify site settings → Environment
// variables) — it is never sent to, or reachable from, the client bundle.
// See src/play/bugReport.ts for why this can't be done directly in the browser.
//
// Required environment variables (set in the Netlify dashboard, never in code):
//   MEQ_BUGREPORT_TOKEN  — a GitHub fine-grained PAT scoped to this repo only,
//                          with "Issues: Read and write" permission (nothing else).
//   MEQ_BUGREPORT_REPO   — optional, defaults to "jghiringhelli/meq".
//
// If the token isn't configured yet, this returns a clear "not configured"
// error so the UI can fall back to the existing manual paths instead of
// silently failing.
import { buildAutoIssueContent, type AutoReportPayload } from '../../src/play/bugReport';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const token = process.env.MEQ_BUGREPORT_TOKEN;
  const repo = process.env.MEQ_BUGREPORT_REPO || 'jghiringhelli/meq';
  if (!token) {
    return json(
      { ok: false, error: 'Automatic reporting isn\'t set up on this server yet — please use one of the other options.' },
      501,
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400);
  }
  const body = (raw ?? {}) as Partial<AutoReportPayload>;
  if (typeof body.description !== 'string' || !body.description.trim()) {
    return json({ ok: false, error: 'Missing description' }, 400);
  }

  const payload: AutoReportPayload = {
    description: body.description,
    userAgent: typeof body.userAgent === 'string' ? body.userAgent : '',
    timestamp: typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString(),
    seed: typeof body.seed === 'number' ? body.seed : 0,
    phase: body.phase ?? null,
    round: typeof body.round === 'number' ? body.round : null,
    crashMessage: typeof body.crashMessage === 'string' ? body.crashMessage : undefined,
    logTail: Array.isArray(body.logTail) ? body.logTail.map(String) : [],
    stateJson: typeof body.stateJson === 'string' ? body.stateJson : undefined,
  };

  const { title, body: issueBody, labels } = buildAutoIssueContent(payload);

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'meq-bug-report-function',
      },
      body: JSON.stringify({ title, body: issueBody, labels }),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      return json({ ok: false, error: (data && data.message) || `GitHub API error (${res.status})` }, 502);
    }
    return json({ ok: true, url: data?.html_url, number: data?.number });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'Network error contacting GitHub' }, 502);
  }
};
