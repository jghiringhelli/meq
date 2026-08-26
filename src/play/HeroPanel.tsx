import type { Catalog, GameState, MonsterId } from '../engine/types';
import { heroArt, combatCardArt } from '../data/art';
import { useInspect } from './CardInspector';

export interface EconActions {
  favorHere: number;
  characters: string[];
  plotHere: boolean;
  canDiscardPlot: boolean;
  plotCost?: number;
  canCleanse: boolean;
  canQuest: boolean;
  tradeTargets: string[];
  canSurvey: boolean;
  onSurvey: () => void;
  onDarkPath: () => void;
  canDarkPath: boolean;
  onRetrieveFavor: () => void;
  onConsult: (c: string, choice: 'favor' | 'ability') => void;
  onQuest: () => void;
  onDiscardPlot: () => void;
  onCleanse: () => void;
  onTradeFavor: (to: string) => void;
}

interface Props {
  state: GameState; cat: Catalog; active: boolean;
  engageable: MonsterId[]; canExplore: boolean; ambush?: boolean;
  onRest: () => void; onRestTrain: () => void; onEngage: (m: MonsterId) => void; onEndTurn: () => void; onExplore: () => void;
  econ: EconActions;
}

export default function HeroPanel({ state, cat, active, engageable, canExplore, ambush, onRest, onRestTrain, onEngage, onEndTurn, onExplore, econ }: Props) {
  const hero = state.heroes[state.activeHeroIndex];
  const def = cat.heroes[hero.id];
  const fig = heroArt(hero.id).figure;
  const noAct = hero.actionsRemaining <= 0 || !!ambush;
  const inspect = useInspect();
  return (
    <div className="hero-panel">
      <div className="hero-head">
        {fig && <img className="hero-fig" src={fig} alt="" />}
        <strong>{def.name}</strong>
        <span title="life pool (draw deck) · hand · damage">🂠 {hero.deck.length} · ✋ {hero.hand.length} · 🩸 {hero.damagePool.length}</span>
        <span title="favor">✦ {hero.favor}</span>
        <span title={hero.corruptionCards?.length
          ? `corruption cards: ${hero.corruptionCards.map((id) => cat.corruption[id]?.name ?? id).join(', ')}`
          : 'corruption'}>☠ {hero.corruption}</span>
        <span title="hand cards — the Travel step repeats until the hand is spent">🂠 hand {hero.hand.length}</span>
        <span title="Rest step: available once per turn">{hero.restedThisTurn ? 'rested' : 'can rest'}</span>
        <span>{cat.locations[hero.location]?.name}</span>
      </div>
      {(hero.allies?.length || hero.items.length || (hero.levels && Object.keys(hero.levels).length)) ? (
        <div className="hero-holdings">
          {hero.levels && Object.entries(hero.levels).map(([st, n]) => n ? <span key={st} className="level-chip" title="level tokens">▲{n} {st.slice(0, 3)}</span> : null)}
          {hero.allies?.map((a) => <span key={a} className="ally-chip">🤝 {a}</span>)}
          {hero.items.map((it) => <span key={it} className="item-chip">🎒 {it}</span>)}
        </div>
      ) : null}
      {(() => {
        const q = hero.quests ?? { startingDone: false, advancedDone: false };
        const start = q.startingQuestId ? cat.quests[q.startingQuestId] : undefined;
        const adv = q.advancedQuestId ? cat.quests[q.advancedQuestId] : undefined;
        if (!start && !adv) return null;
        return (
          <div className="hero-quests">
            {start && (
              <div className={`quest-chip${q.startingDone ? ' quest-done' : ''}`}
                title={`Setup: ${start.setup || '—'}\nTask: ${start.task}\nReward: ${start.reward}`}>
                {q.startingDone ? '✔' : '◷'} Quest: <strong>{start.name}</strong> — {start.task}
              </div>
            )}
            {adv && (
              <div className={`quest-chip quest-advanced${q.advancedUnlocked ? '' : ' quest-locked'}`}
                title={`Advanced quest.\nTask: ${adv.task}\nReward: ${adv.reward}`}>
                {q.advancedUnlocked ? '◷' : '🔒'} Advanced: <strong>{adv.name}</strong>
              </div>
            )}
          </div>
        );
      })()}
      <div className="hand">
        {hero.hand.map((cid, i) => {
          const c = cat.combatCards[cid];
          const img = combatCardArt(c, hero.id);
          return (
            <div key={`${cid}-${i}`} className={`card terrain-${c.terrain}`} title={c.ability}
              onClick={() => inspect({
                title: c.name, img,
                subtitle: `${c.type} · A${c.attack}/D${c.defense} · ${c.terrain || 'any terrain'}`,
                text: c.ability,
              })}>
              {img && <img className="card-art" src={img} alt="" />}
              <div className="card-name">{c.name}</div>
              <div className="card-line">{c.type} · A{c.attack}/D{c.defense}</div>
              <div className="card-terrain">{c.terrain || '—'}</div>
            </div>
          );
        })}
      </div>
      {active && (
        <div className="actions">
          {ambush && <span className="ambush-notice">⚔ Ambush! Fight the foe here before travelling.</span>}
          {engageable.map((m) => (
            <button key={m} className="danger" onClick={() => onEngage(m)}>
              Fight {(cat.monsters[m] ?? cat.minions[m])?.name ?? m}
            </button>
          ))}
          <button onClick={onExplore} disabled={!canExplore || noAct}>Explore</button>
          <button onClick={onRest} disabled={noAct}>Rest</button>
          {hero.id === 'beravor' && !hero.restedThisTurn && cat.locations[hero.location]?.kind !== 'haven'
            && cat.locations[hero.location]?.kind !== 'stronghold'
            && ((state.map.monstersAt[hero.location]?.length ?? 0) + (state.map.minionsAt?.[hero.location]?.length ?? 0)) === 0 && (
            <button onClick={onRestTrain} disabled={noAct} title="Survivalist: rest and take training instead of healing">Rest (train)</button>
          )}
          {econ.favorHere > 0 && (
            <button onClick={econ.onRetrieveFavor} disabled={noAct}>Retrieve favor ({econ.favorHere})</button>
          )}
          {econ.characters.map((c) => (
            <span key={c} className="consult-group">
              <button onClick={() => econ.onConsult(c, 'favor')} disabled={noAct} title="Gain 2 favor">Consult {c}: ✦✦ favor</button>
              <button onClick={() => econ.onConsult(c, 'ability')} disabled={noAct} title="Recruit as ally (ability)">→ ability</button>
            </span>
          ))}
          <button onClick={econ.onDarkPath} disabled={noAct || !econ.canDarkPath} title="+1 favor, +1 corruption (≤3 corruption, once/turn)">Dark path</button>
          {econ.canSurvey && (
            <button onClick={econ.onSurvey} title="Survivalist: look at the monster tokens in an adjacent location (once/turn, free)">🔍 Survivalist</button>
          )}
          {econ.canQuest && <button onClick={econ.onQuest} disabled={noAct}>Complete quest</button>}
          {econ.plotHere && (
            <button
              className="danger"
              onClick={econ.onDiscardPlot}
              disabled={noAct || !econ.canDiscardPlot}
              title={econ.canDiscardPlot ? 'Counter the plot here' : `Need ${econ.plotCost ?? 2} favor to counter this plot`}
            >
              Destroy plot ({econ.plotCost ?? 2} ✦)
            </button>
          )}
          {econ.canCleanse && <button onClick={econ.onCleanse} disabled={noAct}>Cleanse (2 ✦)</button>}
          {econ.tradeTargets.map((t) => (
            <button key={t} onClick={() => econ.onTradeFavor(t)} disabled={noAct || hero.favor <= 0}>Give 1 ✦ → {t}</button>
          ))}
          <button className="primary" onClick={onEndTurn}>End turn</button>
        </div>
      )}
      <p className="hint">Move by clicking a highlighted location whose path terrain matches a card in hand.</p>
    </div>
  );
}
