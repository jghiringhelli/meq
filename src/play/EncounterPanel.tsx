import type { Catalog, GameState, CardId } from '../engine/types';
import { encounterPlan } from '../engine/game';
import { encounterArt } from '../data/art';

interface Props {
  state: GameState; cat: Catalog;
  onResolve: () => void;
  onChoose: (optionIndex: number) => void;
  onReveal: (cardId?: CardId) => void;
}

export default function EncounterPanel({ state, cat, onResolve, onChoose, onReveal }: Props) {
  const pe = state.pendingEncounter!;
  const loc = cat.locations[pe.locationId];
  const drawn = pe.drawn ?? [pe.cardId];
  const applicable = pe.applicable ?? [pe.cardId];
  const multi = applicable.length > 1;

  // ---- Reveal tray: show every drawn card, highlight the one(s) that apply ---
  if (!pe.revealed) {
    return (
      // A fixed, semi-transparent tray: the backdrop lets pointer events through
      // so the map behind stays pannable; only the tray itself is interactive.
      <div className="enc-tray-backdrop">
        <div className="enc-tray">
          <h2>Encounter — {loc?.name}</h2>
          <p className="enc-tray-hint">
            {applicable.length === 0
              ? 'None of these apply here — a moment of respite.'
              : multi
                ? 'More than one card applies — choose which to resolve.'
                : 'The highlighted card resolves. Read it, then confirm.'}
          </p>
          <div className="enc-tray-cards">
            {drawn.map((id, i) => {
              const enc = cat.encounters[id];
              const applies = applicable.includes(id);
              const isChosen = id === pe.cardId;
              const art = encounterArt(id);
              const cls = `enc-tray-card${applies ? ' applies' : ' dim'}${isChosen && !multi ? ' chosen' : ''}`;
              return (
                <button
                  key={`${id}:${i}`}
                  className={cls}
                  disabled={!(multi && applies)}
                  onClick={() => { if (multi && applies) onReveal(id); }}
                  title={multi && applies ? 'Choose this card' : ''}
                >
                  {art && <img className="enc-tray-art" src={art} alt="" />}
                  <div className="enc-tray-body">
                    <div className="enc-tray-name">{enc?.name ?? id}</div>
                    <div className="enc-tray-text">{enc?.effect || <em>No mechanical effect.</em>}</div>
                    {applies && <span className="enc-tray-badge">applies</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {!multi && (
            <button
              className="primary enc-tray-ok"
              onClick={() => (applicable.length === 0 ? onResolve() : onReveal())}
            >
              OK
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Resolution: the chosen card's effect / any player choice --------------
  const enc = cat.encounters[pe.cardId];
  const plan = encounterPlan(state, cat);
  const pending = plan && !plan.complete ? plan.pending : null;
  const resolveArt = encounterArt(pe.cardId);

  return (
    <div className="combat-overlay">
      <div className="combat-board encounter-board">
        <h2>Encounter — {loc?.name}</h2>
        <div className="enc-resolve-body">
          {resolveArt && <img className="enc-resolve-art" src={resolveArt} alt="" />}
          <div className="enc-resolve-main">
            <div className="enc-name">{enc?.name}</div>
            <p className="enc-text">{enc?.effect || <em>No effect — a moment of respite.</em>}</p>

            {pending ? (
              <div className="enc-choice">
                <div className="enc-prompt">{pending.prompt}</div>
                <div className="enc-options">
                  {pending.options.map((o, i) => (
                    <button
                      key={i}
                      className="primary enc-option"
                      disabled={!o.enabled}
                      title={o.enabled ? '' : 'You cannot pay this cost'}
                      onClick={() => onChoose(i)}
                    >
                      {o.label}{o.enabled ? '' : ' (unavailable)'}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {plan && plan.atoms.length ? (
                  <ul className="enc-ops">
                    {plan.atoms.map((a, i) => (
                      <li key={i}>{a.op}{'n' in a ? ` ${a.n}` : ''}{'item' in a ? ` ${a.item}` : ''}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="enc-flavor">Narrative encounter (no mechanical effect).</p>
                )}
                <button className="primary" onClick={onResolve}>Resolve encounter</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
