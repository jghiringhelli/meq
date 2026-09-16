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

/** Aggregate a hero's combat deck (from the catalog's expanded card-id list)
 *  into "2× Rush — melee A1/D2 · Mountain" style lines, so a new player can
 *  see roughly what they're getting into before picking a hero — without
 *  having to start a game first and open the in-game Hero decks reference. */
function deckSummaryLines(cat: Catalog, deckIds: CardId[]): string[] {
  const counts = new Map<CardId, number>();
  for (const id of deckIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([id, n]) => {
      const c = cat.combatCards[id];
      if (!c) return `${n}× ${id}`;
      const terrain = c.terrain ? ` · ${c.terrain}` : '';
      return `${n}× ${c.name} — ${c.type} A${c.attack}/D${c.defense}${terrain}`;
    })
    .sort();
}

export default function NewGameSetup({ cat, onStart, onCancel }: Props) {
  const roster = Object.keys(cat.heroes) as HeroId[];
  const [side, setSide] = useState<Side>('Hero');
  const [selected, setSelected] = useState<HeroId[]>(() => roster.slice(0, 2));
  const inspect = useInspect();

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
