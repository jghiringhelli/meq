import { useState } from 'react';
import { exportProblemReport, loadLastCrash, clearLastCrash } from './persistence';
import { buildBugReportUrl, buildBugReportSummaryText } from './bugReport';
import type { AutoReportPayload } from './bugReport';
import type { GameState } from '../engine/types';
import type { CrashInfo } from './persistence';

interface Props {
  seed: number;
  state: GameState | null;
  crash?: CrashInfo | null;
  onClose: () => void;
}

/**
 * "Report a problem" flow: the player describes what happened, then picks one of:
 *  - "Send report automatically" (default/primary): posts to a Netlify Function
 *    (netlify/functions/report-issue.ts) that files the GitHub issue itself,
 *    using a token that lives server-side only — nothing for the player to do
 *    afterwards. Falls back with a clear error if the function isn't
 *    configured/reachable, so the manual options below always still work.
 *  - "Download report & open GitHub issue myself": downloads a full JSON
 *    snapshot and opens a prefilled GitHub issue the player attaches it to.
 *  - "Don't have GitHub — copy summary instead": downloads the same JSON and
 *    copies a short plain-text summary to paste into WhatsApp/Discord/email.
 * No GitHub credentials are ever exposed client-side in any of these paths.
 */
export default function ReportBugModal({ seed, state, crash, onClose }: Props) {
  const [description, setDescription] = useState('');
  const [step, setStep] = useState<'form' | 'done-github' | 'done-copy' | 'done-auto'>('form');
  // If the caller didn't hand us a crash directly (e.g. the player clicked
  // "Report a problem" themselves, not from the crash screen), check whether
  // a background error slipped by unnoticed (an event-handler throw or an
  // unhandled promise rejection) so it still gets attached automatically.
  const effectiveCrash = crash ?? loadLastCrash() ?? undefined;
  const [lastSummary, setLastSummary] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoError, setAutoError] = useState('');
  const [autoIssueUrl, setAutoIssueUrl] = useState('');

  const submitGithub = () => {
    const filename = exportProblemReport(seed, state, description, effectiveCrash);
    const url = buildBugReportUrl({
      description,
      seed,
      phase: state?.phase ?? null,
      round: state?.round ?? null,
      reportFilename: filename,
      crashMessage: effectiveCrash?.message,
    });
    window.open(url, '_blank', 'noopener');
    clearLastCrash();
    setStep('done-github');
  };

  // Fully automatic path: send everything to a Netlify Function that files
  // the GitHub issue itself (token lives server-side only — see
  // netlify/functions/report-issue.ts). Falls back gracefully — on any error
  // (function not deployed/configured yet, offline, etc.) we show the message
  // and let the player use one of the manual options below instead.
  const submitAuto = async () => {
    setAutoBusy(true);
    setAutoError('');
    try {
      const logTail = (state?.log ?? [])
        .slice(-30)
        .map((e) => `R${e.round} ${e.phase} — ${e.actor}: ${e.detail}`);
      const payload: AutoReportPayload = {
        description,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        timestamp: new Date().toISOString(),
        seed,
        phase: state?.phase ?? null,
        round: state?.round ?? null,
        crashMessage: effectiveCrash?.message,
        logTail,
        stateJson: state ? JSON.stringify(state) : undefined,
      };
      const res = await fetch('/.netlify/functions/report-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok !== true) {
        setAutoError((data && data.error) || `Couldn't submit automatically (${res.status}).`);
        return;
      }
      clearLastCrash();
      setAutoIssueUrl(data.url || '');
      setStep('done-auto');
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : 'Network error — couldn\'t reach the server.');
    } finally {
      setAutoBusy(false);
    }
  };

  // No-GitHub-account path: same downloaded file, but instead of opening a
  // GitHub issue we just put a short plain-text summary on the clipboard so
  // the player can paste it wherever is easiest for them (a chat/DM/email to
  // whoever is collecting reports), with the downloaded file attached there.
  const submitCopy = async () => {
    const filename = exportProblemReport(seed, state, description, effectiveCrash);
    const text = buildBugReportSummaryText({
      description,
      seed,
      phase: state?.phase ?? null,
      round: state?.round ?? null,
      reportFilename: filename,
      crashMessage: effectiveCrash?.message,
    });
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be unavailable; text is shown below regardless */ }
    setLastSummary(text);
    clearLastCrash();
    setStep('done-copy');
  };

  return (
    <div className="choice-overlay" onClick={onClose}>
      <div className="travel-modal report-bug-modal" onClick={(e) => e.stopPropagation()}>
        {step === 'form' ? (
          <>
            <h3>Report a problem</h3>
            {effectiveCrash && (
              <p className="report-crash-note">
                The app hit an unexpected error: <code>{effectiveCrash.message}</code>
              </p>
            )}
            <p className="travel-req">
              Briefly describe what you were doing and what went wrong (or looked wrong).
              This, plus a full technical snapshot of the game (never anything about you personally),
              will be attached to a new GitHub issue for us to look into.
            </p>
            <textarea
              className="report-bug-text"
              autoFocus
              rows={5}
              placeholder="e.g. Explored Ruins of Angmar with Beravor, expected a peril draw but nothing happened…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="report-bug-actions">
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button className="ghost" title="No GitHub account? Downloads the same report file and copies a short summary you can paste into a chat/email instead."
                onClick={submitCopy}>Don't have GitHub — copy summary instead</button>
              <button className="ghost" onClick={submitGithub}>Download report &amp; open GitHub issue myself</button>
              <button className="primary" disabled={autoBusy} onClick={submitAuto}>
                {autoBusy ? 'Sending…' : 'Send report automatically'}
              </button>
            </div>
            {autoError && (
              <p className="report-crash-note">
                {autoError} You can still use one of the other options above.
              </p>
            )}
          </>
        ) : step === 'done-github' ? (
          <>
            <h3>Thanks!</h3>
            <p className="travel-req">
              A JSON file with the full game state was just downloaded, and a GitHub issue tab
              should have opened with your description pre-filled. Drag the downloaded file into
              that issue's text box, then submit it — that's all we need.
            </p>
            <div className="report-bug-actions">
              <button className="primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : step === 'done-auto' ? (
          <>
            <h3>Thanks — report sent!</h3>
            <p className="travel-req">
              We filed it for you automatically, no extra steps needed.
              {autoIssueUrl && (
                <> You can follow it here: <a href={autoIssueUrl} target="_blank" rel="noreferrer">{autoIssueUrl}</a></>
              )}
            </p>
            <div className="report-bug-actions">
              <button className="primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <h3>Thanks!</h3>
            <p className="travel-req">
              A JSON file with the full game state was just downloaded, and a short summary was
              copied to your clipboard. Paste that summary into a message (WhatsApp, Discord,
              email — whatever's easiest) and attach the downloaded file, then send it — that's
              all we need, no GitHub account required.
            </p>
            <textarea className="report-bug-text" rows={5} readOnly value={lastSummary} />
            <div className="report-bug-actions">
              <button className="primary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

