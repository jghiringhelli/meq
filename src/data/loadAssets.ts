// Build an immutable Catalog from assets/*.json and validate id references.
// JSON imported at build time (resolveJsonModule).

import heroesData from '../../assets/heroes.json';
import locationsData from '../../assets/locations.json';
import adjacencyData from '../../assets/adjacency.json';
import combatData from '../../assets/combat-cards.json';
import monstersData from '../../assets/monsters.json';
import minionsData from '../../assets/minions.json';
import eventsData from '../../assets/events.json';
import encountersData from '../../assets/encounters.json';
import missionsData from '../../assets/missions.json';
import scenarioData from '../../assets/scenario.json';
import perilData from '../../assets/peril.json';
import shadowData from '../../assets/shadow.json';
import plotsData from '../../assets/plots.json';
import monsterBagsData from '../../assets/monster-bags.json';
import questsData from '../../assets/quests.json';
import corruptionData from '../../assets/corruption.json';

import type {
  Catalog, Hero, Location, PathEdge, CombatCard, Monster, Minion, EventCard, Mission,
  Scenario, CardId, EncounterCard, PerilCard, ShadowCard, Plot, EffectKey, MonsterBag, Quest,
  CorruptionCard,
} from '../engine/types';

function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of rows) {
    if (out[r.id]) throw new Error(`Duplicate id '${r.id}' in catalog`);
    out[r.id] = r;
  }
  return out;
}

/** Derive the legacy `kind`/`perilous` fields from the canonical flag model so
 *  existing readers keep working while flags remain the single JSON source. */
function toLocation(r: Omit<Location, 'kind' | 'perilous'>): Location {
  return {
    ...r,
    kind: r.haven ? 'haven' : r.fortress ? 'stronghold' : 'wild',
    perilous: r.peril,
  };
}

/** Expand each combat card's `copies` into a per-deck list of card ids. */
function buildDecks(cards: CombatCard[]): Record<string, CardId[]> {
  const decks: Record<string, CardId[]> = {};
  for (const c of cards) {
    const n = Math.max(1, c.copies || 1);
    (decks[c.deck] ||= []);
    for (let i = 0; i < n; i++) decks[c.deck].push(c.id);
  }
  return decks;
}

function validate(cat: Catalog): void {
  const loc = (id: string, ctx: string) => {
    if (!cat.locations[id]) throw new Error(`Unknown location '${id}' (${ctx})`);
  };
  for (const h of Object.values(cat.heroes)) {
    loc(h.startLocation, `hero ${h.id}.startLocation`);
    if (!cat.decks[h.deck]?.length) throw new Error(`Hero ${h.id} deck '${h.deck}' is empty`);
  }
  for (const e of cat.edges) { loc(e.a, 'edge.a'); loc(e.b, 'edge.b'); }
  for (const m of Object.values(cat.monsters)) {
    if (!cat.decks[m.deck]?.length) throw new Error(`Monster ${m.id} deck '${m.deck}' is empty`);
  }
  for (const m of Object.values(cat.minions)) {
    if (!cat.decks[m.combatDeck]?.length) throw new Error(`Minion ${m.id} deck '${m.combatDeck}' is empty`);
  }
  loc(cat.scenario.setup.sauronStartLocation, 'scenario.setup.sauronStartLocation');
}

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const combatCards = combatData.cards as CombatCard[];
  const cat: Catalog = {
    version: (heroesData._meta as { schema: string }).schema,
    heroes: byId(heroesData.heroes as Hero[]),
    locations: byId((locationsData.locations as Array<Omit<Location, 'kind' | 'perilous'>>).map(toLocation)),
    edges: adjacencyData.edges as PathEdge[],
    combatCards: byId(combatCards),
    monsters: byId(monstersData.monsters as Monster[]),
    minions: byId(minionsData.minions as Minion[]),
    events: eventsData.events as EventCard[],
    encounters: byId(encountersData.cards as EncounterCard[]),
    heroMissions: byId(missionsData.heroMissions as Mission[]),
    sauronMissions: byId(missionsData.sauronMissions as Mission[]),
    scenario: scenarioData.scenario as Scenario,
    board: {
      width: (locationsData._meta as { boardWidth?: number }).boardWidth ?? 6112,
      height: (locationsData._meta as { boardHeight?: number }).boardHeight ?? 4203,
      image: (locationsData._meta as { boardImage?: string }).boardImage ?? '',
    },
    decks: buildDecks(combatCards),
    perils: byId(perilData.cards as PerilCard[]),
    shadow: byId(shadowData.cards as ShadowCard[]),
    plots: (plotsData.plots as Plot[]).map((p) => ({
      ...p,
      // derive the legacy per-step track from the v2 `advance` so existing
      // consumers (track.length == marker advance) keep working.
      track: p.track && p.track.length
        ? p.track
        : Array.from({ length: Math.max(1, p.advance ?? 1) }, (_, i) => ({ step: i, effectKey: '' as EffectKey })),
      counterLocation: p.counterLocation ?? p.affects ?? '',
      effectKey: p.effectKey ?? ('' as EffectKey),
      rulesText: p.rulesText ?? p.effect ?? '',
    })),
    monsterBags: byId(
      (monsterBagsData.pools as Array<Omit<MonsterBag, 'id'>>).map((p) => ({ ...p, id: p.regionId })),
    ),
    quests: byId(questsData.quests as Quest[]),
    corruption: byId(corruptionData.cards as CorruptionCard[]),
  };
  validate(cat);
  cached = cat;
  return cat;
}
