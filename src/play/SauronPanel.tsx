import { useState } from 'react';
import type { Catalog, GameState, LocationId } from '../engine/types';
import type { Action } from '../engine/actions';
import {
  sauronActionYields,
  playablePlots, plotLocationChoices, playableShadow, monsterTargetsIn, woundedMinions, boardFigures,
  canDiscardActivePlot,
  moveTargets, canBankInfluence,
} from '../engine/game';
import { gameStage } from '../engine/mechanics';
import { shadowWindow } from '../engine/sauronmech';
import { placementTargets } from '../engine/influence';
import { plotArt, shadowArt } from '../data/art';

type Mode = 'spawn' | 'move' | 'heal' | 'shadow' | null;
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
}

const locName = (cat: Catalog, id: LocationId) => cat.locations[id]?.name ?? id;

export default function SauronPanel({ state, cat, dispatch, moveFigureSel, onSelectMoveFigure }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [plotPick, setPlotPick] = useState<string | null>(null);
  const [shadowPick, setShadowPick] = useState<string | null>(null);
  const [keepShadow, setKeepShadow] = useState<string[]>([]);
  const [keepPlot, setKeepPlot] = useState<string[]>([]);
  const [shadowSort, setShadowSort] = useState<'draw' | 'name' | 'pool' | 'timing'>('draw');
  const [plotSort, setPlotSort] = useState<'draw' | 'name' | 'marker' | 'cost'>('draw');
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

  const apply = (action: Action) => { setMode(null); setFigure(''); dispatch(action); };
  // The turn can't end with mandatory actions unspent or a sub-action (e.g. an
  // in-progress influence placement or Command) left hanging — mirrors the
  // rulebook's "spend every action" requirement instead of silently letting
  // the turn end early.
  const canEndTurn = phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) <= 0 && !s.sauronPending;

  const firstTurn = (s.story?.turn ?? 1) <= 1;
  // Influence extension comes first; the hand choice follows.
  const hp = s.setupInfluencePending ? undefined : s.setupHandPending;
  const toggle = (set: React.Dispatch<React.SetStateAction<string[]>>, id: string) =>
    set((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const playablePlotIds = new Set(playablePlots(s, cat).map((p) => p.id));
  const playableShadowIds = new Set(playableShadow(s, cat));
  // Dim (never hide) cards that cannot be played right now.
  const plotDim = (id: string, cost: number) =>
    s.phase === 'SauronEvents' ? !playablePlotIds.has(id) : cost > s.sauron.influence;
  const plotReady = (id: string) => s.phase === 'SauronEvents' && playablePlotIds.has(id);
  const shadowReady = (id: string) => s.phase === 'SauronMinions' && playableShadowIds.has(id);
  const shadowDim = (id: string) => {
    const c = cat.shadow[id];
    if (!c) return false;
    if (Number(c.poolRequirement) > s.sauron.influence) return true;
    return shadowWindow(c.timing) === 'action' && !playableShadowIds.has(id);
  };
  const plotTile = (id: string, action?: React.ReactNode) => {
    const p = cat.plots.find((x) => x.id === id);
    if (!p) return <div key={id} className="card-tile">{id}</div>;
    const img = plotArt(p.image);
    return (
      <div key={id} className={`card-tile${plotDim(id, Number(p.influenceCost) || 0) ? ' card-tile--dim' : ''}${plotReady(id) ? ' card-tile--ready' : ''}`}>
        {img && <img src={img} alt={p.name} />}
        <div className="card-tile-name">{p.name}</div>
        <div className="card-tile-meta">{p.marker ?? 'red'} +{p.advance ?? p.track.length} · cost {p.influenceCost ?? 0} · counter {p.favorToCounter ?? '—'} favor</div>
        <div className="card-tile-meta"><b>Affects:</b> {p.affectsText || '—'}</div>
        <div className="card-tile-text">{p.effect}</div>
        {action}
      </div>
    );
  };
  const shadowTile = (id: string) => {
    const c = cat.shadow[id];
    const img = shadowArt(id);
    return (
      <div key={id} className={`card-tile${shadowDim(id) ? ' card-tile--dim' : ''}${shadowReady(id) ? ' card-tile--ready' : ''}`} title={shadowDim(id) ? 'Not playable right now' : shadowReady(id) ? 'Playable now' : undefined}>
        {img && <img src={img} alt={c?.name ?? id} />}
        <div className="card-tile-name">{c?.name ?? id}</div>
        <div className="card-tile-meta">pool {c?.poolRequirement} · {c?.timing}</div>
        <div className="card-tile-text">{c?.effect}</div>
      </div>
    );
  };
  const sortedShadow = [...s.sauron.shadowHand].sort((a, b) => {
    const ca = cat.shadow[a], cb = cat.shadow[b];
    if (shadowSort === 'name') return (ca?.name ?? a).localeCompare(cb?.name ?? b);
    if (shadowSort === 'pool') return Number(ca?.poolRequirement ?? 0) - Number(cb?.poolRequirement ?? 0);
    if (shadowSort === 'timing') return (ca?.timing ?? '').localeCompare(cb?.timing ?? '');
    return 0;
  });
  const sortedPlots = [...(s.sauron.plotHand ?? [])].sort((a, b) => {
    const pa = cat.plots.find((x) => x.id === a), pb = cat.plots.find((x) => x.id === b);
    if (plotSort === 'name') return (pa?.name ?? a).localeCompare(pb?.name ?? b);
    if (plotSort === 'marker') return (pa?.marker ?? '').localeCompare(pb?.marker ?? '');
    if (plotSort === 'cost') return Number(pa?.influenceCost ?? 0) - Number(pb?.influenceCost ?? 0);
    return 0;
  });
  const handView = (
    <div className="sauron-hand">
      <b>Your hand</b>
      <div className="hand-section hand-section--shadow">
        <div className="hand-section-head">
          <u>👁 Shadow cards ({s.sauron.shadowHand.length})</u>
          <select value={shadowSort} onChange={(e) => setShadowSort(e.target.value as typeof shadowSort)} aria-label="Sort shadow cards">
            <option value="draw">Order: as drawn</option>
            <option value="name">Sort: name</option>
            <option value="pool">Sort: pool cost</option>
            <option value="timing">Sort: when playable</option>
          </select>
        </div>
        {s.sauron.shadowHand.length === 0 && <span className="muted"> none</span>}
        <div className="card-tiles">{sortedShadow.map((id) => shadowTile(id))}</div>
      </div>
      <div className="hand-section hand-section--plot">
        <div className="hand-section-head">
          <u>🚩 Plot cards ({(s.sauron.plotHand ?? []).length})</u>
          <select value={plotSort} onChange={(e) => setPlotSort(e.target.value as typeof plotSort)} aria-label="Sort plot cards">
            <option value="draw">Order: as drawn</option>
            <option value="name">Sort: name</option>
            <option value="marker">Sort: story track</option>
            <option value="cost">Sort: influence cost</option>
          </select>
        </div>
        {(s.sauron.plotHand ?? []).length === 0 && <span className="muted"> none</span>}
        <div className="card-tiles">{sortedPlots.map((id) => plotTile(id))}</div>
      </div>
    </div>
  );

  if (s.setupInfluencePending) {
    const sp = s.setupInfluencePending;
    const placedCounts = new Map<string, number>();
    for (const l of sp.placed ?? []) placedCounts.set(l, (placedCounts.get(l) ?? 0) + 1);
    return (
      <div className="sauron-panel">
        <h2>Sauron — setup</h2>
        <p className="prompt">Influence left to place: <strong>{sp.remaining}</strong>
          {sp.remaining > 0 ? ' — click glowing + locations on the map.' : ' — all placed.'}</p>
        {placedCounts.size > 0 && (<>
          <p className="prompt">Placed this setup (extract to move one):</p>
          <ul>{[...placedCounts].map(([loc, n]) => (
            <li key={loc}>{cat.locations[loc]?.name ?? loc} ×{n}{' '}
              <button onClick={() => dispatch({ t: 'setupExtractInfluence', loc })}>Extract</button></li>
          ))}</ul>
        </>)}
        <button className="primary" disabled={sp.remaining > 0}
          onClick={() => dispatch({ t: 'setupConfirmInfluence' })}>Approve locations</button>
        <p className="prompt">Then you will choose your starting hand.</p>
      </div>
    );
  }

  if (hp) {
    const ok = keepShadow.length === hp.shadowKeep && keepPlot.length === hp.plotKeep;
    return (
      <div className="sauron-panel">
        <h2>Sauron — choose your starting hand</h2>
        <p className="prompt">Keep {hp.shadowKeep} of {hp.shadowOffered.length} Shadow cards:</p>
        {hp.shadowOffered.map((id) => (
          <label key={id} className="sauron-keep">
            <input type="checkbox" checked={keepShadow.includes(id)}
              onChange={() => toggle(setKeepShadow, id)} />
            {shadowTile(id)}
          </label>
        ))}
        <p className="prompt">Keep {hp.plotKeep} of {hp.plotOffered.length} Plot cards:</p>
        {hp.plotOffered.map((id) => (
          <label key={id} className="sauron-keep">
            <input type="checkbox" checked={keepPlot.includes(id)}
              onChange={() => toggle(setKeepPlot, id)} />
            {plotTile(id)}
          </label>
        ))}
        <button className="primary" disabled={!ok}
          onClick={() => { dispatch({ t: 'sauronKeepStartingHand', shadow: keepShadow, plot: keepPlot }); setKeepShadow([]); setKeepPlot([]); }}>
          Confirm starting hand
        </button>
      </div>
    );
  }

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

        {phase !== 'SauronRefresh' && phase !== 'SauronEvents' && phase !== 'SauronMinions' && (
          <p className="muted">
            Heroes are acting. You will be asked when a Shadow card can be played (one per hero turn): at the start of a
            hero's turn, after a hero enters a non-Haven location, at the start of a combat (some only vs a minion),
            or after a hero is defeated. Cards marked “Action step” are only playable on your own turn.
          </p>
        )}

        {phase === 'SauronRefresh' && (
          <div className="sauron-step">
            <p className="prompt">{firstTurn
              ? 'First turn — the Story and Plot steps are skipped. Resolve events, then take your actions.'
              : 'Story Step — advance the dark story clock.'}</p>
            <button className="primary" onClick={() => dispatch({ t: 'sauronStoryStep' })}>
              {firstTurn ? 'Begin first turn ▶' : 'Begin Sauron turn ▶'}
            </button>
          </div>
        )}

        {phase === 'SauronEvents' && (
          <div className="sauron-step">
            <p className="prompt">{firstTurn
              ? 'Plot Step skipped on the first turn. Resolve this turn\'s events.'
              : 'Plot Step — play one plot card OR discard one active plot (not both), or pass. Then resolve this turn\'s events.'}</p>
            <div className="sauron-plots">
              {playablePlots(s, cat).slice(0, 8).map((p) => {
                const spots = plotLocationChoices(s, cat, p.id);
                return (
                <button key={p.id} className="sauron-plot-btn"
                  onClick={() => { if (spots.length > 1) setPlotPick(plotPick === p.id ? null : p.id); else dispatch({ t: 'sauronPlayPlot', plotId: p.id }); }}>
                  <span className="cc-label">{p.name}</span>
                  <span className="cc-ability">
                    {p.marker ?? 'red'} +{p.advance ?? p.track.length} · cost {p.influenceCost ?? 0}
                    {p.favorToCounter ? ` · counter ${p.favorToCounter}` : ''}
                    {spots.length === 1 ? ` · at ${cat.locations[spots[0]]?.name ?? spots[0]}` : spots.length > 1 ? ` · choose location (${spots.length})` : ''}
                  </span>
                </button>
                );
              })}
              {plotPick && (
                <div className="sauron-picker">
                  <p className="prompt">Where does <b>{cat.plots.find((x) => x.id === plotPick)?.name}</b> take effect?</p>
                  {plotLocationChoices(s, cat, plotPick).map((l) => (
                    <button key={l} onClick={() => { dispatch({ t: 'sauronPlayPlot', plotId: plotPick, loc: l }); setPlotPick(null); }}>
                      {cat.locations[l]?.name ?? l}
                    </button>
                  ))}
                </div>
              )}
              {!firstTurn && playablePlots(s, cat).length === 0 && <p className="muted">{s.sauronPlotPlayed ? 'You have used your Plot step this turn.' : 'No affordable plots (slots full or too costly).'}</p>}
              {canDiscardActivePlot(s) && (
                <div className="sauron-picker">
                  <p className="prompt">Or discard an active plot instead:</p>
                  {(s.sauron.activePlots ?? []).map((e) => (
                    <button key={e.eventId} className="sauron-plot-btn"
                      onClick={() => dispatch({ t: 'sauronDiscardPlot', plotId: e.eventId })}>
                      <span className="cc-label">Discard {cat.plots.find((p) => p.id === e.eventId)?.name ?? e.eventId}</span>
                    </button>
                  ))}
                </div>
              )}
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
                  <button key={cid} onClick={() => {
                    if (s.heroes.filter((h) => h.status === 'active').length > 1) setShadowPick(shadowPick === cid ? null : cid);
                    else apply({ t: 'sauronPlayShadow', cardId: cid });
                  }}>
                    {cat.shadow[cid]?.name ?? cid}
                  </button>
                ))}
                {shadowPick && (
                  <div>
                    <p className="prompt">Target of <b>{cat.shadow[shadowPick]?.name}</b>:</p>
                    {s.heroes.filter((h) => h.status === 'active').map((h) => (
                      <button key={h.id} onClick={() => { apply({ t: 'sauronPlayShadow', cardId: shadowPick, heroId: h.id }); setShadowPick(null); }}>
                        {cat.heroes[h.id]?.name ?? h.id} @ {cat.locations[h.location]?.name ?? h.location}
                      </button>
                    ))}
                  </div>
                )}
                {playableShadow(s, cat).length === 0 && <p className="muted">No playable shadow cards.</p>}
              </div>
            )}

            {/* Place Influence action in progress: the remaining board tokens
                are placed by clicking the glowing "+" locations on the map
                itself (see Board.tsx's placeInfluenceTargets), not from a list
                here — keeps the map the single source of truth for where
                Sauron's influence can legally extend to. */}
            {s.sauronPending?.track === 'influence' && (() => {
              const pl = new Map<string, number>();
              for (const l of s.sauronPending.placed ?? []) pl.set(l, (pl.get(l) ?? 0) + 1);
              const noTargets = placementTargets(s, cat).length === 0;
              return (
              <div className="sauron-picker">
                <p className="prompt">
                  Shadow Pool: <b>{s.sauron.influence}</b>/{4 * gameStage(s)} — put up to 2 of this action's tokens there:{' '}
                  <button disabled={(s.sauronPending.banked ?? 0) <= 0}
                    onClick={() => dispatch({ t: 'sauronBankInfluence', delta: -1 })}>−</button>
                  {' '}{s.sauronPending.banked ?? 0}/2{' '}
                  <button disabled={!canBankInfluence(s)}
                    onClick={() => dispatch({ t: 'sauronBankInfluence', delta: 1 })}>+ to pool</button>
                </p>
                <p className="prompt">
                  {s.sauronPending.remaining > 0
                    ? <>Place {s.sauronPending.remaining} more influence token{s.sauronPending.remaining === 1 ? '' : 's'} —
                      click a glowing <span style={{ color: '#e0574a', fontWeight: 700 }}>+</span> location on the map.</>
                    : 'All placed — take one back if you misplaced it, or confirm.'}
                </p>
                {noTargets && s.sauronPending.remaining > 0 && (
                  <span className="muted">No legal locations (extend from a stronghold).</span>
                )}
                {pl.size > 0 && (<>
                  <p className="prompt">Placed this action (take back to correct):</p>
                  <ul>{[...pl].map(([loc, n]) => (
                    <li key={loc}>{cat.locations[loc]?.name ?? loc} ×{n}{' '}
                      <button onClick={() => dispatch({ t: 'sauronExtractInfluence', loc })}>Take back</button></li>
                  ))}</ul>
                </>)}
                <button className="primary" disabled={s.sauronPending.remaining > 0 && !noTargets}
                  onClick={() => dispatch({ t: 'sauronConfirmInfluence' })}>Confirm placement</button>
              </div>
              );
            })()}

            {/* Draw action in progress: the player (never the AI) picks the one
                Plot card to keep from those drawn (rulebook p.17). */}
            {s.sauronPending?.track === 'draw' && (
              <div className="sauron-picker">
                <p className="prompt">Draw — choose the ONE Plot card to keep; the rest go to the bottom of the Plot deck.</p>
                <div className="card-tiles">
                  {(s.sauronPending.drawnPlots ?? []).map((id) => plotTile(id, (
                    <button className="primary" onClick={() => apply({ t: 'sauronKeepDrawnPlot', id })}>Keep this Plot</button>
                  )))}
                </div>
              </div>
            )}

            {/* Command action in progress: issue up to `remaining` commands. */}
            {s.sauronPending?.track === 'command' && (
              <>
                <p className="prompt">Command — issue up to {s.sauronPending.remaining} more command(s).</p>
              <button className="sauron-mode-btn" onClick={() => apply({ t: 'sauronFinishCommand' })}>Done commanding</button>
                <div className="sauron-actions">
                  {(['spawn', 'move', 'heal'] as Mode[]).map((m) => (
                    <button key={m} className={`sauron-mode-btn${mode === m ? ' active' : ''}`}
                      onClick={() => {
                        setMode(mode === m ? null : m);
                        onSelectMoveFigure?.(null);
                      }}>
                      {m === 'spawn' ? 'Spawn monster'
                        : m === 'move' ? 'Move figure' : 'Heal minion'}
                    </button>
                  ))}
                </div>

                {mode === 'spawn' && (
                  <div className="sauron-picker">
                    {s.sauronPending.heldToken ? (
                      <p className="prompt">
                        You drew {s.sauronPending.heldToken.token === 'blank' ? 'a blank (false rumor)'
                          : cat.monsters[s.sauronPending.heldToken.token]?.name ?? s.sauronPending.heldToken.token} (only you can see it).
                        Click a glowing <span style={{ color: '#3ab86a', fontWeight: 700 }}>◉</span> location in the{' '}
                        {cat.monsterBags[s.sauronPending.heldToken.regionId]?.name} region to place it face-down.
                      </p>
                    ) : s.sauronPending.monsterDone ? (
                      <p className="muted">Only one monster token per Command action.</p>
                    ) : (
                      <>
                        <p className="muted">Choose a monster pile; a random token is drawn.</p>
                        {Object.values(cat.monsterBags).map((b) => {
                          const left = s.sauron.monsterBagPiles?.[b.id]?.length ?? b.blanks + b.tokens.reduce((n, t) => n + t.count, 0);
                          const ok = left > 0 && monsterTargetsIn(s, cat, b.id).length > 0;
                          return (
                            <button key={b.id} disabled={!ok}
                              onClick={() => apply({ t: 'sauronDrawMonsterToken', regionId: b.id })}>
                              {b.name} ({left} left)
                            </button>
                          );
                        })}
                      </>
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
                      moveTargets(s, cat, selected.kind, selected.loc, selected.id).length > 0 ? (
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
      {handView}
    </div>
  );
}
