import type { CombatSummary } from '../engine/types';

interface Props {
  summary: CombatSummary;
  onContinue: () => void;
}

const RESULT_LABEL: Record<CombatSummary['result'], string> = {
  attacker: 'Victory!',
  defender: 'Defeated',
  escape: 'Escaped',
  standoff: 'Standoff',
};

/** Post-combat "what happened" recap. Stays up until the player hits
 *  Continue — separate from CombatBoard, which has already unmounted by the
 *  time this shows (pendingCombat is null the instant combat resolves). */
export default function CombatSummaryModal({ summary, onContinue }: Props) {
  const { result, heroName, foeName, foeKind, rounds, damageTaken, notes } = summary;
  return (
    <div className="choice-overlay">
      <div className="choice-modal combat-summary">
        <p className="prompt">{RESULT_LABEL[result]}</p>
        <p>
          {heroName} vs {foeName} ({foeKind}) — {rounds} round{rounds === 1 ? '' : 's'}
          {damageTaken > 0 ? `, took ${damageTaken} damage` : ''}.
        </p>
        {notes.length > 0 && (
          <ul className="combat-summary-notes">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        <div className="choice-options">
          <button className="choice-btn primary" onClick={onContinue}>Continue</button>
        </div>
      </div>
    </div>
  );
}
