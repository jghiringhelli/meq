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
