import { useEffect, useRef, useState } from 'react';
import type { Catalog, GameState, CardId, Combatant } from '../engine/types';
import { monsterArt, minionArt, heroArt, combatCardArt, battleBoardArt } from '../data/art';
import { isTrainedCard } from '../engine/mechanics';
import { useInspect } from './CardInspector';

interface Props {
  state: GameState; cat: Catalog;
  onChoose?: (optionId: string) => void;
}

// A small stat pill (attribute name + value).
function Stat({ label, val }: { label: string; val: number | string }) {
  return <span className="cb-stat"><em>{label}</em><b>{val}</b></span>;
}

// Combat cards are scanned per PHYSICAL DECK, not per combatant: a monster's
// hand is drawn from one of the shared "monster-behemoth/-ravager/-zealot"
// decks (assets/monsters.json's `deck` field), never from a deck of its own —
// e.g. Crebain, Agent, Snaga and Orc all draw from the "monster-zealot" deck.
// Named elite minions (assets/minions.json's `combatDeck` field, e.g. the
// Mouth of Sauron → "monster-zealot") work the same way — they have NO combat
// deck of their own either. Using the combatant's own id as the art owner key
// therefore always misses the dedicated monster-deck scans and falls back to
// the generic id art (which, for shared card NAMES like "Precision"/"Hack",
// happens to be a HERO's scan — this used to make minions/monsters visibly
// show a hero's card border in combat). Resolve to the actual deck owner
// (behemoth/ravager/zealot) for both monsters and minions; heroes keep using
// their own id (their deck IS their own, "hero-<id>").
export function combatantOwnerKey(cat: Catalog, refId: string): string {
  const deck = cat.monsters[refId]?.deck ?? cat.minions[refId]?.combatDeck;
  return deck ? deck.replace(/^monster-/, '') : refId;
}

/** A monster/minion's physical combat deck never changes between games (it's
 *  the same fixed set of printed cards every time), so — unlike a hero's
 *  personal deck, which grows with training and stays hidden until a card is
 *  actually revealed — its full composition can just be read straight off the
 *  catalog. This gives the player a "what could the foe still play" cheat
 *  sheet: each unique card in its deck, and how many of that card have
 *  already been played (and so can't come up again this fight). */
interface DeckCardCount { id: CardId; name: string; total: number; used: number; }
export function foeDeckBreakdown(cat: Catalog, deckId: string | undefined, played: CardId[]): DeckCardCount[] {
  if (!deckId) return [];
  const full = cat.decks[deckId] ?? [];
  const usedCounts = new Map<CardId, number>();
  for (const id of played) usedCounts.set(id, (usedCounts.get(id) ?? 0) + 1);
  const totals = new Map<CardId, number>();
  for (const id of full) totals.set(id, (totals.get(id) ?? 0) + 1);
  return [...totals.entries()]
    .map(([id, total]) => ({ id, name: cat.combatCards[id]?.name ?? id, total, used: usedCounts.get(id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What Sauron legitimately knows about the HERO he's fighting (relevant when a
 *  human plays Sauron: the monster/minion he brought into this fight is one of
 *  the shared decks above, but the opponent across the table is a hero, whose
 *  personal deck can include hidden Training upgrades). Per the real rules:
 *  - The hero's PRINTED starting deck is always public (same for every game).
 *  - Training COUNT is public the moment it happens (`trainedCount`), but WHICH
 *    Skill card was kept (of the two drawn) stays secret until that specific
 *    card is actually revealed — played in combat, discarded to pay a Move
 *    cost, or any other discard effect. Once it's sat in a discard pile (this
 *    fight's live discard counts immediately, same as a past one), Sauron
 *    knows exactly which card it is, permanently (a later reshuffle empties
 *    the discard pile again, but never un-teaches Sauron what he already saw —
 *    see `s.sauron.heroIntel` in ai.ts, the same memory the Lidless Eye uses).
 *  - Which specific cards sit in the hero's damage pool is NEVER knowable
 *    (only the count is public) — so a card isn't marked "used" just because
 *    the hero took damage; only an actual discard removes it from the unknown
 *    pool below. */
export function heroKnownDeckBreakdown(
  cat: Catalog, heroRefId: string, combatant: Combatant, historicalRevealedTrained: CardId[], trainedCount: number,
): { rows: DeckCardCount[]; unknownTrained: number } {
  const baseDeckId = cat.heroes[heroRefId]?.deck;
  const baseIds = baseDeckId ? cat.decks[baseDeckId] ?? [] : [];
  const totals = new Map<CardId, number>();
  for (const id of baseIds) totals.set(id, (totals.get(id) ?? 0) + 1);

  // Trained cards revealed so far: the persistent (cross-reshuffle) memory,
  // union this fight's own live discard (catches a reveal the moment it
  // happens, even before combat ends and syncs back to the hero's real deck).
  const revealed = [...historicalRevealedTrained, ...combatant.discard.filter((id) => isTrainedCard(cat, id))];
  for (const id of revealed) {
    if (!cat.combatCards[id]) continue;
    totals.set(id, Math.max(totals.get(id) ?? 0, 1)); // a revealed trained card is now a known owned card
  }

  const discardCounts = new Map<CardId, number>();
  for (const id of combatant.discard) discardCounts.set(id, (discardCounts.get(id) ?? 0) + 1);

  const rows = [...totals.entries()]
    .map(([id, total]) => ({ id, name: cat.combatCards[id]?.name ?? id, total, used: discardCounts.get(id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Trained slots whose specific card has never been discarded/played anywhere,
  // ever — genuinely unknown, shown only as a count, never an identity.
  const unknownTrained = Math.max(0, trainedCount - revealed.length);
  return { rows, unknownTrained };
}

// One revealed combat card (art + name + attack/defense/type), or an empty slot.
function CardFace({ cat, card, ownerRef, kind }: { cat: Catalog; card?: CardId; ownerRef: string; kind: 'atk' | 'def' }) {
  const c = card ? cat.combatCards[card] : undefined;
  if (!c) return <div className={`cb-card cb-card-empty ${kind}`}><span>—</span></div>;
  const img = combatCardArt(c, ownerRef);
  return (
    <div className={`cb-card ${kind}`}>
      {img && <img src={img} alt="" />}
      <div className="cb-card-info">
        <span className="cb-card-name">{c.name}</span>
        <span className="cb-card-nums">⚔{c.attack} · 🛡{c.defense} · {c.type}{c.strengthCost ? ` · ✊${c.strengthCost}` : ''}</span>
        {c.ability && <span className="cb-card-ab">{c.ability}</span>}
      </div>
    </div>
  );
}

export default function CombatBoard({ state, cat, onChoose }: Props) {
  const pc = state.pendingCombat!;
  const ch = state.pendingChoice;
  const inspect = useInspect();
  const [min, setMin] = useState(false);
  const [showFoeDeck, setShowFoeDeck] = useState(false);
  const [showHeroDeck, setShowHeroDeck] = useState(false);

  const hero = pc.attacker;
  const foe = pc.defender;
  const heroDef = cat.heroes[hero.refId];
  const foeDef = cat.monsters[foe.refId] ?? cat.minions[foe.refId];
  const foeArt = monsterArt(foe.refId) || minionArt(cat.minions[foe.refId]?.image ?? '');
  const heroImg = heroArt(hero.refId).portrait || heroArt(hero.refId).figure;
  const bg = battleBoardArt();
  const foeMaxLife: number | undefined = cat.minions[foe.refId]?.health;
  // Its physical combat deck id — monsters use `deck`, minions `combatDeck`.
  const foeDeckId = cat.monsters[foe.refId]?.deck ?? cat.minions[foe.refId]?.combatDeck;
  const foeDeckBreak = foeDeckBreakdown(cat, foeDeckId, pc.stack?.defender ?? []);
  // Only relevant to a human playing Sauron: what he legitimately knows about
  // the hero's own deck, given training identities stay secret until revealed.
  const heroLiveState = state.heroes.find((h) => h.id === hero.refId);
  const heroIntel = state.sauron.heroIntel?.[hero.refId]?.revealedTrained ?? [];
  const heroDeckBreak = state.humanSide === 'Sauron'
    ? heroKnownDeckBreakdown(cat, String(hero.refId), hero, heroIntel, heroLiveState?.trainedCount ?? 0)
    : undefined;

  // Latest resolved bout drives the "what happened" line + damage pop.
  const last = pc.report.length ? pc.report[pc.report.length - 1] : undefined;
  const revA = pc.reveal.attacker ?? last?.attackerCard;
  const revD = pc.reveal.defender ?? last?.defenderCard;

  // Fading red damage numbers: re-mount on every new bout via a changing key so
  // the CSS animation replays. One pop per side that actually took damage.
  const boutKey = pc.report.length;
  const dmgFoe = last?.damageToDefender ?? 0;
  const dmgHero = last?.damageToAttacker ?? 0;

  // Auto-restore from a momentary minimize when it becomes the human's turn to
  // pick a card, so a pending choice is never hidden and forgotten.
  const wasChoice = useRef(false);
  useEffect(() => {
    if (ch && onChoose && !wasChoice.current) setMin(false);
    wasChoice.current = !!(ch && onChoose);
  }, [ch, onChoose]);

  if (min) {
    return (
      <div className="cb-min" role="dialog" aria-label="Combat (minimized)">
        <span className="cb-min-txt">
          ⚔ Combat r{pc.round} — <b>{hero.name}</b> vs <b>{foe.name}</b> (♥{foe.life}{foeMaxLife ? `/${foeMaxLife}` : ''})
        </span>
        <button className="primary" onClick={() => setMin(false)}>Return to combat ▸</button>
      </div>
    );
  }

  const Side = ({ c, isHero }: { c: Combatant; isHero: boolean }) => {
    const stackIds = pc.stack?.[isHero ? 'attacker' : 'defender'] ?? [];
    return (
      <div className={`cb-side ${isHero ? 'hero' : 'foe'}`}>
        <div className="cb-portrait-wrap">
          {(isHero ? heroImg : foeArt) && (
            <img className="cb-portrait" src={isHero ? heroImg : foeArt} alt=""
              onClick={() => inspect(isHero
                ? { title: c.name, img: heroImg, subtitle: heroDef?.abilityName ?? 'Hero', text: heroDef?.abilityText ?? '' }
                : { title: c.name, img: foeArt, subtitle: `Foe · ♥ ${c.life}${foeMaxLife ? `/${foeMaxLife}` : ''}`, text: foeDef?.ability ?? '' })}
              style={{ cursor: 'pointer' }} />
          )}
          {((isHero && dmgHero > 0) || (!isHero && dmgFoe > 0)) && (
            <span key={boutKey} className="cb-dmg-pop">−{isHero ? dmgHero : dmgFoe}</span>
          )}
          {c.exhausted && <span className="cb-exhausted">EXHAUSTED</span>}
        </div>
        <div className="cb-name">{c.name}</div>
        <div className="cb-stats">
          {isHero && heroDef ? (
            <>
              <Stat label="Fort" val={heroDef.fortitude} />
              <Stat label="Str" val={heroDef.strength} />
              <Stat label="Agi" val={heroDef.agility} />
              <Stat label="Wis" val={heroDef.wisdom} />
            </>
          ) : foeDef ? (
            <>
              <Stat label="Fort" val={foeDef.fortitude} />
              <Stat label="Str" val={foeDef.strength} />
              <Stat label="Wis" val={foeDef.wisdom} />
            </>
          ) : null}
        </div>
        <div className="cb-str">Combat strength <b>{c.strengthSpent}/{c.strength}</b></div>
        {isHero ? (
          <div className="cb-life">
            <span title="Life pool — the hero's deck of cards">🂠 deck <b>{c.deck.length}</b></span>
            <span title="Cards in hand">✋ hand <b>{c.hand.length}</b></span>
            <span title="Damage taken" className="dmg">🩸 damage <b>{c.damagePool.length}</b></span>
          </div>
        ) : (
          <div className="cb-life">
            <span className="foe-hp" title="Monster / minion health">♥ HP <b>{c.life}</b>{foeMaxLife ? <i>/{foeMaxLife}</i> : null}</span>
            <span title="Cards remaining in the foe's combat hand">✋ hand <b>{c.hand.length}</b></span>
          </div>
        )}
        {!isHero && foeDef?.ability && <div className="cb-ability">{foeDef.ability}</div>}
        <div className="cb-stack">
          <span className="cb-stack-h">Cards used ({stackIds.length})</span>
          <div className="cb-stack-row">
            {stackIds.map((id, i) => {
              const cc = cat.combatCards[id];
              const img = cc ? combatCardArt(cc, combatantOwnerKey(cat, c.refId)) : '';
              return img
                ? <img key={i} className="cb-stack-card" src={img} alt="" title={cc?.name} />
                : <span key={i} className="cb-stack-chip" title={cc?.name}>{cc?.name?.[0] ?? '?'}</span>;
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="cb-overlay">
      <div className="cb-board" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>
        <div className="cb-head">
          <h2>⚔ Combat — round {pc.round} <span className="cb-loc">at {cat.locations[pc.locationId]?.name ?? pc.locationId}</span></h2>
          <div className="cb-head-btns">
            {heroDeckBreak && (
              <button className="cb-min-btn" onClick={() => setShowHeroDeck((v) => !v)}
                title="What Sauron legitimately knows about the hero's deck — training identities stay secret until revealed">
                🕵 {hero.name}'s deck (known) {showHeroDeck ? '▴' : '▾'}
              </button>
            )}
            {foeDeckBreak.length > 0 && (
              <button className="cb-min-btn" onClick={() => setShowFoeDeck((v) => !v)}
                title="See every card in the foe's combat deck and how many have already been played">
                🃏 {foe.name}'s deck {showFoeDeck ? '▴' : '▾'}
              </button>
            )}
            <button className="cb-min-btn" onClick={() => setMin(true)} title="Minimize to peek at the map">▁ Minimize</button>
          </div>
        </div>
        {showHeroDeck && heroDeckBreak && (
          <div className="cb-foedeck">
            <p className="cb-foedeck-note">
              {hero.name}'s printed starting deck is always public, and training COUNT is public the moment
              it happens — but WHICH Skill card was kept stays secret until it is actually played or
              discarded somewhere. Cards below with a "?" name are trained cards Sauron knows exist but has
              never seen revealed.
            </p>
            <div className="cb-foedeck-grid">
              {heroDeckBreak.rows.map((d) => {
                const card = cat.combatCards[d.id];
                const img = card ? combatCardArt(card, String(hero.refId)) : '';
                const left = d.total - d.used;
                return (
                  <div key={d.id} className={`cb-foedeck-card ${left <= 0 ? 'spent' : ''}`}
                    title={card?.ability ?? ''}>
                    {img && <img src={img} alt="" />}
                    <span className="cb-foedeck-name">{d.name}</span>
                    <span className="cb-foedeck-count">{left}/{d.total} left</span>
                  </div>
                );
              })}
              {heroDeckBreak.unknownTrained > 0 && (
                <div className="cb-foedeck-card unknown" title="A trained Skill card whose identity has never been revealed">
                  <span className="cb-foedeck-name">? Unknown trained card ×{heroDeckBreak.unknownTrained}</span>
                  <span className="cb-foedeck-count">hidden until revealed</span>
                </div>
              )}
            </div>
          </div>
        )}
        {showFoeDeck && (
          <div className="cb-foedeck">
            <p className="cb-foedeck-note">
              {foe.name}'s physical combat deck — fixed every game, so this is the full set of cards it can
              still draw or play. Grayed-out cards have all their copies already played this fight.
            </p>
            <div className="cb-foedeck-grid">
              {foeDeckBreak.map((d) => {
                const card = cat.combatCards[d.id];
                const img = card ? combatCardArt(card, combatantOwnerKey(cat, foe.refId)) : '';
                const left = d.total - d.used;
                return (
                  <div key={d.id} className={`cb-foedeck-card ${left <= 0 ? 'spent' : ''}`}
                    title={card?.ability ?? ''}>
                    {img && <img src={img} alt="" />}
                    <span className="cb-foedeck-name">{d.name}</span>
                    <span className="cb-foedeck-count">{left}/{d.total} left</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="cb-arena">
          <Side c={hero} isHero />

          <div className="cb-center">
            <div className="cb-reveal">
              <CardFace cat={cat} card={revA} ownerRef={combatantOwnerKey(cat, hero.refId)} kind="atk" />
              <div className="cb-vs">
                <span className="cb-round-badge">r{pc.round}</span>
                <span className="cb-vs-x">VS</span>
              </div>
              <CardFace cat={cat} card={revD} ownerRef={combatantOwnerKey(cat, foe.refId)} kind="def" />
            </div>

            {last && (
              <div key={boutKey} className="cb-happened">
                <span className="cb-happened-note">{last.note}</span>
                <span className="cb-happened-dmg">
                  {dmgFoe > 0 && <b className="to-foe">{foe.name} −{dmgFoe}</b>}
                  {dmgHero > 0 && <b className="to-hero">{hero.name} −{dmgHero}</b>}
                  {dmgFoe === 0 && dmgHero === 0 && <span className="muted">no damage</span>}
                </span>
              </div>
            )}

            <div className="cb-report">
              <div className="cb-report-head"><span>#</span><span>{hero.name}</span><span>{foe.name}</span><span>dmg</span></div>
              <div className="cb-report-body">
                {pc.report.slice(-8).map((r, i) => (
                  <div key={i} className="cb-report-row">
                    <span>r{r.round}</span>
                    <span>{r.attackerCard ? cat.combatCards[r.attackerCard]?.name ?? '—' : '—'}</span>
                    <span>{r.defenderCard ? cat.combatCards[r.defenderCard]?.name ?? '—' : '—'}</span>
                    <span className="cb-report-dmg">{r.damageToDefender > 0 && <em className="d-foe">foe −{r.damageToDefender}</em>}{r.damageToAttacker > 0 && <em className="d-hero">you −{r.damageToAttacker}</em>}{r.damageToDefender === 0 && r.damageToAttacker === 0 && '·'}</span>
                  </div>
                ))}
              </div>
            </div>

            {ch && onChoose && (
              <div className={`cb-choice ${ch.kind === 'combat-prep' ? 'prep' : 'hand'}`}>
                <p className="cb-prompt">{ch.prompt}</p>
                <div className="cb-options">
                  {ch.options.map((o, i) => {
                    const card = cat.combatCards[o.id];
                    const img = card ? combatCardArt(card, hero.refId) : '';
                    const declare = o.id === '__exhaust__';
                    return (
                      <button key={`${o.id}-${i}`}
                        className={declare ? 'cb-opt declare' : 'cb-opt'}
                        onClick={() => onChoose(o.id)}
                        title={card?.ability ?? ''}>
                        {img && <img className="cb-opt-art" src={img} alt="" />}
                        <span className="cb-opt-label">{o.label}</span>
                        {card && <span className="cb-opt-nums">⚔{card.attack} 🛡{card.defense}{card.strengthCost ? ` ✊${card.strengthCost}` : ''}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <Side c={foe} isHero={false} />
        </div>
      </div>
    </div>
  );
}
