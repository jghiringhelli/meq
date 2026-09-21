import { useState } from 'react';
import type { CardId, Catalog, HeroId } from '../engine/types';
import { heroArt } from '../data/art';
import { useInspect } from './CardInspector';

/** A hero's card art image, falling back to a plain icon tile if no art is
 *  loaded (or the image fails to load) instead of a browser broken-image
 *  glyph — much clearer for a first-time player. */
function HeroCardArt({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="hero-card-art-fallback">🧙</div>;
  return <img src={src} alt="" className="hero-card-art" onError={() => setFailed(true)} />;
}

type Side = 'Hero' | 'Sauron';

interface Props {
  cat: Catalog;
  onStart: (heroIds: HeroId[], side: Side) => void;
  onCancel: () => void;
}

const MAX_HEROES = 3;

/** First sentence (or ~90 chars) of an ability's rules text, for an
 *  always-visible one-liner on the card — the full text is still in the
 *  "ⓘ details" modal and the hover title. Without this, a new player only
 *  ever sees the power's NAME on the card ("Iron Will"), never what it does. */
function abilityBlurb(text: string): string {
  const t = (text || '').trim();
  if (!t) return '';
  const firstSentence = t.match(/^[^.!?]*[.!?]/)?.[0] ?? t;
  const s = firstSentence.trim();
  return s.length > 92 ? `${s.slice(0, 89).trimEnd()}…` : s;
}

/** Fisher–Yates partial shuffle: n distinct random picks from arr. */
function pickRandom<T>(arr: T[], n: number): T[] {
  const pool = arr.slice();
  const out: T[] = [];
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(pool[i]);
  }
  return out;
}

/** Aggregate a hero's combat deck (from the catalog's expanded card-id list)
 *  into "2× Rush — melee A1/D2 · Mountain — draw an extra card" style lines
 *  (name, stats, terrain restriction, and the card's own rules text), so a new
 *  player can see roughly what they're getting into before picking a hero —
 *  without having to start a game first and open the in-game Hero decks
 *  reference. */
function deckSummaryLines(cat: Catalog, deckIds: CardId[]): string[] {
  const counts = new Map<CardId, number>();
  for (const id of deckIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([id, n]) => {
      const c = cat.combatCards[id];
      if (!c) return `${n}× ${id}`;
      const terrain = c.terrain ? ` · ${c.terrain}` : '';
      const ability = c.ability ? ` — ${c.ability}` : '';
      return `${n}× ${c.name} — ${c.type} A${c.attack}/D${c.defense}${terrain}${ability}`;
    })
    .sort();
}

export default function NewGameSetup({ cat, onStart, onCancel }: Props) {
  const roster = Object.keys(cat.heroes) as HeroId[];
  const [side, setSide] = useState<Side>('Hero');
  const [selected, setSelected] = useState<HeroId[]>(() => roster.slice(0, 2));
  const [randomCount, setRandomCount] = useState(2);
  const inspect = useInspect();

  const randomize = () => setSelected(pickRandom(roster, randomCount));

  const showDetails = (id: HeroId) => {
    const h = cat.heroes[id];
    const art = heroArt(id);
    const deckIds = cat.decks[h.deck] ?? [];
    const deckLines = deckSummaryLines(cat, deckIds);
    inspect({
      title: h.name,
      img: art.sheet || art.figure || '',
      subtitle: h.abilityName,
      lines: [
        `Fortitude ${h.fortitude} · Strength ${h.strength} · Agility ${h.agility} · Wisdom ${h.wisdom}`,
        `Combat hand mix: ${h.ratioMelee} melee / ${h.ratioRanged} ranged`,
        `Starts at ${h.startLocationName}`,
        ...(h.startItems?.length ? [`Starting items: ${h.startItems.join(', ')}`] : []),
      ],
      text: [
        h.abilityText,
        deckLines.length ? `\nCombat deck (${deckIds.length} cards):\n${deckLines.join('\n')}` : '',
      ].filter(Boolean).join('\n'),
    });
  };

  const toggle = (id: HeroId) => {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_HEROES) return cur;
      return [...cur, id];
    });
  };

  const canStart = selected.length >= 1;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Middle-earth Quest</h1>
        <span className="subtitle">new game setup</span>
      </header>
      <main className="app-main setup">
        <section className="setup-block">
          <h2>Choose your side</h2>
          <div className="side-pick">
            <button
              className={`side-btn${side === 'Hero' ? ' active' : ''}`}
              onClick={() => setSide('Hero')}>
              <strong>The Heroes</strong>
              <span>Guide 1–3 heroes of the Free Peoples.</span>
            </button>
            <button
              className={`side-btn${side === 'Sauron' ? ' active' : ''}`}
              onClick={() => setSide('Sauron')}>
              <strong>Sauron</strong>
              <span>Command the Lidless Eye vs AI-driven heroes.</span>
            </button>
          </div>
          {side === 'Sauron' && (
            <p className="setup-note">
              You play Sauron interactively — plots, influence, minions and shadow cards.
              The heroes you pick below are controlled by the AI. Choose how many (1–3)
              oppose you.
            </p>
          )}
        </section>

        <section className="setup-block">
          <h2>Choose the heroes {side === 'Sauron' ? '(your AI opponents)' : ''} <span className="count">({selected.length}/{MAX_HEROES})</span></h2>
          <p className="setup-hint">Click a card to add/remove that hero (up to 3). ♥ Fortitude (health) · STR Strength (melee) · AGI Agility (ranged/evasion) · WIS Wisdom (encounters/quests). Click "ⓘ details" for the hero's power and combat deck.</p>
          <div className="hero-randomize">
            <label>
              🎲 Randomize
              <select value={randomCount} onChange={(e) => setRandomCount(Number(e.target.value))}>
                {Array.from({ length: MAX_HEROES }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n} hero{n > 1 ? 'es' : ''}</option>
                ))}
              </select>
            </label>
            <button type="button" className="ghost" onClick={randomize}>🎲 Assign randomly</button>
          </div>
          <div className="hero-pick">
            {roster.map((id) => {
              const h = cat.heroes[id];
              const on = selected.includes(id);
              const art = heroArt(id);
              const img = art.sheet || art.figure || '';
              return (
                <div key={id} className="hero-card-wrap">
                  <button
                    className={`hero-card${on ? ' on' : ''}`}
                    onClick={() => toggle(id)}>
                    <div className="hero-card-art-wrap"><HeroCardArt src={img} /></div>
                    <span className="hero-card-name">{h.name}</span>
                    <span className="hero-card-power" title={h.abilityText}>✦ {h.abilityName}</span>
                    <span className="hero-card-ability">{abilityBlurb(h.abilityText)}</span>
                    <span className="hero-card-stats">
                      <span title="Fortitude (health)">♥ {h.fortitude}</span>
                      <span title="Strength (melee combat)">STR {h.strength}</span>
                      <span title="Agility (ranged combat & evasion)">AGI {h.agility}</span>
                      <span title="Wisdom (encounters, quests, Dark path)">WIS {h.wisdom}</span>
                    </span>
                    {on && <span className="hero-card-check">✓</span>}
                  </button>
                  <button type="button" className="hero-card-info" title="Full details: power, stats, combat deck"
                    onClick={(e) => { e.stopPropagation(); showDetails(id); }}>
                    ⓘ details
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <div className="setup-actions">
          <button className="ghost" onClick={onCancel}>Back</button>
          <button className="primary" disabled={!canStart}
            onClick={() => onStart(selected, side)}>
            {side === 'Sauron' ? 'Command Sauron' : 'Begin quest'}
          </button>
        </div>
      </main>
    </div>
  );
}
