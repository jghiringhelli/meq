// SWR-style row of clickable icons that open the public discard piles.
// The heroes and the Sauron player may both inspect any public discard at any
// time (rest pools, the shadow discard, the event discard, and the per-region
// encounter discards). Clicking a pile opens a list; clicking a card in that
// list opens the full art via the shared card inspector.
import { useState } from 'react';
import type { Catalog, GameState } from '../engine/types';
import { useInspect } from './CardInspector';
import { shadowArt, eventArt, encounterArt, combatCardArt } from '../data/art';

interface PileCard { id: string; name: string; img?: string; sub?: string; text?: string; }
interface Pile { key: string; icon: string; label: string; cards: PileCard[]; }

function buildPiles(state: GameState, cat: Catalog): Pile[] {
  const piles: Pile[] = [];

  // Shadow discard (Sauron's spent reaction cards) — public once played.
  const shadow = (state.sauron.shadowDiscard ?? []).map((id) => {
    const c = cat.shadow[id];
    return { id, name: c?.name ?? id, img: shadowArt(id), sub: c ? `pool ${c.poolRequirement} · ${c.timing}` : undefined, text: c?.effect };
  });
  piles.push({ key: 'shadow', icon: '👁', label: 'Shadow', cards: shadow });

  // Event discard (resolved story events).
  const evd = (state.sauron.eventDiscard ?? []).map((id) => {
    const c = cat.events.find((e) => e.id === id);
    return { id, name: c?.name ?? id, img: eventArt(id), sub: c ? `turn ${c.turn}` : undefined, text: c?.text };
  });
  piles.push({ key: 'event', icon: '📜', label: 'Events', cards: evd });

  // The board game deals each region its own separate Encounter deck and
  // discard pile — never a single shared pile — so surface one chip per
  // region (always shown, even before its first draw) instead of flattening
  // them together.
  const encMap = state.encounterDiscards ?? {};
  const regions = new Set<string>(Object.keys(encMap));
  for (const enc of Object.values(cat.encounters)) regions.add(enc.regionGroup);
  for (const region of Array.from(regions).sort()) {
    const cards: PileCard[] = (encMap[region] ?? []).map((id) => {
      const c = cat.encounters[id];
      return { id, name: c?.name ?? id, img: encounterArt(id), text: (c as { text?: string })?.text };
    });
    piles.push({ key: `encounter-${region}`, icon: '🗺', label: `Enc: ${region}`, cards });
  }

  // Each hero's rest pool (discard) is a public "combat train".
  for (const h of state.heroes) {
    const cards = (h.discard ?? []).map((id) => {
      const c = cat.combatCards[id];
      return {
        id: `${h.id}:${id}`, name: c?.name ?? id,
        img: c ? combatCardArt(c, h.id) : undefined,
        sub: c ? `${c.type} · atk ${c.attack} def ${c.defense}` : undefined, text: c?.ability,
      };
    });
    piles.push({ key: `hero-${h.id}`, icon: '🂠', label: cat.heroes[h.id]?.name ?? h.id, cards });
  }

  return piles;
}

export default function DeckBar({ state, cat }: { state: GameState; cat: Catalog }) {
  const [open, setOpen] = useState<string | null>(null);
  const inspect = useInspect();
  const piles = buildPiles(state, cat);
  const active = piles.find((p) => p.key === open) ?? null;

  return (
    <div className="deck-bar">
      <span className="deck-bar-title">Discards</span>
      {piles.map((p) => (
        <button key={p.key} className={`deck-chip${open === p.key ? ' active' : ''}`}
          disabled={p.cards.length === 0}
          title={`${p.label} discard — ${p.cards.length} card(s)`}
          onClick={() => setOpen(open === p.key ? null : p.key)}>
          <span className="deck-chip-icon">{p.icon}</span>
          <span className="deck-chip-label">{p.label}</span>
          <span className="deck-chip-count">{p.cards.length}</span>
        </button>
      ))}

      {active && active.cards.length > 0 && (
        <div className="deck-pop-overlay" onClick={() => setOpen(null)}>
          <div className="deck-pop" onClick={(e) => e.stopPropagation()}>
            <div className="deck-pop-head">
              <span>{active.label} discard · {active.cards.length}</span>
              <button className="deck-pop-close" onClick={() => setOpen(null)}>✕</button>
            </div>
            <div className="deck-pop-list">
              {active.cards.map((c, i) => (
                <button key={c.id + i} className="deck-pop-card"
                  onClick={() => inspect({ title: c.name, img: c.img, subtitle: c.sub, text: c.text })}>
                  {c.img && <img src={c.img} alt={c.name} />}
                  <span className="deck-pop-name">{c.name}</span>
                  {c.sub && <span className="deck-pop-sub">{c.sub}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
