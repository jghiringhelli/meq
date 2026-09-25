import type { Catalog, CombatSummary } from '../engine/types';

interface Props {
  summary: CombatSummary;
  cat: Catalog;
  onContinue: () => void;
  /** true when reopened later from the Combat history panel — the game
   *  itself already moved on, so the button just closes this view. */
  readOnly?: boolean;
}

const RESULT_LABEL: Record<CombatSummary['result'], string> = {
  attacker: 'Victory!',
  defender: 'Defeated',
  escape: 'Escaped',
  standoff: 'Standoff',
};

/** Post-combat "what happened" recap. Stays up until the player hits
 *  Continue — separate from CombatBoard, which has already unmounted by the
 *  time this shows (pendingCombat is null the instant combat resolves). Also
 *  reused (read-only) by the Combat history panel to review any past fight. */
export default function CombatSummaryModal({ summary, cat, onContinue, readOnly }: Props) {
  const { result, heroName, foeName, foeKind, rounds, damageTaken, notes, report } = summary;
  return (
    <div className="choice-overlay">
      <div className="choice-modal combat-summary">
        <p className="prompt">{RESULT_LABEL[result]}</p>
        <p>
          {heroName} vs {foeName} ({foeKind}) — {rounds} round{rounds === 1 ? '' : 's'}
          {damageTaken > 0 ? `, took ${damageTaken} damage` : ''}.
        </p>
        {report.length > 0 && (
          <div className="cb-report combat-summary-report">
            <div className="cb-report-head"><span>#</span><span>{heroName}</span><span>{foeName}</span><span>dmg</span></div>
            <div className="cb-report-body">
              {report.map((r, i) => (
                <div key={i} className="cb-report-row">
                  <span>r{r.round}</span>
                  <span>{r.attackerCard ? cat.combatCards[r.attackerCard]?.name ?? '—' : '—'}</span>
                  <span>{r.defenderCard ? cat.combatCards[r.defenderCard]?.name ?? '—' : '—'}</span>
                  <span className="cb-report-dmg">{r.damageToDefender > 0 && <em className="d-foe">foe −{r.damageToDefender}</em>}{r.damageToAttacker > 0 && <em className="d-hero">you −{r.damageToAttacker}</em>}{r.damageToDefender === 0 && r.damageToAttacker === 0 && '·'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {notes.length > 0 && (
          <ul className="combat-summary-notes">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        <div className="choice-options">
          <button className="choice-btn primary" onClick={onContinue}>{readOnly ? 'Close' : 'Continue'}</button>
        </div>
      </div>
    </div>
  );
}
