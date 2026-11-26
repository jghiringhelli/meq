import type { Catalog, GameState } from '../engine/types';
import { heroArt } from '../data/art';
import { useInspect } from './CardInspector';

/** What the Sauron player may see of each hero: public information only. Hand
 *  contents, damage cards and the secret mission stay hidden (counts only);
 *  discard pile, items, allies, levels, corruption and quests are face-up. */
export default function HeroesIntel({ state, cat }: { state: GameState; cat: Catalog }) {
  const inspect = useInspect();
  const cardName = (id: string) => cat.combatCards[id]?.name ?? id;
  return (
    <div className="heroes-intel">
      {state.heroes.map((h) => {
        const def = cat.heroes[h.id];
        const fig = heroArt(h.id).figure;
        const q = h.quests;
        const start = q?.startingQuestId ? cat.quests[q.startingQuestId] : undefined;
        const adv = q?.advancedQuestId ? cat.quests[q.advancedQuestId] : undefined;
        const discard = [...h.discard];
        const active = state.heroes[state.activeHeroIndex]?.id === h.id;
        return (
          <div key={h.id} className={`hero-intel${active ? ' hero-intel-active' : ''}${h.status !== 'active' ? ' hero-intel-out' : ''}`}>
            <div className="hero-head">
              {fig && <img className="hero-fig" src={fig} alt="" />}
              <strong>{def?.name ?? h.id}</strong>
              <span className="hero-loc">📍 {cat.locations[h.location]?.name ?? h.location}</span>
              {h.status !== 'active' && <span className="muted"> ({h.status})</span>}
            </div>
            <div className="hero-resources">
              <span className="res-chip" title="Cards left in the hero's deck (his remaining life)">🂠 Deck <b>{h.deck.length}</b></span>
              <span className="res-chip" title="Cards in hand (contents are hidden from Sauron)">✋ Hand <b>{h.hand.length}</b></span>
              <span className="res-chip" title="Damage cards (face-down: contents hidden)">🩸 Damage <b>{h.damagePool.length}</b></span>
              <span className={`res-chip${discard.length ? ' clickable' : ''}`} title="Discard pile (face-up). Click to list"
                onClick={() => discard.length && inspect({
                  title: `${def?.name ?? h.id} — discard`, subtitle: `${discard.length} cards`,
                  lines: discard.map(cardName),
                })}>🗑 Discard <b>{discard.length}</b></span>
              <span className="res-chip" title="Favor">✦ Favor <b>{h.favor}</b></span>
              <span className={`res-chip${h.corruptionCards?.length ? ' clickable' : ''}`}
                title={h.corruptionCards?.length ? h.corruptionCards.map((id) => cat.corruption[id]?.name ?? id).join(', ') : 'Corruption'}
                onClick={() => h.corruptionCards?.length && inspect({
                  title: `${def?.name ?? h.id} — corruption`, subtitle: `${h.corruptionCards.length} held`,
                  lines: h.corruptionCards.map((id) => {
                    const c = cat.corruption[id];
                    return c ? `${c.name} — ${c.ability}` : id;
                  }),
                })}>☠ Corruption <b>{h.corruption}</b></span>
            </div>
            {(h.allies?.length || h.items.length || (h.levels && Object.keys(h.levels).length)) ? (
              <div className="hero-holdings">
                {h.levels && Object.entries(h.levels).map(([st, n]) => n ? <span key={st} className="level-chip">▲{n} {st.slice(0, 3)}</span> : null)}
                {h.allies?.map((a) => <span key={a} className="ally-chip">🤝 {a}</span>)}
                {h.items.map((it) => <span key={it} className="item-chip">🎒 {it}</span>)}
              </div>
            ) : null}
            {(start || adv) && (
              <div className="hero-quests">
                {start && <div className={`quest-chip${q?.startingDone ? ' quest-done' : ''}`}
                  title={`Task: ${start.task}\nReward: ${start.reward}`}>
                  {q?.startingDone ? '✔' : '◷'} <strong>{start.name}</strong></div>}
                {adv && q?.advancedUnlocked && <div className={`quest-chip quest-advanced${q.advancedDone ? ' quest-done' : ''}`}
                  title={`Task: ${adv.task}\nReward: ${adv.reward}`}>
                  {q.advancedDone ? '✔' : '◷'} Adv: <strong>{adv.name}</strong></div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
