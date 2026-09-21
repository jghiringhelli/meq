import type { Catalog, GameState, MonsterId } from '../engine/types';
import { heroArt, combatCardArt } from '../data/art';
import { useInspect } from './CardInspector';
import { questHowTo } from '../engine/quests';

const ATTR_LABELS: [key: 'fortitude' | 'strength' | 'agility' | 'wisdom', short: string][] = [
  ['fortitude', 'Fortitude'], ['strength', 'Strength'], ['agility', 'Agility'], ['wisdom', 'Wisdom'],
];

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
  // Rest step (rulebook p.20): optional, once per turn, and only BEFORE any
  // Travel step — i.e. at the very start of the turn, before the hero has moved.
  const canRestNow = !hero.restedThisTurn && !hero.hasMovedThisTurn && (hero.travelStepsThisTurn ?? 0) === 0;
  const inspect = useInspect();
  return (
    <div className="hero-panel">
      <div className="hero-head">
        {fig && <img className="hero-fig" src={fig} alt="" />}
        <strong>{def.name}</strong>
        <span className="hero-loc">📍 {cat.locations[hero.location]?.name}</span>
      </div>
      <div className="hero-resources">
        <span className="res-chip" title="Life pool: cards left in your draw deck">🂠 Deck <b>{hero.deck.length}</b></span>
        <span className="res-chip" title="Cards currently in your hand — spend these to move/fight; the Travel step repeats until your hand is spent">✋ Hand <b>{hero.hand.length}</b></span>
        <span className="res-chip" title="Damage taken — cards here don't return until you Rest at a Haven">🩸 Damage <b>{hero.damagePool.length}</b></span>
        <span className="res-chip" title="Favor — spend it to counter plots, retrieve items, etc.">✦ Favor <b>{hero.favor}</b></span>
        <span className="res-chip" title={hero.corruptionCards?.length
          ? `Corruption cards: ${hero.corruptionCards.map((id) => cat.corruption[id]?.name ?? id).join(', ')}`
          : 'Corruption — too high and you risk becoming a Fallen Hero'}>☠ Corruption <b>{hero.corruption}</b></span>
        <span className="res-chip" title="Rest step: available once per turn, only before you move">{hero.restedThisTurn ? '✔ Rested' : canRestNow ? '○ Can rest' : '✕ Rest unavailable'}</span>
      </div>
      <div className="hero-stats-legend">Attributes:</div>
      <div className="hero-stats"
        onClick={() => inspect({
          title: def.name, img: heroArt(hero.id).portrait || heroArt(hero.id).figure,
          subtitle: `${def.abilityName}`,
          lines: ATTR_LABELS.map(([key, short]) => {
            const base = def[key]; const bonus = hero.statBonus?.[key] ?? 0;
            return bonus ? `${short}: ${base} + ${bonus} (levels) = ${base + bonus}` : `${short}: ${base}`;
          }),
          text: def.abilityText,
        })}
        title="Click for full stats and ability text. Level tokens (from quest/encounter rewards) add a permanent bonus, capped at +2 per attribute.">
        {ATTR_LABELS.map(([key, short]) => {
          const base = def[key]; const bonus = hero.statBonus?.[key] ?? 0;
          return (
            <span key={key} className={`stat-chip${bonus ? ' stat-boosted' : ''}`}>
              {short} {base + bonus}{bonus ? <sup>+{bonus}</sup> : null}
            </span>
          );
        })}
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
                title={`Setup: ${start.setup || '—'}\nTask: ${start.task}\nHow: ${questHowTo(cat, start)}\nReward: ${start.reward}`}
                onClick={() => inspect({
                  title: start.name, subtitle: `Starting Quest${q.startingDone ? ' · done' : ''}`,
                  lines: [
                    start.setup ? `Setup: ${start.setup}` : undefined,
                    `Task: ${start.task}`,
                    `How: ${questHowTo(cat, start)}`,
                    `Reward: ${start.reward}`,
                  ].filter(Boolean) as string[],
                })}>
                {q.startingDone ? '✔' : '◷'} Quest: <strong>{start.name}</strong> — {start.task}
              </div>
            )}
            {adv && (
              <div className={`quest-chip quest-advanced${q.advancedUnlocked ? '' : ' quest-locked'}${q.advancedDone ? ' quest-done' : ''}`}
                title={`Task: ${adv.task}\nHow: ${questHowTo(cat, adv)}\nReward: ${adv.reward}`}
                onClick={() => inspect({
                  title: adv.name, subtitle: `Advanced Quest${q.advancedUnlocked ? '' : ' · locked'}${q.advancedDone ? ' · done' : ''}`,
                  lines: [
                    `Task: ${adv.task}`,
                    `How: ${questHowTo(cat, adv)}`,
                    `Reward: ${adv.reward}`,
                  ],
                })}>
                {q.advancedDone ? '✔' : q.advancedUnlocked ? '◷' : '🔒'} Advanced: <strong>{adv.name}</strong>
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
          <button onClick={onRest} disabled={noAct || !canRestNow}>Rest</button>
          {hero.id === 'beravor' && !hero.restedThisTurn && cat.locations[hero.location]?.kind !== 'haven'
            && cat.locations[hero.location]?.kind !== 'stronghold'
            && ((state.map.monstersAt[hero.location]?.length ?? 0) + (state.map.minionsAt?.[hero.location]?.length ?? 0)) === 0 && (
            <button onClick={onRestTrain} disabled={noAct || !canRestNow} title="Survivalist: rest and take training instead of healing">Rest (train)</button>
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
