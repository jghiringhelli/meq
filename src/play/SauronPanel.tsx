import { useState } from 'react';
import type { Catalog, GameState, LocationId } from '../engine/types';
import {
  sauronStoryStep, sauronResolveEvents, sauronEndActionStep,
  sauronPlayPlot, sauronBeginAction, sauronActionYields,
  sauronPlaceInfluence, sauronSpawnMonster, sauronDeployMinion,
  sauronMoveFigure, sauronHealMinion, sauronPlayShadow,
  playablePlots, playableShadow, reserveMinions, woundedMinions, boardFigures,
  moveTargets, adjacentLocations,
} from '../engine/game';
import { placementTargets, influenceAt } from '../engine/influence';

interface Props {
  state: GameState; cat: Catalog;
  onApply: (next: GameState) => void;
}

type Mode = 'spawn' | 'deploy' | 'move' | 'heal' | 'shadow' | null;

const locName = (cat: Catalog, id: LocationId) => cat.locations[id]?.name ?? id;

export default function SauronPanel({ state, cat, onApply }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [figure, setFigure] = useState<string>('');
  const s = state;
  const phase = s.phase;
  const yields = sauronActionYields(s);
  const activeCount = s.heroes.filter((h) => h.status === 'active').length;
  const actionsMax = activeCount >= 3 ? 3 : 2;

  // Locations worth targeting: where heroes stand and one step around them, plus
  // Sauron's seat and any active plot locations.
  const heroLocs = s.heroes.filter((h) => h.status === 'active').map((h) => h.location);
  const near = new Set<LocationId>([s.sauron.location, ...heroLocs]);
  for (const l of heroLocs) for (const n of adjacentLocations(cat, l)) near.add(n);
  for (const p of s.sauron.activePlots ?? []) if (p.location) near.add(p.location as LocationId);
  const targetLocs = [...near];

  const figures = boardFigures(s);
  const selected = figures.find((f) => `${f.kind}:${f.id}:${f.loc}` === figure);

  const apply = (next: GameState) => { setMode(null); setFigure(''); onApply(next); };

  return (
    <div className="sauron-overlay">
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
            <button className="primary" onClick={() => onApply(sauronStoryStep(s, cat))}>
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
                  onClick={() => onApply(sauronPlayPlot(s, cat, p.id))}>
                  <span className="cc-label">{p.name}</span>
                  <span className="cc-ability">
                    {p.marker ?? 'red'} +{p.advance ?? p.track.length} · cost {p.influenceCost ?? 0}
                    {p.favorToCounter ? ` · counter ${p.favorToCounter}` : ''}
                  </span>
                </button>
              ))}
              {playablePlots(s, cat).length === 0 && <p className="muted">No affordable plots (slots full or too costly).</p>}
            </div>
            <button className="primary" onClick={() => onApply(sauronResolveEvents(s, cat))}>
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
                    onClick={() => { setMode(null); onApply(sauronBeginAction(s, cat, tr)); }}>
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
                  <button key={cid} onClick={() => apply(sauronPlayShadow(s, cat, cid))}>
                    {cat.shadow[cid]?.name ?? cid}
                  </button>
                ))}
                {playableShadow(s, cat).length === 0 && <p className="muted">No playable shadow cards.</p>}
              </div>
            )}

            {/* Place Influence action in progress: lay the remaining board tokens. */}
            {s.sauronPending?.track === 'influence' && (
              <div className="sauron-picker">
                <p className="prompt">Place {s.sauronPending.remaining} more influence token(s) on the board.</p>
                {placementTargets(s, cat).map((loc) => (
                  <button key={loc} onClick={() => apply(sauronPlaceInfluence(s, cat, loc))}>
                    {locName(cat, loc)} <span className="muted">(now {influenceAt(s, loc)})</span>
                  </button>
                ))}
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
                      onClick={() => setMode(mode === m ? null : m)}>
                      {m === 'spawn' ? 'Spawn monster' : m === 'deploy' ? 'Deploy minion'
                        : m === 'move' ? 'Move figure' : 'Heal minion'}
                    </button>
                  ))}
                </div>

                {mode === 'spawn' && (
                  <div className="sauron-picker">
                    {Object.values(cat.monsters).map((m) => (
                      <div key={m.id} className="pick-row">
                        <span className="pick-name">{m.name}</span>
                        {targetLocs.map((loc) => (
                          <button key={loc}
                            onClick={() => apply(sauronSpawnMonster(s, cat, m.id, loc))}>{locName(cat, loc)}</button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {mode === 'deploy' && (
                  <div className="sauron-picker">
                    {reserveMinions(s, cat).map((mid) => (
                      <div key={mid} className="pick-row">
                        <span className="pick-name">{cat.minions[mid]?.name ?? mid}</span>
                        {targetLocs.map((loc) => (
                          <button key={loc} onClick={() => apply(sauronDeployMinion(s, cat, mid, loc))}>{locName(cat, loc)}</button>
                        ))}
                      </div>
                    ))}
                    {reserveMinions(s, cat).length === 0 && <p className="muted">All minions are already in play.</p>}
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
                      <div className="pick-row">
                        {moveTargets(s, cat, selected.kind, selected.loc).map((to) => (
                          <button key={to}
                            onClick={() => apply(sauronMoveFigure(s, cat, selected.kind, selected.id, selected.loc, to))}>
                            → {locName(cat, to)}
                          </button>
                        ))}
                        {moveTargets(s, cat, selected.kind, selected.loc).length === 0 && <span className="muted">No legal move.</span>}
                      </div>
                    )}
                  </div>
                )}

                {mode === 'heal' && (
                  <div className="sauron-picker">
                    {woundedMinions(s, cat).map((mid) => (
                      <button key={mid} onClick={() => apply(sauronHealMinion(s, cat, mid))}>
                        {cat.minions[mid]?.name ?? mid}
                      </button>
                    ))}
                    {woundedMinions(s, cat).length === 0 && <p className="muted">No wounded minions.</p>}
                  </div>
                )}
              </>
            )}

            <button className="primary end-turn" onClick={() => onApply(sauronEndActionStep(s, cat))}>
              End Sauron turn ▶
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
