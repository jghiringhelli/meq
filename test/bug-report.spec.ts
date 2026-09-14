import { describe, it, expect, beforeEach } from 'vitest';
import { recordCrash, loadLastCrash, clearLastCrash, exportProblemReport } from '../src/play/persistence';
import { buildBugReportUrl, buildBugReportSummaryText, buildAutoIssueContent, GITHUB_REPO } from '../src/play/bugReport';

// Vitest here runs in a bare Node environment (no jsdom), so there's no
// global `localStorage` at all — persistence.ts already degrades gracefully
// without one (every call is wrapped in try/catch), but that means we can't
// observe an actual round-trip without a minimal stand-in. This tiny in-memory
// shim is local to this file only; it doesn't touch the shared vitest config.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

// jsdom (vitest's default test environment) provides `localStorage`, but not
// URL.createObjectURL/document download plumbing — exportProblemReport
// swallows failures from that gracefully, so we only assert it doesn't throw
// and still returns the expected filename.
describe('bug report / crash persistence helpers', () => {
  beforeEach(() => { clearLastCrash(); });

  it('round-trips a stashed crash through localStorage', () => {
    expect(loadLastCrash()).toBeNull();
    recordCrash({ message: 'boom', stack: 'at foo()' });
    const c = loadLastCrash();
    expect(c?.message).toBe('boom');
    expect(c?.stack).toBe('at foo()');
    expect(typeof c?.at).toBe('string');
    clearLastCrash();
    expect(loadLastCrash()).toBeNull();
  });

  it('exportProblemReport never throws and names the file by seed/round', () => {
    const filename = exportProblemReport(42, null, 'it broke');
    expect(filename).toBe('meq-report-seed42-round0.json');
  });

  it('builds a GitHub issue URL pointing at the configured repo with no raw state', () => {
    const url = buildBugReportUrl({
      description: 'hero could not move',
      seed: 7,
      phase: 'HeroActions',
      round: 3,
      reportFilename: 'meq-report-seed7-round3.json',
    });
    expect(url.startsWith(`https://github.com/${GITHUB_REPO}/issues/new?`)).toBe(true);
    expect(url).toContain('labels=bug%2Cplayer-report');
    const body = decodeURIComponent(url.split('body=')[1].split('&')[0].replace(/\+/g, ' '));
    expect(body).toContain('hero could not move');
    expect(body).toContain('Seed: 7');
    expect(body).toContain('meq-report-seed7-round3.json');
  });

  it('includes the crash message in the issue title when present', () => {
    const url = buildBugReportUrl({
      description: '',
      seed: 1,
      reportFilename: 'r.json',
      crashMessage: 'Cannot read properties of undefined',
    });
    const title = decodeURIComponent(url.split('title=')[1].split('&')[0].replace(/\+/g, ' '));
    expect(title).toContain('Crash:');
    expect(title).toContain('Cannot read properties of undefined');
  });

  it('builds a plain-text summary (no GitHub, no URL-encoding) for players without a GitHub account', () => {
    const text = buildBugReportSummaryText({
      description: 'hero could not move',
      seed: 7,
      phase: 'HeroActions',
      round: 3,
      reportFilename: 'meq-report-seed7-round3.json',
    });
    expect(text).toContain('hero could not move');
    expect(text).toContain('Seed: 7');
    expect(text).toContain('Phase: HeroActions');
    expect(text).toContain('Round: 3');
    expect(text).toContain('meq-report-seed7-round3.json');
    expect(text).not.toContain('github.com');
  });

  it('builds automatic-issue content tagged as a player report, with a size-capped state snapshot', () => {
    const bigState = JSON.stringify({ big: 'x'.repeat(200000) });
    const content = buildAutoIssueContent({
      description: 'combat resolved with wrong result',
      userAgent: 'test-agent',
      timestamp: '2024-01-01T00:00:00.000Z',
      seed: 9,
      phase: 'Combat',
      round: 4,
      logTail: ['R4 Combat — Hero: rolled 3', 'R4 Combat — Sauron: rolled 5'],
      stateJson: bigState,
    });
    expect(content.title).toContain('[player report]');
    expect(content.title).toContain('combat resolved with wrong result');
    expect(content.labels).toEqual(['bug', 'from-game']);
    expect(content.body).toContain('Seed: 9');
    expect(content.body).toContain('Phase: Combat');
    expect(content.body).toContain('Round: 4');
    expect(content.body).toContain('rolled 3');
    expect(content.body).toContain('truncated to fit');
    expect(content.body.length).toBeLessThan(bigState.length);
    expect(content.body).toContain('automatically by a player');
  });

  it('omits the state section entirely when no state snapshot is given', () => {
    const content = buildAutoIssueContent({
      description: 'small issue',
      userAgent: 'ua',
      timestamp: '2024-01-01T00:00:00.000Z',
      seed: 1,
      logTail: [],
    });
    expect(content.body).not.toContain('Game state snapshot');
  });
});
