import { useState } from 'react';
import type { Catalog, GameState, LocationId } from '../engine/types';
import type { Action } from '../engine/actions';
import {
  sauronActionYields,
  playablePlots, playableShadow, reserveMinions, woundedMinions, boardFigures,
  moveTargets,
} from '../engine/game';
import { placementTargets } from '../engine/influence';

type Mode = 'spawn' | 'deploy' | 'move' | 'heal' | 'shadow' | null;
export type { Mode };

interface Props {
  state: GameState; cat: Catalog;
  /** Every Sauron decision is a serializable Action so it can be sent over the
   *  wire when this browser is a networked client controlling Sauron — see
   *  engine/actions.ts's sauron* variants and App.tsx's `dispatch`. */
  dispatch: (action: Action) => void;
  /** Move-figure destination picking happens on the map (App.tsx wires
   *  Board's moveFigureTargets/onMoveFigureTarget from this same selection) —
   *  so the figure selection is lifted up out of local state and controlled
   *  by the parent instead of being private to this panel. */
  moveFigureSel?: { kind: 'monster' | 'minion'; id: string; loc: string } | null;
  onSelectMoveFigure?: (sel: { kind: 'monster' | 'minion'; id: string; loc: string } | null) => void;
  /** Spawn/deploy destination picking ALSO happens on the map (same reason as
   *  moveFigureSel above): once a monster/minion is picked in this panel's
   *  sidebar list, its board destination is clicked on the map. */
  commandSel?: { kind: 'spawn'; monsterId: string } | { kind: 'deploy'; minionId: string } | null;
  onSelectCommand?: (sel: { kind: 'spawn'; monsterId: string } | { kind: 'deploy'; minionId: string } | null) => void;
}

const locName = (cat: Catalog, id: LocationId) => cat.locations[id]?.name ?? id;

export default function SauronPanel({ state, cat, dispatch, moveFigureSel, onSelectMoveFigure, commandSel, onSelectCommand }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const figure = moveFigureSel ? `${moveFigureSel.kind}:${moveFigureSel.id}:${moveFigureSel.loc}` : '';
  const setFigure = (v: string) => {
    if (!v) { onSelectMoveFigure?.(null); return; }
    const [kind, id, loc] = v.split(':') as ['monster' | 'minion', string, string];
    onSelectMoveFigure?.({ kind, id, loc });
  };
  const s = state;
  const phase = s.phase;
  const yields = sauronActionYields(s);
  const activeCount = s.heroes.filter((h) => h.status === 'active').length;
  const actionsMax = activeCount >= 3 ? 3 : 2;

  const figures = boardFigures(s);
  const selected = figures.find((f) => `${f.kind}:${f.id}:${f.loc}` === figure);

  const apply = (action: Action) => { setMode(null); setFigure(''); onSelectCommand?.(null); dispatch(action); };
  // The turn can't end with mandatory actions unspent or a sub-action (e.g. an
  // in-progress influence placement or Command) left hanging — mirrors the
  // rulebook's "spend every action" requirement instead of silently letting
  // the turn end early.
  const canEndTurn = phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) <= 0 && !s.sauronPending;

  return (
    <div className="sauron-panel">
      <h2>Sauron — the Lidless Eye</h2>
        <div className="sauron-status">
          <span>War chest: <strong>{s.sauron.influence}</strong></span>
          <span>Shadow hand: <strong>{s.sauron.shadowHand.length}</strong></span>
          {phase === 'SauronMinions' && (
            <span className="eye-slots" title="action slots — one Eye per remaining action">
              Actions:{' '}
              {Array.from({ length: Math.max(s.sauronActionsLeft ?? 0, 0) }, (_, i) => (
                <span key={`on-${i}`} className="eye-token on">👁</span>
              ))}
              {Array.from({ length: Math.max(actionsMax - (s.sauronActionsLeft ?? 0), 0) }, (_, i) => (
                <span key={`off-${i}`} className="eye-token off">👁</span>
              ))}
            </span>
          )}
        </div>

        {phase === 'SauronRefresh' && (
          <div className="sauron-step">
            <p className="prompt">Story Step — advance the dark story clock.</p>
            <button className="primary" onClick={() => dispatch({ t: 'sauronStoryStep' })}>
              Begin Sauron turn ▶
            </button>
          </div>
        )}

        {phase === 'SauronEvents' && (
          <div className="sauron-step">
            <p className="prompt">Plot Step — play one plot card, or pass. Then resolve this turn's events.</p>
            <div className="sauron-plots">
              {playablePlots(s, cat).slice(0, 8).map((p) => (
                <button key={p.id} className="sauron-plot-btn"
                  onClick={() => dispatch({ t: 'sauronPlayPlot', plotId: p.id })}>
                  <span className="cc-label">{p.name}</span>
                  <span className="cc-ability">
                    {p.marker ?? 'red'} +{p.advance ?? p.track.length} · cost {p.influenceCost ?? 0}
                    {p.favorToCounter ? ` · counter ${p.favorToCounter}` : ''}
                  </span>
                </button>
              ))}
              {playablePlots(s, cat).length === 0 && <p className="muted">No affordable plots (slots full or too costly).</p>}
            </div>
            <button className="primary" onClick={() => dispatch({ t: 'sauronResolveEvents' })}>
              Resolve events & begin actions ▶
            </button>
          </div>
        )}

        {phase === 'SauronMinions' && (
          <div className="sauron-step">
            <p className="prompt">Action Step — spend your {s.sauronActionsLeft ?? 0} action(s), then end the turn.</p>

            {/* No action owing sub-effects: pick an Eye Action Track (or play a Shadow). */}
            {!s.sauronPending && (
              <div className="sauron-actions">
                {(['influence', 'draw', 'command'] as const).map((tr) => (
                  <button key={tr} className="sauron-mode-btn"
                    disabled={(s.sauronActionsLeft ?? 0) <= 0 || yields[tr] == null}
                    onClick={() => { setMode(null); dispatch({ t: 'sauronBeginAction', track: tr }); }}>
                    {tr === 'influence' ? 'Place influence' : tr === 'draw' ? 'Draw cards' : 'Command'}
                    {yields[tr] != null && <span className="cc-ability"> +{yields[tr]}</span>}
                  </button>
                ))}
                <button className={`sauron-mode-btn${mode === 'shadow' ? ' active' : ''}`}
                  disabled={playableShadow(s, cat).length === 0}
                  onClick={() => setMode(mode === 'shadow' ? null : 'shadow')}>
                  Play shadow
                </button>
              </div>
            )}

            {!s.sauronPending && mode === 'shadow' && (
              <div className="sauron-picker">
                {playableShadow(s, cat).map((cid) => (
                  <button key={cid} onClick={() => apply({ t: 'sauronPlayShadow', cardId: cid })}>
                    {cat.shadow[cid]?.name ?? cid}
                  </button>
                ))}
                {playableShadow(s, cat).length === 0 && <p className="muted">No playable shadow cards.</p>}
              </div>
            )}

            {/* Place Influence action in progress: the remaining board tokens
                are placed by clicking the glowing "+" locations on the map
                itself (see Board.tsx's placeInfluenceTargets), not from a list
                here — keeps the map the single source of truth for where
                Sauron's influence can legally extend to. */}
            {s.sauronPending?.track === 'influence' && (
              <div className="sauron-picker">
                <p className="prompt">
                  Place {s.sauronPending.remaining} more influence token{s.sauronPending.remaining === 1 ? '' : 's'} —
                  click a glowing <span style={{ color: '#e0574a', fontWeight: 700 }}>+</span> location on the map.
                </p>
                {placementTargets(s, cat).length === 0 && (
                  <span className="muted">No legal locations (extend from a stronghold).</span>
                )}
              </div>
            )}

            {/* Command action in progress: issue up to `remaining` commands. */}
            {s.sauronPending?.track === 'command' && (
              <>
                <p className="prompt">Command — issue {s.sauronPending.remaining} more command(s).</p>
                <div className="sauron-actions">
                  {(['spawn', 'deploy', 'move', 'heal'] as Mode[]).map((m) => (
                    <button key={m} className={`sauron-mode-btn${mode === m ? ' active' : ''}`}
                      onClick={() => {
                        setMode(mode === m ? null : m);
                        onSelectCommand?.(null);
                        onSelectMoveFigure?.(null);
                      }}>
                      {m === 'spawn' ? 'Spawn monster' : m === 'deploy' ? 'Deploy minion'
                        : m === 'move' ? 'Move figure' : 'Heal minion'}
                    </button>
                  ))}
                </div>

                {mode === 'spawn' && (
                  <div className="sauron-picker">
                    {Object.values(cat.monsters).map((m) => (
                      <button key={m.id}
                        className={commandSel?.kind === 'spawn' && commandSel.monsterId === m.id ? 'active' : ''}
                        onClick={() => onSelectCommand?.({ kind: 'spawn', monsterId: m.id })}>
                        {m.name}
                      </button>
                    ))}
                    {commandSel?.kind === 'spawn' && (
                      <p className="prompt">
                        Click a glowing <span style={{ color: '#3ab86a', fontWeight: 700 }}>◉</span> location on the
                        map to spawn {cat.monsters[commandSel.monsterId]?.name ?? commandSel.monsterId} there.
                      </p>
                    )}
                  </div>
                )}

                {mode === 'deploy' && (
                  <div className="sauron-picker">
                    {reserveMinions(s, cat).map((mid) => (
                      <button key={mid}
                        className={commandSel?.kind === 'deploy' && commandSel.minionId === mid ? 'active' : ''}
                        onClick={() => onSelectCommand?.({ kind: 'deploy', minionId: mid })}>
                        {cat.minions[mid]?.name ?? mid}
                      </button>
                    ))}
                    {reserveMinions(s, cat).length === 0 && <p className="muted">All minions are already in play.</p>}
                    {commandSel?.kind === 'deploy' && (
                      <p className="prompt">
                        Click a glowing <span style={{ color: '#3ab86a', fontWeight: 700 }}>◉</span> location on the
                        map to deploy {cat.minions[commandSel.minionId]?.name ?? commandSel.minionId} there.
                      </p>
                    )}
                  </div>
                )}

                {mode === 'move' && (
                  <div className="sauron-picker">
                    <select value={figure} onChange={(e) => setFigure(e.target.value)}>
                      <option value="">Pick a figure…</option>
                      {figures.map((f) => (
                        <option key={`${f.kind}:${f.id}:${f.loc}`} value={`${f.kind}:${f.id}:${f.loc}`}>
                          {f.kind === 'monster' ? cat.monsters[f.id]?.name : cat.minions[f.id]?.name} @ {locName(cat, f.loc)}
                        </option>
                      ))}
                    </select>
                    {selected && (
                      moveTargets(s, cat, selected.kind, selected.loc).length > 0 ? (
                        <p className="prompt">
                          Click a glowing <span style={{ color: '#4a7ee0', fontWeight: 700 }}>→</span> location on the
                          map to move {selected.kind === 'monster' ? cat.monsters[selected.id]?.name : cat.minions[selected.id]?.name} there.
                        </p>
                      ) : <span className="muted">No legal move.</span>
                    )}
                  </div>
                )}

                {mode === 'heal' && (
                  <div className="sauron-picker">
                    {woundedMinions(s, cat).map((mid) => (
                      <button key={mid} onClick={() => apply({ t: 'sauronHealMinion', minionId: mid })}>
                        {cat.minions[mid]?.name ?? mid}
                      </button>
                    ))}
                    {woundedMinions(s, cat).length === 0 && <p className="muted">No wounded minions.</p>}
                  </div>
                )}
              </>
            )}

            <button className="primary end-turn" disabled={!canEndTurn}
              title={canEndTurn ? undefined : 'Spend all remaining actions (and finish any action in progress) before ending the turn.'}
              onClick={() => canEndTurn && dispatch({ t: 'sauronEndActionStep' })}>
              End Sauron turn ▶
            </button>
          </div>
        )}
    </div>
  );
}
