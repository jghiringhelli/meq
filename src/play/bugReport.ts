// Central place for "where do bug reports go" so the repo can be renamed /
// forked without hunting for hard-coded URLs across the UI.
export const GITHUB_REPO = 'jghiringhelli/meq';

/**
 * Build a prefilled "New issue" URL. We can't create the issue directly from
 * the client (that needs an authenticated GitHub token, and embedding one in
 * a public static site would let anyone spam/abuse the repo) — instead we
 * open GitHub's own new-issue form with the title/body already filled in, so
 * the player only has to attach the downloaded JSON report and click submit.
 * GitHub issue URLs have a practical length ceiling well below a full game
 * state dump, so the body only carries a short human-readable summary plus
 * instructions to attach the file — never the state JSON itself.
 */
export function buildBugReportUrl(opts: {
  description: string;
  seed: number;
  phase?: string | null;
  round?: number | null;
  reportFilename: string;
  crashMessage?: string;
}): string {
  const { description, seed, phase, round, reportFilename, crashMessage } = opts;
  const title = crashMessage
    ? `Crash: ${crashMessage}`.slice(0, 120)
    : `Bug report (seed ${seed}${phase ? `, ${phase}` : ''})`;
  const lines = [
    description.trim() || '_(describe what you were doing / what happened)_',
    '',
    '---',
    `Seed: ${seed}`,
    phase ? `Phase: ${phase}` : null,
    round != null ? `Round: ${round}` : null,
    crashMessage ? `Error: ${crashMessage}` : null,
    '',
    `**Please attach the file that was just downloaded (\`${reportFilename}\`) by dragging it into this box before submitting.** It has the full game log/state and never leaves your device unless you attach it here.`,
  ].filter((l): l is string => l !== null);
  const body = lines.join('\n');
  const params = new URLSearchParams({ title, body, labels: 'bug,player-report' });
  return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
}

/**
 * Plain-text version of the same report, for players who don't have (or don't
 * want) a GitHub account. This is meant to be copied to the clipboard and
 * pasted into whatever channel is easiest for the player (a chat message,
 * email, Discord DM…) alongside the downloaded JSON file — no GitHub issue,
 * no account, no technical steps beyond "paste and attach".
 */
export function buildBugReportSummaryText(opts: {
  description: string;
  seed: number;
  phase?: string | null;
  round?: number | null;
  reportFilename: string;
  crashMessage?: string;
}): string {
  const { description, seed, phase, round, reportFilename, crashMessage } = opts;
  const lines = [
    'Middle-earth Quest — bug report',
    description.trim() || '(describe what you were doing / what happened)',
    '',
    `Seed: ${seed}`,
    phase ? `Phase: ${phase}` : null,
    round != null ? `Round: ${round}` : null,
    crashMessage ? `Error: ${crashMessage}` : null,
    '',
    `(attach the file "${reportFilename}" that was just downloaded to this message)`,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

/**
 * Fully automatic path: a Netlify Function (`netlify/functions/report-issue.ts`)
 * holds a GitHub token server-side (never shipped to the client) and files the
 * issue itself, so the player doesn't have to do anything after clicking a
 * button. This builder is shared by the client (for the `submitAuto` request
 * body, so we only send what we actually use) and by the function itself (to
 * turn that body into the actual issue title/body/labels) — it has no
 * browser/Node-specific APIs so it's safe to import from either side.
 */
export interface AutoReportPayload {
  description: string;
  userAgent: string;
  timestamp: string;
  seed: number;
  phase?: string | null;
  round?: number | null;
  crashMessage?: string;
  /** Already-formatted, most-recent-last log lines (only the tail is kept). */
  logTail: string[];
  /** `JSON.stringify(state)` — capped to fit GitHub's issue body size limit. */
  stateJson?: string;
}

export interface GithubIssueContent {
  title: string;
  body: string;
  labels: string[];
}

// GitHub caps issue bodies well under 65536 chars; leave headroom for the
// rest of the body (log tail, headers) around the embedded state JSON.
const MAX_STATE_JSON_CHARS = 50000;
const MAX_LOG_LINES = 30;

export function buildAutoIssueContent(payload: AutoReportPayload): GithubIssueContent {
  const { description, userAgent, timestamp, seed, phase, round, crashMessage, logTail, stateJson } = payload;
  const firstLine = (crashMessage || description || 'Bug report').split('\n')[0].trim().slice(0, 90);
  // Tagged distinctly: the issue is authored by the bot/token account, not by
  // the maintainer, so this prefix avoids anyone mistaking it for a self-filed
  // issue (a real point of confusion the first time this pattern was used).
  const title = `[player report] ${firstLine || 'Untitled report'}`;

  const context = [
    `Seed: ${seed}`,
    phase ? `Phase: ${phase}` : null,
    round != null ? `Round: ${round}` : null,
    crashMessage ? `Error: ${crashMessage}` : null,
    `Time: ${timestamp}`,
    `User agent: ${userAgent}`,
  ].filter((l): l is string => l !== null);

  const sections = [
    '_Filed automatically by a player via the in-game "Report a problem" tool — this was not written or reviewed by the maintainer._',
    `### What happened\n${description.trim() || '_(no description provided)_'}`,
    `### Context\n${context.map((c) => `- ${c}`).join('\n')}`,
  ];

  if (logTail.length) {
    sections.push(`### Recent log\n\`\`\`\n${logTail.slice(-MAX_LOG_LINES).join('\n')}\n\`\`\``);
  }

  if (stateJson) {
    const truncated = stateJson.length > MAX_STATE_JSON_CHARS;
    const clipped = truncated ? stateJson.slice(0, MAX_STATE_JSON_CHARS) : stateJson;
    sections.push(
      `### Game state snapshot${truncated ? ' (truncated to fit)' : ''}\n\`\`\`json\n${clipped}\n\`\`\``,
    );
  }

  return { title, labels: ['bug', 'from-game'], body: sections.join('\n\n') };
}
