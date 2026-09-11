import { useState } from 'react';
import { exportProblemReport, loadLastCrash, clearLastCrash } from './persistence';
import { buildBugReportUrl } from './bugReport';
import type { GameState } from '../engine/types';
import type { CrashInfo } from './persistence';

interface Props {
  seed: number;
  state: GameState | null;
  crash?: CrashInfo | null;
  onClose: () => void;
}

/**
 * "Report a problem" flow: the player describes what happened, we download a
 * full JSON snapshot (state + log + browser info) to their device, then open
 * a prefilled GitHub issue so they only need to drag the file in and submit.
 * Nothing is uploaded automatically — the player stays in control of what
 * leaves their machine, and no GitHub credentials are ever exposed client-side.
 */
export default function ReportBugModal({ seed, state, crash, onClose }: Props) {
  const [description, setDescription] = useState('');
  const [step, setStep] = useState<'form' | 'done'>('form');
  // If the caller didn't hand us a crash directly (e.g. the player clicked
  // "Report a problem" themselves, not from the crash screen), check whether
  // a background error slipped by unnoticed (an event-handler throw or an
  // unhandled promise rejection) so it still gets attached automatically.
  const effectiveCrash = crash ?? loadLastCrash() ?? undefined;

  const submit = () => {
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
    setStep('done');
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
              <button className="primary" onClick={submit}>Download report &amp; open GitHub issue</button>
            </div>
          </>
        ) : (
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
        )}
      </div>
    </div>
  );
}
