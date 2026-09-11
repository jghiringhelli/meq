// SWR-style reference almanac: tabs across the top open a hoverable browser of
// every catalog entity AND the live state of every deck. Hovering a row shows a
// preview (art + stats + rules); clicking opens the full-art card inspector.
//
// Two kinds of tab:
//  • Catalog tabs (Bestiary, Minions, Heroes, Items, Characters) list every
//    entry alphabetically — pure reference, no game state.
//  • Deck tabs (Perils, Plots, Shadow, Corruption, Events, Encounters, Hero
//    decks) show, per deck, the cards still IN the deck (ALPHABETICAL — the real
//    draw order is secret) and the public discard pile. Hidden hands are folded
//    into "In deck" so the exact hand can never be deduced by elimination (only
//    discards are public).
import { useEffect, useMemo, useState } from 'react';
import type { Catalog, GameState, CardId, LocationId } from '../engine/types';
import { useInspect } from './CardInspector';
import {
  monsterArt, minionArt, plotArt, shadowArt, perilArt, corruptionArt, heroArt,
  encounterArt, eventArt, combatCardArt, itemArt, characterArt,
  itemArtKeys, characterArtKeys,
} from '../data/art';

interface RefItem { id: string; name: string; img?: string; sub?: string; lines?: string[]; text?: string; count?: number; }
interface RefSection { label: string; items: RefItem[]; empty?: string; }
interface RefGroup { key: string; label: string; sections: RefSection[]; }
interface RefTab { key: string; icon: string; label: string; groups: RefGroup[]; }

const byName = (a: RefItem, b: RefItem) => a.name.localeCompare(b.name);
const pretty = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const locName = (cat: Catalog, id: string) => cat.locations[id]?.name ?? id;

// ---- per-kind id → RefItem resolvers ----------------------------------
function plotItem(cat: Catalog, id: CardId): RefItem {
  const p = cat.plots.find((x) => x.id === id);
  if (!p) return { id, name: id };
  return {
    id, name: p.name, img: plotArt(p.image),
    sub: `${p.starting ? 'Starting · ' : ''}${p.markerName ?? p.marker ?? 'red'} +${p.advance ?? 1} · counter ${p.favorToCounter ?? 0} ✦`,
    lines: [p.affectsText ? `Affects: ${p.affectsText}` : '', p.condition ? `Requires: ${p.condition}` : ''].filter(Boolean),
    text: p.effect || p.rulesText,
  };
}
function shadowItem(cat: Catalog, id: CardId): RefItem {
  const c = cat.shadow[id];
  return c ? { id, name: c.name, img: shadowArt(id), sub: `pool ${c.poolRequirement} · ${c.timing}`, text: c.effect } : { id, name: id };
}
function eventItem(cat: Catalog, id: CardId): RefItem {
  const c = cat.events.find((e) => e.id === id);
  return c ? { id, name: c.name, img: eventArt(id), sub: `turn ${c.turn}`, text: c.text } : { id, name: id };
}
function encounterItem(cat: Catalog, id: CardId): RefItem {
  const c = cat.encounters[id];
  return c ? { id, name: c.name, img: encounterArt(id), sub: c.location || c.regionGroup, text: c.effect } : { id, name: id };
}
function combatItem(cat: Catalog, id: CardId): RefItem {
  const c = cat.combatCards[id];
  return c
    ? { id, name: c.name, img: combatCardArt(c), sub: `${c.type} · A${c.attack}/D${c.defense} · ${c.terrain || 'any'}`, text: c.ability }
    : { id, name: id };
}
function perilItem(cat: Catalog, id: CardId): RefItem {
  const c = cat.perils[id];
  return c
    ? { id, name: c.name, img: perilArt(id), sub: [c.location, c.region].filter(Boolean).join(' · '), text: c.effect }
    : { id, name: id };
}
function corruptionItem(cat: Catalog, id: CardId): RefItem {
  const c = cat.corruption[id];
  return c ? { id, name: c.name, img: corruptionArt(id), sub: `discard cost ${c.cost}`, text: c.ability } : { id, name: id };
}

/** Group a list of ids into counted, alphabetically-sorted RefItems. */
function aggregate(ids: CardId[], resolve: (id: CardId) => RefItem): RefItem[] {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  return Object.entries(counts)
    .map(([id, n]) => ({ ...resolve(id), count: n }))
    .sort(byName);
}

/** Live board-state overview: a single convenient panel listing where every
 *  public thing sits on the map — Sauron influence, heroes, minions, monsters,
 *  allies, favor, quest markers — plus the story markers. Hidden information is
 *  respected: to a hero, unrevealed monster/rumor tokens are shown only as a
 *  face-down count (their identity is disclosed only where revealed, or when the
 *  viewer plays Sauron). */
function boardGroups(cat: Catalog, state: GameState): RefGroup[] {
  const m = state.map;
  const heroView = state.humanSide !== 'Sauron';
  const sections: RefSection[] = [];

  // Story markers (public).
  const st = state.story;
  const sm = st.sauron ?? { yellow: 0, red: 0, black: 0 };
  sections.push({
    label: 'Story markers', empty: '—', items: [
      { id: 'sm-hero', name: 'Heroes (green)', sub: `space ${st.heroMarker ?? 0} / ${st.length}` },
      { id: 'sm-yellow', name: 'Sauron · yellow', sub: `space ${sm.yellow}` },
      { id: 'sm-red', name: 'Sauron · red', sub: `space ${sm.red}` },
      { id: 'sm-black', name: 'Sauron · black', sub: `space ${sm.black}` },
    ],
  });

  // Sauron influence (public: tokens are visible on the board).
  const inf = state.sauron.locationInfluence ?? {};
  const infItems: RefItem[] = Object.entries(inf)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id: `inf-${id}`, name: locName(cat, id), sub: `${n} influence` }));
  infItems.unshift({ id: 'inf-pool', name: 'Shadow Pool', sub: `${state.sauron.influence} influence` });
  sections.push({ label: 'Sauron influence', items: infItems, empty: 'none on the map' });

  // Heroes.
  sections.push({
    label: 'Heroes', empty: 'none',
    items: state.heroes.map((h) => ({
      id: `hero-${h.id}`, name: cat.heroes[h.id]?.name ?? h.id,
      img: heroArt(h.id).portrait || heroArt(h.id).figure,
      sub: `${locName(cat, h.location)} · ${h.favor}✦ · life ${h.life} · corr ${h.corruption} · ${h.items.length} items`,
    })),
  });

  // Minions (named elites — public), with carried-over health when tracked.
  const minionItems: RefItem[] = [];
  for (const [loc, ids] of Object.entries(m.minionsAt ?? {})) {
    for (const id of ids) {
      const mm = cat.minions[id];
      const hp = m.minionHealth?.[id];
      minionItems.push({
        id: `min-${loc}-${id}`, name: mm?.name ?? id, img: minionArt(mm?.image ?? ''),
        sub: `${locName(cat, loc)}${hp != null ? ` · health ${hp}` : ''}`,
      });
    }
  }
  sections.push({ label: 'Minions', items: minionItems.sort(byName), empty: 'none on the board' });

  // Monsters — hidden-info aware.
  const revealed = new Set(m.revealedMonstersAt ?? []);
  const monLocs = new Set<string>([...Object.keys(m.monstersAt ?? {}), ...Object.keys(m.rumorsAt ?? {})]);
  const monItems: RefItem[] = [];
  for (const loc of monLocs) {
    const mons = m.monstersAt?.[loc] ?? [];
    const rumors = m.rumorsAt?.[loc] ?? 0;
    if (!mons.length && !rumors) continue;
    if (!heroView || revealed.has(loc)) {
      const parts = mons.map((id) => cat.monsters[id]?.name ?? id);
      if (rumors) parts.push(`${rumors} false rumor${rumors > 1 ? 's' : ''}`);
      monItems.push({ id: `mon-${loc}`, name: locName(cat, loc), sub: parts.join(', ') });
    } else {
      const tokens = mons.length + rumors;
      monItems.push({ id: `mon-${loc}`, name: locName(cat, loc), sub: `${tokens} face-down token${tokens > 1 ? 's' : ''}` });
    }
  }
  sections.push({ label: 'Monsters', items: monItems.sort(byName), empty: 'none on the board' });

  // Characters / allies: ALWAYS list every Character in the game (all 8),
  // showing where each is currently placed, or "not yet placed" if its Quote
  // hasn't put it on the board yet — so the player can discover the full set
  // rather than only ones already encountered.
  const placedAt = new Map<string, LocationId>();
  for (const [loc, names] of Object.entries(m.charactersAt ?? {})) {
    for (const nm of names) placedAt.set(nm, loc as LocationId);
  }
  const charItems: RefItem[] = characterArtKeys().map((nm) => {
    const loc = placedAt.get(nm);
    return { id: `char-${nm}`, name: pretty(nm), img: characterArt(nm), sub: loc ? locName(cat, loc) : 'not yet placed' };
  });
  sections.push({ label: 'Characters / allies', items: charItems.sort(byName), empty: 'none' });

  // Favor tokens sitting on the board (retrievable).
  sections.push({
    label: 'Favor on the board', empty: 'none',
    items: Object.entries(m.favorAt ?? {}).filter(([, n]) => n > 0)
      .map(([loc, n]) => ({ id: `fav-${loc}`, name: locName(cat, loc), sub: `${n} favor` })).sort(byName),
  });

  // Active quest markers.
  const questItems: RefItem[] = [];
  for (const [loc, ids] of Object.entries(m.questAt ?? {})) {
    if (!ids.length) continue;
    questItems.push({ id: `q-${loc}`, name: locName(cat, loc), sub: ids.map((id) => cat.heroes[id]?.name ?? id).join(', ') });
  }
  sections.push({ label: 'Quest markers', items: questItems.sort(byName), empty: 'none active' });

  return [{ key: 'all', label: '', sections }];
}

function buildTabs(cat: Catalog, state: GameState): RefTab[] {
  const one = (items: RefItem[]): RefGroup[] => [{ key: 'all', label: '', sections: [{ label: '', items, empty: 'none' }] }];

  // ---- catalog tabs ----
  const monsters = Object.values(cat.monsters).map((m) => ({
    id: m.id, name: m.name, img: monsterArt(m.id),
    sub: `Fort ${m.fortitude} · Str ${m.strength} · Wis ${m.wisdom}`, text: m.ability,
  })).sort(byName);

  const minions = Object.values(cat.minions).map((m) => ({
    id: m.id, name: m.name, img: minionArt(m.image),
    sub: `Health ${m.health} · Fort ${m.fortitude} · Str ${m.strength} · Wis ${m.wisdom}`,
    lines: [m.stage ? `Activates at stage ${m.stage}` : ''].filter(Boolean), text: m.ability,
  })).sort(byName);

  const heroes = Object.values(cat.heroes).map((h) => ({
    id: h.id, name: h.name, img: heroArt(h.id).portrait || heroArt(h.id).figure,
    sub: `Fort ${h.fortitude} · Str ${h.strength} · Agi ${h.agility} · Wis ${h.wisdom}`,
    lines: [h.abilityName], text: h.abilityText,
  })).sort(byName);

  // Items: names referenced by hero start items + any that have art.
  const itemNames = new Set<string>();
  for (const h of Object.values(cat.heroes)) (h.startItems ?? []).forEach((i) => itemNames.add(i));
  for (const k of itemArtKeys()) itemNames.add(k);
  const items = [...itemNames]
    .filter((n) => !/^item-/.test(n))
    .map((n) => ({ id: n, name: pretty(n), img: itemArt(n), sub: 'Item' }))
    .sort(byName);

  // Characters: consultable NPCs (from the art manifest).
  const characters = characterArtKeys().map((n) => ({
    id: n, name: pretty(n), img: characterArt(n), sub: 'Character — consult for 2 favor or recruit as ally',
  })).sort(byName);

  // ---- deck tabs (live state) ----
  const sa = state.sauron;

  // Plots: only the regular Sauron plots. The four event-deck plots (marked
  // eventDeckPlot) are excluded — they belong to the stage Event deck, not here.
  // In deck = regular plots − discard − in play.
  const plotDiscard = sa.plotDiscard ?? [];
  const activePlotIds = (sa.activePlots ?? []).map((p) => p.eventId);
  const out = new Set([...plotDiscard, ...activePlotIds]);
  const plotInDeck = cat.plots.filter((p) => !p.starting && !p.eventDeckPlot && !out.has(p.id)).map((p) => p.id);
  const plotsTab: RefGroup[] = [{
    key: 'all', label: '', sections: [
      { label: 'In deck', items: aggregate(plotInDeck, (id) => plotItem(cat, id)), empty: 'deck empty' },
      { label: 'In play', items: aggregate(activePlotIds, (id) => plotItem(cat, id)), empty: 'no active plots' },
      { label: 'Discard', items: aggregate(plotDiscard, (id) => plotItem(cat, id)), empty: 'discard empty' },
    ],
  }];

  // Shadow: universe = all shadow cards. In deck = universe − discard (folds hand).
  const shadowDiscard = sa.shadowDiscard ?? [];
  const shadowOut = new Set(shadowDiscard);
  const shadowInDeck = Object.keys(cat.shadow).filter((id) => !shadowOut.has(id));
  const shadowTab: RefGroup[] = [{
    key: 'all', label: '', sections: [
      { label: 'In deck', items: aggregate(shadowInDeck, (id) => shadowItem(cat, id)), empty: 'deck empty' },
      { label: 'Discard', items: aggregate(shadowDiscard, (id) => shadowItem(cat, id)), empty: 'discard empty' },
    ],
  }];

  // Events: each game stage (turn 1/2/3) has its OWN 14-card Event deck. Show a
  // sub-deck per stage: In deck = that stage's catalog minus its public discard.
  const evDiscard = sa.eventDiscard ?? [];
  const eventGroups: RefGroup[] = ['1', '2', '3'].map((stage) => {
    const universe = cat.events.filter((e) => String(e.turn) === stage).map((e) => e.id);
    const uniSet = new Set(universe);
    const discard = evDiscard.filter((id) => uniSet.has(id));
    const dc: Record<string, number> = {};
    for (const id of discard) dc[id] = (dc[id] ?? 0) + 1;
    const inDeck = universe.filter((id) => (dc[id] ? (dc[id]--, false) : true));
    return {
      key: stage, label: `Stage ${stage}`,
      sections: [
        { label: 'In deck', items: aggregate(inDeck, (id) => eventItem(cat, id)), empty: 'deck empty' },
        { label: 'Discard', items: aggregate(discard, (id) => eventItem(cat, id)), empty: 'discard empty' },
      ],
    };
  });

  // Encounters: one sub-deck per region. In deck = live deck if built, else the
  // region's full catalog minus its discard.
  const regions = [...new Set(Object.values(cat.encounters).map((e) => e.regionGroup))].sort();
  const encGroups: RefGroup[] = regions.map((region) => {
    const discard = state.encounterDiscards?.[region] ?? [];
    const live = state.encounterDecks?.[region];
    let inDeck: CardId[];
    if (live && live.length) {
      inDeck = live;
    } else {
      const universe = Object.values(cat.encounters).filter((e) => e.regionGroup === region).map((e) => e.id);
      const dc: Record<string, number> = {};
      for (const id of discard) dc[id] = (dc[id] ?? 0) + 1;
      inDeck = universe.filter((id) => (dc[id] ? (dc[id]--, false) : true));
    }
    return {
      key: region, label: region,
      sections: [
        { label: 'In deck', items: aggregate(inDeck, (id) => encounterItem(cat, id)), empty: 'deck empty' },
        { label: 'Discard', items: aggregate(discard, (id) => encounterItem(cat, id)), empty: 'discard empty' },
      ],
    };
  });

  // Hero decks: per hero, In deck (life pool + hand, folded) + Discard (rest pool).
  const heroGroups: RefGroup[] = state.heroes.map((h) => ({
    key: h.id, label: cat.heroes[h.id]?.name ?? h.id,
    sections: [
      { label: 'In deck (life pool)', items: aggregate([...h.deck, ...h.hand], (id) => combatItem(cat, id)), empty: 'empty' },
      { label: 'Discard (rest pool)', items: aggregate(h.discard ?? [], (id) => combatItem(cat, id)), empty: 'discard empty' },
    ],
  }));

  // Perils: In deck = live perilDeck if built, else the full catalog minus the
  // public discard (order hidden). Discard = perilDiscard.
  const perilDiscard = sa.perilDiscard ?? [];
  let perilInDeck: CardId[];
  if (sa.perilDeck && sa.perilDeck.length) {
    perilInDeck = sa.perilDeck;
  } else {
    const universe = Object.keys(cat.perils);
    const dc: Record<string, number> = {};
    for (const id of perilDiscard) dc[id] = (dc[id] ?? 0) + 1;
    perilInDeck = universe.filter((id) => (dc[id] ? (dc[id]--, false) : true));
  }
  const perilsTab: RefGroup[] = [{
    key: 'all', label: '', sections: [
      { label: 'In deck', items: aggregate(perilInDeck, (id) => perilItem(cat, id)), empty: 'deck empty' },
      { label: 'Discard', items: aggregate(perilDiscard, (id) => perilItem(cat, id)), empty: 'discard empty' },
    ],
  }];

  // Corruption: In deck = live corruptionDeck if built, else catalog minus the
  // discard minus the cards currently held by heroes. On heroes = the ongoing
  // penalties in play. Discard = corruptionDiscard.
  const corrDiscard = state.corruptionDiscard ?? [];
  const corrOnHeroes = state.heroes.flatMap((h) => h.corruptionCards ?? []);
  let corrInDeck: CardId[];
  if (state.corruptionDeck && state.corruptionDeck.length) {
    corrInDeck = state.corruptionDeck;
  } else {
    const universe = Object.keys(cat.corruption);
    const dc: Record<string, number> = {};
    for (const id of [...corrDiscard, ...corrOnHeroes]) dc[id] = (dc[id] ?? 0) + 1;
    corrInDeck = universe.filter((id) => (dc[id] ? (dc[id]--, false) : true));
  }
  const corruptionTab: RefGroup[] = [{
    key: 'all', label: '', sections: [
      { label: 'In deck', items: aggregate(corrInDeck, (id) => corruptionItem(cat, id)), empty: 'deck empty' },
      { label: 'On heroes', items: aggregate(corrOnHeroes, (id) => corruptionItem(cat, id)), empty: 'none in play' },
      { label: 'Discard', items: aggregate(corrDiscard, (id) => corruptionItem(cat, id)), empty: 'discard empty' },
    ],
  }];

  return [
    { key: 'board', icon: '📍', label: 'Board', groups: boardGroups(cat, state) },
    { key: 'monsters', icon: '👹', label: 'Bestiary', groups: one(monsters) },
    { key: 'minions', icon: '☠', label: 'Minions', groups: one(minions) },
    { key: 'heroes', icon: '🛡', label: 'Heroes', groups: one(heroes) },
    { key: 'items', icon: '🎒', label: 'Items', groups: one(items) },
    { key: 'characters', icon: '🧙', label: 'Characters', groups: one(characters) },
    { key: 'perils', icon: '⚡', label: 'Perils', groups: perilsTab },
    { key: 'plots', icon: '📕', label: 'Plots', groups: plotsTab },
    { key: 'shadow', icon: '👁', label: 'Shadow', groups: shadowTab },
    { key: 'corruption', icon: '☠', label: 'Corruption', groups: corruptionTab },
    { key: 'events', icon: '📜', label: 'Events', groups: eventGroups },
    { key: 'encounters', icon: '🗺', label: 'Encounters', groups: encGroups },
    { key: 'herodecks', icon: '🂠', label: 'Hero decks', groups: heroGroups },
  ];
}

export default function RefTabs({ state, cat }: { state: GameState; cat: Catalog }) {
  const [open, setOpen] = useState<string | null>(null);
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<RefItem | null>(null);
  const inspect = useInspect();
  const tabs = useMemo(() => buildTabs(cat, state), [cat, state]);
  const active = tabs.find((t) => t.key === open) ?? null;
  const group = active?.groups.find((g) => g.key === groupKey) ?? active?.groups[0] ?? null;

  // Default the preview to the first item whenever the open tab/group changes.
  useEffect(() => {
    const first = group?.sections.find((s) => s.items.length)?.items[0] ?? null;
    setPreview(first);
  }, [open, groupKey, group]);

  const openTab = (key: string) => {
    setOpen(open === key ? null : key);
    setGroupKey(null);
  };

  // The board's on-map deck piles dispatch this to open their reference listing.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const raw = (e as CustomEvent<string>).detail;
      const [key, groupSel] = raw.split(':');
      if (tabs.some((t) => t.key === key && t.groups.length)) {
        setGroupKey(groupSel ?? null);
        setOpen(key);
      }
    };
    window.addEventListener('meq-open-ref', onOpen as EventListener);
    return () => window.removeEventListener('meq-open-ref', onOpen as EventListener);
  }, [tabs]);

  return (
    <div className="ref-tabs">
      <span className="ref-tabs-title">Reference</span>
      {tabs.map((t) => (
        <button key={t.key} className={`ref-tab${open === t.key ? ' active' : ''}`}
          disabled={t.groups.length === 0}
          onClick={() => openTab(t.key)}>
          <span className="ref-tab-icon">{t.icon}</span>
          <span className="ref-tab-label">{t.label}</span>
        </button>
      ))}

      {active && group && (
        <div className="ref-pop-overlay" onClick={() => setOpen(null)}>
          <div className="ref-pop" onClick={(e) => e.stopPropagation()}>
            <div className="ref-pop-head">
              <span>{active.icon} {active.label}{group.label ? ` · ${group.label}` : ''}</span>
              <button className="ref-pop-close" onClick={() => setOpen(null)}>✕</button>
            </div>

            {active.groups.length > 1 && (
              <div className="ref-subpills">
                {active.groups.map((g) => (
                  <button key={g.key} className={`ref-subpill${group.key === g.key ? ' active' : ''}`}
                    onClick={() => setGroupKey(g.key)}>{g.label}</button>
                ))}
              </div>
            )}

            <div className="ref-pop-body">
              <div className="ref-pop-list">
                {group.sections.map((sec) => (
                  <div key={sec.label} className="ref-section">
                    {sec.label && (
                      <div className="ref-section-head">{sec.label} · {sec.items.length}</div>
                    )}
                    {sec.items.length === 0
                      ? <div className="ref-section-empty">{sec.empty ?? 'none'}</div>
                      : sec.items.map((it) => (
                        <button key={sec.label + it.id}
                          className={`ref-row${preview === it ? ' hover' : ''}`}
                          onMouseEnter={() => setPreview(it)} onFocus={() => setPreview(it)}
                          onClick={() => inspect({ title: it.name, img: it.img, subtitle: it.sub, lines: it.lines, text: it.text })}>
                          {it.img
                            ? <img className="ref-row-thumb" src={it.img} alt="" />
                            : <span className="ref-row-thumb ref-row-thumb--blank">{it.name[0]}</span>}
                          <span className="ref-row-text">
                            <span className="ref-row-name">{it.name}{it.count && it.count > 1 ? ` ×${it.count}` : ''}</span>
                            {it.sub && <span className="ref-row-sub">{it.sub}</span>}
                          </span>
                        </button>
                      ))}
                  </div>
                ))}
              </div>
              {preview && (
                <div className="ref-preview">
                  {preview.img && <img className="ref-preview-art" src={preview.img} alt={preview.name} />}
                  <div className="ref-preview-body">
                    <h4>{preview.name}</h4>
                    {preview.sub && <div className="ref-preview-sub">{preview.sub}</div>}
                    {preview.lines && preview.lines.length > 0 && (
                      <ul className="ref-preview-lines">{preview.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                    )}
                    {preview.text && <p className="ref-preview-text">{preview.text}</p>}
                    <div className="ref-preview-hint">Click for full card ▸</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
