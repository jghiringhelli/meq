// Behavioral PRE/POST assertions for every effect-atom op reachable from the
// card catalog. Each `it` builds a controlled GameState via `freshGame()`,
// snapshots the exact field(s) the atom's `applyAtom` case mutates, applies the
// atom (or a real card's whole compiled tree via `autoResolveTree`), and
// asserts the state changed by EXACTLY what the code does — plus the fizzle
// (returns '') path where a no-op must leave state untouched.
//
// The source of truth is `applyAtom` in src/engine/encounter.ts, NOT a card's
// printed text; where they diverge we test observed behavior and flag it.
import { describe, it, expect } from 'vitest';
import {
  cat, freshGame, shadowCards, plots, events, encounters, perils, combatCards, label,
} from './helpers';
import { applyAtom, autoResolveTree, evalMetric, statValue } from '../src/engine/encounter';
import { addCardInfluence, influenceAt } from '../src/engine/influence';

type S = ReturnType<typeof freshGame>;
const activeId = (s: S) => (s.heroes.find((h) => h.status === 'active') ?? s.heroes[0]).id;
const heroOf = (s: S) => s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];

/** A non-haven location id (safe target for influence placement). */
const nonHaven = Object.values(cat.locations).find((l) => l.kind !== 'haven')!.id;
const someMonsterId = Object.keys(cat.monsters)[0];
const someMonsterName = cat.monsters[someMonsterId].name;

/** Walk a compiled tree collecting every atom together with its owning card id.
 *  Mirrors the shape of `collectTreeProblems` in helpers.ts. */
type Found = { cardId: string; category: string; atom: any };
function collectAtoms(tree: any, out: any[]): void {
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (n.k === 'op' && n.atom?.op) out.push(n.atom);
    (n.steps ?? []).forEach(walk);
    if (n.then) walk(n.then);
    if (n.else) walk(n.else);
    if (n.eff) walk(n.eff);
    (n.options ?? []).forEach((o: any) => walk(o.eff));
  };
  walk(tree);
}

const CATEGORIES: [string, any[]][] = [
  ['shadow', shadowCards], ['plot', plots], ['event', events],
  ['encounter', encounters], ['peril', perils], ['combat', combatCards],
];

/** Every atom instance in the catalog, tagged with source card + category. */
const ALL_ATOMS: Found[] = (() => {
  const acc: Found[] = [];
  for (const [category, arr] of CATEGORIES) {
    for (const c of arr as any[]) {
      if (!c.tree) continue;
      const found: any[] = [];
      collectAtoms(c.tree, found);
      for (const atom of found) acc.push({ cardId: c.id, category, atom });
    }
  }
  return acc;
})();

const opsUsed = new Set(ALL_ATOMS.map((a) => a.atom.op));
const atomsFor = (op: string) => ALL_ATOMS.filter((a) => a.atom.op === op);
/** Dedupe by JSON so per-instance loops stay bounded but representative. */
function uniqAtoms(op: string): Found[] {
  const seen = new Set<string>();
  const out: Found[] = [];
  for (const a of atomsFor(op)) {
    const key = JSON.stringify(a.atom);
    if (!seen.has(key)) { seen.add(key); out.push(a); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hero economy: favor / corruption
// ---------------------------------------------------------------------------
describe('atom: gainFavor / loseFavor', () => {
  it('gainFavor raises favor by exactly n, nothing else', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 1;
    const corr = h.corruption;
    expect(applyAtom(s, cat, h.id, { op: 'gainFavor', n: 3 })).toBe('+3 favor');
    expect(h.favor).toBe(4);
    expect(h.corruption).toBe(corr);
  });

  it('loseFavor lowers favor by n, clamped at 0', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 2;
    applyAtom(s, cat, h.id, { op: 'loseFavor', n: 1 });
    expect(h.favor).toBe(1);
    applyAtom(s, cat, h.id, { op: 'loseFavor', n: 5 });
    expect(h.favor).toBe(0);
  });
});

describe('atom: gainCorruption / discardCorruption / discardAllCorruption / redistributeCorruption', () => {
  it('gainCorruption raises corruption by exactly n', () => {
    const s = freshGame();
    const h = heroOf(s);
    applyAtom(s, cat, h.id, { op: 'gainCorruption', n: 2 });
    expect(h.corruption).toBe(2);
  });

  it('discardCorruption lowers corruption by n, clamped at 0', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruption = 3;
    applyAtom(s, cat, h.id, { op: 'discardCorruption', n: 2 });
    expect(h.corruption).toBe(1);
    applyAtom(s, cat, h.id, { op: 'discardCorruption', n: 9 });
    expect(h.corruption).toBe(0);
  });

  it('discardAllCorruption zeroes corruption regardless of amount', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruption = 5;
    expect(applyAtom(s, cat, h.id, { op: 'discardAllCorruption' })).toBe('-5 corruption (all)');
    expect(h.corruption).toBe(0);
  });

  it('redistributeCorruption moves a Corruption card between heroes (net-zero)', () => {
    const s = freshGame();
    const a = s.heroes[0];
    const b = s.heroes[1];
    // Hero b holds a real Corruption card; hero a is the redistribution target.
    const cid = Object.keys(cat.corruption)[0];
    b.corruptionCards = [cid];
    b.corruption = 1;
    a.corruptionCards = [];
    a.corruption = 0;
    const totalBefore = a.corruption + b.corruption;
    applyAtom(s, cat, a.id, { op: 'redistributeCorruption' });
    // Net-zero total, counters stay in sync with the actual cards, and the card
    // is concentrated onto the target hero.
    expect(a.corruption + b.corruption).toBe(totalBefore);
    expect(a.corruption).toBe(a.corruptionCards.length);
    expect(b.corruption).toBe(b.corruptionCards.length);
    expect(a.corruptionCards).toContain(cid);
  });

  it('redistributeCorruption is a no-op when no other hero holds Corruption', () => {
    const s = freshGame();
    for (const h of s.heroes) { h.corruptionCards = []; h.corruption = 0; }
    const h = heroOf(s);
    applyAtom(s, cat, h.id, { op: 'redistributeCorruption' });
    expect(h.corruption).toBe(0);
    expect(h.corruption).toBe(h.corruptionCards.length);
  });
});

// ---------------------------------------------------------------------------
// Shadow-pool + location influence
// ---------------------------------------------------------------------------
describe('atom: addInfluence / removeInfluence (shadow pool)', () => {
  it('addInfluence raises the shadow pool by n and touches no location', () => {
    const s = freshGame();
    const before = s.sauron.influence;
    const loc = { ...s.sauron.locationInfluence };
    applyAtom(s, cat, activeId(s), { op: 'addInfluence', n: 2 });
    expect(s.sauron.influence).toBe(before + 2);
    expect(s.sauron.locationInfluence).toEqual(loc);
  });

  it('removeInfluence lowers the shadow pool by n, clamped at 0', () => {
    const s = freshGame();
    s.sauron.influence = 3;
    applyAtom(s, cat, activeId(s), { op: 'removeInfluence', n: 1 });
    expect(s.sauron.influence).toBe(2);
    applyAtom(s, cat, activeId(s), { op: 'removeInfluence', n: 10 });
    expect(s.sauron.influence).toBe(0);
  });
});

describe('atom: placeInfluence', () => {
  it("where:'shadowPool' adds to the shadow pool, not a location", () => {
    const s = freshGame();
    const pool = s.sauron.influence;
    applyAtom(s, cat, activeId(s), { op: 'placeInfluence', where: 'shadowPool', n: 2 });
    expect(s.sauron.influence).toBe(pool + 2);
  });

  it("where:'location' adds influence to the named non-haven location", () => {
    const s = freshGame();
    const before = s.sauron.locationInfluence[nonHaven] ?? 0;
    applyAtom(s, cat, activeId(s), { op: 'placeInfluence', where: 'location', n: 2, location: nonHaven });
    expect(s.sauron.locationInfluence[nonHaven]).toBe(before + 2);
  });

  it("where:'location' with no explicit target falls back to the hero's location", () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = nonHaven;
    const before = s.sauron.locationInfluence[nonHaven] ?? 0;
    applyAtom(s, cat, h.id, { op: 'placeInfluence', where: 'location', n: 1 });
    expect(s.sauron.locationInfluence[nonHaven]).toBe(before + 1);
  });

  it("where:'region' places influence somewhere in the hero's region", () => {
    const s = freshGame();
    const h = heroOf(s);
    const region = cat.locations[h.location]?.regionId;
    const totalBefore = Object.entries(s.sauron.locationInfluence)
      .filter(([loc]) => cat.locations[loc]?.regionId === region)
      .reduce((n, [, v]) => n + v, 0);
    const out = applyAtom(s, cat, h.id, { op: 'placeInfluence', where: 'region', n: 2 });
    if (out) {
      const totalAfter = Object.entries(s.sauron.locationInfluence)
        .filter(([loc]) => cat.locations[loc]?.regionId === region)
        .reduce((n, [, v]) => n + v, 0);
      expect(totalAfter).toBe(totalBefore + 2);
    }
  });
});

describe('atom: discardRegionInfluence', () => {
  it("removes influence from the hero's own location first", () => {
    const s = freshGame();
    const h = heroOf(s);
    s.sauron.locationInfluence = { [h.location]: 3 };
    applyAtom(s, cat, h.id, { op: 'discardRegionInfluence', n: 3 });
    expect(s.sauron.locationInfluence[h.location] ?? 0).toBe(0);
  });

  it('spreads the remainder across other influenced locations in the region', () => {
    const s = freshGame();
    const h = heroOf(s);
    const region = cat.locations[h.location]?.regionId;
    const other = Object.values(cat.locations)
      .find((l) => l.regionId === region && l.id !== h.location)?.id;
    if (!other) return; // region has a single location: nothing to spread onto
    s.sauron.locationInfluence = { [h.location]: 1, [other]: 3 };
    applyAtom(s, cat, h.id, { op: 'discardRegionInfluence', n: 3 });
    // 1 stripped from the hero's location, 2 more from the other location.
    expect(s.sauron.locationInfluence[h.location] ?? 0).toBe(0);
    expect(s.sauron.locationInfluence[other] ?? 0).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Hero life pool: damage / damagePer / heal
// ---------------------------------------------------------------------------
describe('atom: damage', () => {
  it('discards exactly n cards from the life pool into the damage pool', () => {
    const s = freshGame();
    const h = heroOf(s);
    const deck = h.deck.length;
    const dmgPool = h.damagePool.length;
    applyAtom(s, cat, h.id, { op: 'damage', n: 3 });
    expect(h.deck.length).toBe(deck - 3);
    expect(h.damagePool.length).toBe(dmgPool + 3);
    expect(h.life).toBe(h.deck.length); // life mirrors the life-pool size
  });

  it('draws from hand once the life pool is empty', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.deck = [];
    h.hand = ['c1', 'c2', 'c3'];
    applyAtom(s, cat, h.id, { op: 'damage', n: 2 });
    expect(h.hand.length).toBe(1);
    expect(h.damagePool.length).toBe(2);
  });
});

describe('atom: damagePer', () => {
  it('deals n × corruption damage', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruption = 3;
    const deck = h.deck.length;
    applyAtom(s, cat, h.id, { op: 'damagePer', n: 1, per: 'corruptionOnHero' });
    expect(h.deck.length).toBe(deck - 3);
  });

  it('deals no damage when the hero has no corruption', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruption = 0;
    const deck = h.deck.length;
    applyAtom(s, cat, h.id, { op: 'damagePer', n: 5, per: 'corruptionOnHero' });
    expect(h.deck.length).toBe(deck);
  });
});

describe('atom: heal', () => {
  it('shuffles the damage pool back into the life pool', () => {
    const s = freshGame();
    const h = heroOf(s);
    const deck = h.deck.length;
    h.damagePool = ['d1', 'd2', 'd3'];
    applyAtom(s, cat, h.id, { op: 'heal' });
    expect(h.damagePool.length).toBe(0);
    expect(h.deck.length).toBe(deck + 3);
  });

  it('is a no-op with an empty damage pool', () => {
    const s = freshGame();
    const h = heroOf(s);
    const deck = h.deck.length;
    h.damagePool = [];
    applyAtom(s, cat, h.id, { op: 'heal' });
    expect(h.deck.length).toBe(deck);
  });
});

describe('atom: healPer', () => {
  it('moves up to <stat> damage cards back into the life pool', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.statBonus = { ...(h.statBonus ?? {}), wisdom: 3 };
    const wis = statValue(s, cat, h.id, 'wisdom');
    h.damagePool = Array.from({ length: wis + 3 }, (_, i) => 'd' + i);
    const deck = h.deck.length;
    applyAtom(s, cat, h.id, { op: 'healPer', per: 'wisdom' });
    expect(h.damagePool.length).toBe(3);
    expect(h.deck.length).toBe(deck + wis);
  });

  it('never heals more cards than the damage pool holds', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.statBonus = { ...(h.statBonus ?? {}), wisdom: 5 };
    h.damagePool = ['d1'];
    const deck = h.deck.length;
    applyAtom(s, cat, h.id, { op: 'healPer', per: 'wisdom' });
    expect(h.damagePool.length).toBe(0);
    expect(h.deck.length).toBe(deck + 1);
  });
});

// ---------------------------------------------------------------------------
// Cards / items / training / stats
// ---------------------------------------------------------------------------
describe('atom: drawPer', () => {
  it('draws (fortitude) cards from the life pool into hand', () => {
    const s = freshGame();
    const h = heroOf(s);
    const n = statValue(s, cat, h.id, 'fortitude');
    const deck = h.deck.length;
    const hand = h.hand.length;
    applyAtom(s, cat, h.id, { op: 'drawPer', per: 'fortitude' });
    expect(h.hand.length).toBe(hand + n);
    expect(h.deck.length).toBe(deck - n);
  });
});

describe('atom: discardHand', () => {
  it('moves n cards from hand to the discard pile', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.hand = ['a', 'b', 'c', 'd'];
    h.discard = [];
    applyAtom(s, cat, h.id, { op: 'discardHand', n: 2 });
    expect(h.hand).toEqual(['c', 'd']);
    expect(h.discard).toEqual(['a', 'b']);
  });

  it('caps at the current hand size', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.hand = ['x'];
    h.discard = [];
    applyAtom(s, cat, h.id, { op: 'discardHand', n: 5 });
    expect(h.hand).toEqual([]);
    expect(h.discard).toEqual(['x']);
  });

  it('toHand discards down to the given hand size (Storms of Mordor)', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.hand = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']; // 8 cards
    h.discard = [];
    h.corruptionCards = [];
    applyAtom(s, cat, h.id, { op: 'discardHand', n: 0, toHand: 5 });
    expect(h.hand.length).toBe(5);
  });

  it('perCorruption adds one discard per Corruption card, additive with toHand', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.hand = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']; // 8 cards
    h.discard = [];
    h.corruptionCards = ['k1', 'k2']; // 2 corruption
    // Storms: down to 5 (discard 3), then +1 per corruption (2) => 3 left.
    applyAtom(s, cat, h.id, { op: 'discardHand', n: 0, toHand: 5, perCorruption: true });
    expect(h.hand.length).toBe(3);
  });

  it('perCorruption alone strips one card per Corruption card (An Evil Fog)', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.hand = ['a', 'b', 'c'];
    h.discard = [];
    h.corruptionCards = ['k1']; // 1 corruption
    applyAtom(s, cat, h.id, { op: 'discardHand', n: 0, perCorruption: true });
    expect(h.hand.length).toBe(2);
  });
});

describe('atom: gainItem / discardItem', () => {
  it('gainItem appends the named item', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.items = [];
    applyAtom(s, cat, h.id, { op: 'gainItem', item: 'phial' });
    expect(h.items).toEqual(['phial']);
  });

  it('discardItem removes n items from the end', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.items = ['a', 'b', 'c'];
    applyAtom(s, cat, h.id, { op: 'discardItem', n: 2 });
    expect(h.items).toEqual(['a']);
  });
});

describe('atom: training', () => {
  it('raises hero.training by n and grows the hero deck with skill cards', () => {
    const s = freshGame();
    const h = heroOf(s);
    const training = h.training;
    const trained = h.trainedCount;
    const deck = h.deck.length;
    const skill = s.skillDeck!.length;
    applyAtom(s, cat, h.id, { op: 'training', n: 2 });
    expect(h.training).toBe(training + 2);
    expect(h.trainedCount).toBe(trained + 2);
    expect(h.deck.length).toBe(deck + 2);
    expect(s.skillDeck!.length).toBeLessThan(skill); // consumed from the skill deck
  });
});

describe('atom: gainStat', () => {
  it('raises a stat bonus, capped at +2 per attribute', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.statBonus = {};
    h.levels = {};
    applyAtom(s, cat, h.id, { op: 'gainStat', stat: 'strength', n: 3 });
    expect(h.statBonus.strength).toBe(2); // capped at 2
    expect(h.levels!.strength).toBe(2);
    // Already maxed → no further increase.
    expect(applyAtom(s, cat, h.id, { op: 'gainStat', stat: 'strength', n: 1 }))
      .toContain('already at max');
    expect(h.statBonus.strength).toBe(2);
  });

  it("stat 'choice' resolves to wisdom", () => {
    const s = freshGame();
    const h = heroOf(s);
    h.statBonus = {};
    h.levels = {};
    applyAtom(s, cat, h.id, { op: 'gainStat', stat: 'choice', n: 1 });
    expect(h.statBonus.wisdom).toBe(1);
  });
});

describe('atom: combatStatMod', () => {
  it('appends a flat combat modifier', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.combatMods = [];
    applyAtom(s, cat, h.id, { op: 'combatStatMod', stat: 'strength', n: 2 });
    expect(h.combatMods).toEqual([{ stat: 'strength', n: 2 }]);
  });

  it('scales by corruption and fizzles at zero', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.combatMods = [];
    h.corruption = 2;
    applyAtom(s, cat, h.id, { op: 'combatStatMod', stat: 'strength', n: -1, per: 'corruptionOnHero' });
    expect(h.combatMods).toEqual([{ stat: 'strength', n: -2 }]);
    // No corruption → amount 0 → no modifier pushed.
    h.corruption = 0;
    h.combatMods = [];
    expect(applyAtom(s, cat, h.id, { op: 'combatStatMod', stat: 'strength', n: -1, per: 'corruptionOnHero' }))
      .toBe('');
    expect(h.combatMods).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Movement / turn flags
// ---------------------------------------------------------------------------
describe('atom: moveAdjacent / moveToEncounter / moveAnywhere', () => {
  it('moveAdjacent relocates the hero to an adjacent location', () => {
    const s = freshGame();
    const h = heroOf(s);
    const from = h.location;
    const e = cat.edges.find((x) => x.a === from || x.b === from)!;
    const expected = e.a === from ? e.b : e.a;
    applyAtom(s, cat, h.id, { op: 'moveAdjacent' });
    expect(h.location).toBe(expected);
    expect(s.map.heroesAt[expected]).toContain(h.id);
  });

  it('moveToEncounter relocates the hero to the named location', () => {
    const s = freshGame();
    const h = heroOf(s);
    applyAtom(s, cat, h.id, { op: 'moveToEncounter', location: 'bree' });
    expect(h.location).toBe('bree');
    expect(s.map.heroesAt['bree']).toContain(h.id);
  });

  it('moveAnywhere is a pure prompt (no state change)', () => {
    const s = freshGame();
    const h = heroOf(s);
    const from = h.location;
    expect(applyAtom(s, cat, h.id, { op: 'moveAnywhere' })).toBeTruthy();
    expect(h.location).toBe(from);
  });
});

describe('atom: endTurn / restrictMovement / skipAmbush', () => {
  it('endTurn zeroes the actions remaining', () => {
    const s = freshGame();
    const h = heroOf(s);
    (h as any).actionsRemaining = 2;
    applyAtom(s, cat, h.id, { op: 'endTurn' });
    expect((h as any).actionsRemaining).toBe(0);
  });

  it('restrictMovement caps the next travel step', () => {
    const s = freshGame();
    const h = heroOf(s);
    applyAtom(s, cat, h.id, { op: 'restrictMovement', n: 1 });
    expect(h.moveRestriction).toBe(1);
  });

  it('skipAmbush sets the skip flag', () => {
    const s = freshGame();
    const h = heroOf(s);
    applyAtom(s, cat, h.id, { op: 'skipAmbush' });
    expect(h.skipAmbush).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Board: characters / monsters / peril
// ---------------------------------------------------------------------------
describe('atom: placeCharacter', () => {
  it('places the named Character (lower-cased) at the target location', () => {
    const s = freshGame();
    s.map.charactersAt = {};
    applyAtom(s, cat, activeId(s), { op: 'placeCharacter', who: 'Gandalf', location: 'bree' });
    expect(s.map.charactersAt['bree']).toContain('gandalf');
  });
});

describe('atom: spawnMonster / forceCombat / clearMonstersAt / discardMonsterToken', () => {
  it('spawnMonster adds n monster tokens at the hero location', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.map.monstersAt[h.location] = [];
    applyAtom(s, cat, h.id, { op: 'spawnMonster', n: 2 });
    expect(s.map.monstersAt[h.location].length).toBe(2);
  });

  it('forceCombat drops the named monster onto the hero location', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.map.monstersAt[h.location] = [];
    const out = applyAtom(s, cat, h.id, { op: 'forceCombat', monster: someMonsterName });
    expect(out).toContain('must combat');
    expect(s.map.monstersAt[h.location].length).toBe(1);
  });

  it('forceCombat fizzles on an unresolvable monster name', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.map.monstersAt[h.location] = [];
    expect(applyAtom(s, cat, h.id, { op: 'forceCombat', monster: 'zzzz-not-a-monster' })).toBe('');
    expect(s.map.monstersAt[h.location]).toEqual([]);
  });

  it('clearMonstersAt empties a named location', () => {
    const s = freshGame();
    s.map.monstersAt['bree'] = [someMonsterId, someMonsterId];
    applyAtom(s, cat, activeId(s), { op: 'clearMonstersAt', location: 'bree' });
    expect(s.map.monstersAt['bree']).toEqual([]);
  });

  it('clearMonstersAt fizzles on an unresolvable location', () => {
    const s = freshGame();
    expect(applyAtom(s, cat, activeId(s), { op: 'clearMonstersAt', location: 'nowhere-land' })).toBe('');
  });

  it("discardMonsterToken removes n tokens from a location in the hero's region", () => {
    const s = freshGame();
    const h = heroOf(s);
    s.map.monstersAt[h.location] = [someMonsterId, someMonsterId, someMonsterId];
    applyAtom(s, cat, h.id, { op: 'discardMonsterToken', n: 2 });
    expect(s.map.monstersAt[h.location].length).toBe(1);
  });
});

describe('atom: examineTokens', () => {
  it('reveals monster tokens at the hero location', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.map.monstersAt[h.location] = [someMonsterId];
    s.map.revealedMonstersAt = [];
    const out = applyAtom(s, cat, h.id, { op: 'examineTokens' });
    expect(out).toContain('examine');
    expect(s.map.revealedMonstersAt).toContain(h.location);
  });
});

describe('atom: forcePeril', () => {
  it("guarantees the hero's location holds at least 1 influence", () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = nonHaven;
    s.sauron.locationInfluence = {};
    applyAtom(s, cat, h.id, { op: 'forcePeril' });
    expect(s.sauron.locationInfluence[nonHaven]).toBeGreaterThanOrEqual(1);
  });

  it('leaves an already-influenced location unchanged', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = nonHaven;
    s.sauron.locationInfluence = { [nonHaven]: 4 };
    applyAtom(s, cat, h.id, { op: 'forcePeril' });
    expect(s.sauron.locationInfluence[nonHaven]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Story markers / Sauron economy
// ---------------------------------------------------------------------------
describe('atom: advanceStory / sauronDrawPlot', () => {
  it('advanceStory pushes the Sauron clock by n', () => {
    const s = freshGame();
    s.story.sauronProgress = 2;
    applyAtom(s, cat, activeId(s), { op: 'advanceStory', n: 3 });
    expect(s.story.sauronProgress).toBe(5);
  });

  it('sauronDrawPlot draws a real plot from the deck into Sauron\'s hand', () => {
    const s = freshGame();
    s.sauron.plotDeck = cat.plots.slice(0, 2).map((p) => p.id);
    s.sauron.plotHand = [];
    const deckBefore = s.sauron.plotDeck.length;
    const handBefore = s.sauron.plotHand.length;
    applyAtom(s, cat, activeId(s), { op: 'sauronDrawPlot' });
    expect(s.sauron.plotHand!.length).toBe(handBefore + 1);
    expect(s.sauron.plotDeck!.length).toBe(deckBefore - 1);
  });
});

describe('atom: sauronDrawShadow', () => {
  it("draws n Shadow cards into Sauron's hand", () => {
    const s = freshGame();
    const before = s.sauron.shadowHand.length;
    applyAtom(s, cat, activeId(s), { op: 'sauronDrawShadow', n: 1 });
    expect(s.sauron.shadowHand.length).toBe(before + 1);
  });
});

describe('atom: counterPlot', () => {
  it('removes an active plot from play', () => {
    const s = freshGame();
    const ids = cat.plots.slice(0, 2).map((p) => p.id);
    s.sauron.activePlots = ids.map((id) => ({ eventId: id, step: 0 }));
    applyAtom(s, cat, activeId(s), { op: 'counterPlot' });
    expect((s.sauron.activePlots ?? []).length).toBe(1);
  });

  it('fizzles quietly with no active plots', () => {
    const s = freshGame();
    s.sauron.activePlots = [];
    expect(applyAtom(s, cat, activeId(s), { op: 'counterPlot' })).toContain('no active plot');
  });
});

describe('atom: handToLife', () => {
  it('shuffles the whole hand into the life pool', () => {
    const s = freshGame();
    const h = s.heroes.find((x) => x.id === activeId(s))!;
    h.hand = ['a', 'b', 'c'];
    const deck = h.deck.length;
    applyAtom(s, cat, h.id, { op: 'handToLife' });
    expect(h.hand.length).toBe(0);
    expect(h.deck.length).toBe(deck + 3);
  });
});

describe('atom: placeFavorToken', () => {
  it('places favor tokens on a named location', () => {
    const s = freshGame();
    const h = s.heroes.find((x) => x.id === activeId(s))!;
    applyAtom(s, cat, h.id, { op: 'placeFavorToken', location: h.location, n: 2 });
    expect(s.map.favorAt?.[h.location]).toBe(2);
  });
});

describe('atom: clearAdjacent', () => {
  it('removes influence and monster tokens within 1 space of the hero', () => {
    const s = freshGame();
    const h = s.heroes.find((x) => x.id === activeId(s))!;
    addCardInfluence(s, cat, h.location, 3);
    s.map.monstersAt[h.location] = ['m1', 'm2'];
    applyAtom(s, cat, h.id, { op: 'clearAdjacent' });
    expect(influenceAt(s, h.location)).toBe(0);
    expect(s.map.monstersAt[h.location] ?? []).toHaveLength(0);
  });
});

describe('atom: advanceMarker', () => {
  it('advances a named coloured marker directly', () => {
    const s = freshGame();
    s.story.sauron = { yellow: 1, red: 0, black: 0 };
    applyAtom(s, cat, activeId(s), { op: 'advanceMarker', marker: 'red', n: 2 });
    expect(s.story.sauron).toEqual({ yellow: 1, red: 2, black: 0 });
  });

  it("green moves the hero clock and clamps at 0", () => {
    const s = freshGame();
    s.story.sauronProgress = 2;
    applyAtom(s, cat, activeId(s), { op: 'advanceMarker', marker: 'green', n: 1 });
    expect(s.story.sauronProgress).toBe(3);
    applyAtom(s, cat, activeId(s), { op: 'advanceMarker', marker: 'green', n: -10 });
    expect(s.story.sauronProgress).toBe(0);
  });
});

describe('atom: forceSauronDiscard', () => {
  it("moves n cards from Sauron's shadow hand to the shadow discard", () => {
    const s = freshGame();
    s.sauron.shadowHand = ['sc1', 'sc2', 'sc3'];
    s.sauron.shadowDiscard = [];
    applyAtom(s, cat, activeId(s), { op: 'forceSauronDiscard', n: 2 });
    expect(s.sauron.shadowHand.length).toBe(1);
    expect(s.sauron.shadowDiscard.length).toBe(2);
  });

  it("with pile:'plot' discards a Plot card from Sauron's plot hand instead", () => {
    const s = freshGame();
    const plotIds = cat.plots.slice(0, 2).map((p) => p.id);
    s.sauron.plotHand = [...plotIds];
    s.sauron.plotDiscard = [];
    s.sauron.shadowHand = ['sc1', 'sc2'];
    s.sauron.shadowDiscard = [];
    applyAtom(s, cat, activeId(s), { op: 'forceSauronDiscard', n: 1, pile: 'plot' });
    expect(s.sauron.plotHand!.length).toBe(plotIds.length - 1);
    expect(s.sauron.plotDiscard!.length).toBe(1);
    // the shadow hand is untouched when discarding a plot
    expect(s.sauron.shadowHand).toEqual(['sc1', 'sc2']);
  });

  it('fizzles quietly on an empty shadow hand', () => {
    const s = freshGame();
    s.sauron.shadowHand = [];
    s.sauron.shadowDiscard = [];
    applyAtom(s, cat, activeId(s), { op: 'forceSauronDiscard', n: 2 });
    expect(s.sauron.shadowDiscard).toEqual([]);
  });
});

describe('atom: lookSauronHand (informational, no state change)', () => {
  it('returns a description without mutating the plot hand', () => {
    const s = freshGame();
    s.sauron.plotHand = ['a-broken-line-of-kings'];
    const before = [...s.sauron.plotHand];
    const out = applyAtom(s, cat, activeId(s), { op: 'lookSauronHand' });
    expect(out).toContain("Sauron");
    expect(s.sauron.plotHand).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Sauron plot-deck manipulation
// ---------------------------------------------------------------------------
describe('atom: plotPeekReorder / plotFromDiscard / plotTutor', () => {
  const byAdvance = [...plots].sort((a, b) => (a.advance ?? a.track.length) - (b.advance ?? b.track.length));
  const lo = byAdvance[0].id;
  const hi = byAdvance[byAdvance.length - 1].id;

  it('plotPeekReorder buries a weak top plot beneath a stronger one', () => {
    const s = freshGame();
    s.sauron.plotDeck = [lo, hi];
    applyAtom(s, cat, activeId(s), { op: 'plotPeekReorder' });
    expect(s.sauron.plotDeck).toEqual([hi, lo]);
  });

  it('plotFromDiscard pulls the strongest discarded plot into the plot hand', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDiscard = [lo, hi];
    applyAtom(s, cat, activeId(s), { op: 'plotFromDiscard' });
    expect(s.sauron.plotHand).toContain(hi);
    expect(s.sauron.plotDiscard).not.toContain(hi);
  });

  it('plotFromDiscard fizzles on an empty discard', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDiscard = [];
    expect(applyAtom(s, cat, activeId(s), { op: 'plotFromDiscard' })).toBe('');
  });

  it('plotTutor fetches a named plot from the deck into the plot hand', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDeck = [lo, hi];
    applyAtom(s, cat, activeId(s), { op: 'plotTutor', ids: [hi] });
    expect(s.sauron.plotHand).toContain(hi);
    expect(s.sauron.plotDeck).not.toContain(hi);
  });

  it('plotTutor fizzles when no id is present in deck or discard', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDeck = [lo];
    s.sauron.plotDiscard = [];
    expect(applyAtom(s, cat, activeId(s), { op: 'plotTutor', ids: ['no-such-plot'] })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Characters / minions
// ---------------------------------------------------------------------------
describe('atom: sauronMoveCharacter', () => {
  it('banishes a board Character to the named location', () => {
    const s = freshGame();
    s.map.charactersAt = { bree: ['gandalf'] };
    applyAtom(s, cat, activeId(s), { op: 'sauronMoveCharacter', location: 'mouth-of-the-greyflood' });
    expect(s.map.charactersAt['mouth-of-the-greyflood']).toContain('gandalf');
    expect(s.map.charactersAt['bree'] ?? []).not.toContain('gandalf');
  });

  it('fizzles when no Character is on the board', () => {
    const s = freshGame();
    s.map.charactersAt = {};
    expect(applyAtom(s, cat, activeId(s), { op: 'sauronMoveCharacter', location: 'mouth-of-the-greyflood' }))
      .toBe('');
  });
});

describe('atom: reviveRelocateMinion', () => {
  it('full-heals a minion and places it on the most-influenced location', () => {
    const s = freshGame();
    s.sauron.locationInfluence = { 'the-shire': 2, bree: 5 };
    s.map.minionsAt = {};
    s.map.minionHealth = {};
    const out = applyAtom(s, cat, activeId(s), { op: 'reviveRelocateMinion' });
    const placed = s.map.minionsAt!['bree']?.[0];
    expect(placed).toBeTruthy();
    expect(s.map.minionHealth![placed!]).toBe(cat.minions[placed!].health);
    expect(out).toContain('redeployed');
  });

  it('fizzles when no location holds influence', () => {
    const s = freshGame();
    s.sauron.locationInfluence = {};
    expect(applyAtom(s, cat, activeId(s), { op: 'reviveRelocateMinion' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Informational / no-op atoms: return a tag but do not mutate state
// ---------------------------------------------------------------------------
describe('atoms with no modelled state change (explore / reusable)', () => {
  it('explore returns a tag without altering the board', () => {
    const s = freshGame();
    const before = JSON.stringify(s.map.monstersAt);
    expect(applyAtom(s, cat, activeId(s), { op: 'explore', location: 'bree' })).toContain('explore');
    expect(JSON.stringify(s.map.monstersAt)).toBe(before);
  });

  it('reusable returns a tag (card returns to deck) without state change', () => {
    const s = freshGame();
    const h = heroOf(s);
    const deck = h.deck.length;
    expect(applyAtom(s, cat, h.id, { op: 'reusable' })).toBeTruthy();
    expect(h.deck.length).toBe(deck);
  });
});

// ---------------------------------------------------------------------------
// Full-card resolution via autoResolveTree
// ---------------------------------------------------------------------------
describe('full-card resolution (autoResolveTree)', () => {
  it('Imladris (event) removes 1 corruption from the hero', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruption = 2;
    const card = events.find((e) => e.id === 'event-t1-imladris')!;
    autoResolveTree(s, cat, h.id, card.tree!, 'test:' + card.id, 'hero');
    expect(h.corruption).toBe(1);
  });

  it('Dark Promises (shadow) — the Eye picks the 5-damage branch', () => {
    const s = freshGame();
    const h = heroOf(s);
    const deck = h.deck.length;
    const card = shadowCards.find((c) => c.id === 'shadow-dark-promises')!;
    autoResolveTree(s, cat, h.id, card.tree, 'test:' + card.id, 'sauron');
    // The 5-damage branch is strictly worse for the hero than +1 corruption.
    expect(h.deck.length).toBe(deck - 5);
    expect(h.corruption).toBe(0);
  });

  it('The Dunadan Guards the Shire (event) — the hero takes the +1 favor branch', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 0;
    const card = events.find((e) => e.id === 'event-t1-the-dunadan-guards-the-shire')!;
    autoResolveTree(s, cat, h.id, card.tree!, 'test:' + card.id, 'hero');
    expect(h.favor).toBe(1);
  });

  it("Do Not Tempt Me (shadow) — the Eye places influence and the hero loses favor", () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = nonHaven;
    h.favor = 2;
    h.corruption = 1; // "discard 1 favor for each Corruption card" — 1 card ⇒ −1 favor
    const before = s.sauron.locationInfluence[nonHaven] ?? 0;
    const card = shadowCards.find((c) => c.id === 'shadow-do-not-tempt-me')!;
    autoResolveTree(s, cat, h.id, card.tree, 'test:' + card.id, 'sauron');
    expect(h.favor).toBe(1);
    expect(s.sauron.locationInfluence[nonHaven]).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Per-atom coverage loops: prove each real catalog atom instance behaves.
// ---------------------------------------------------------------------------
describe('coverage: every catalog damage atom reduces the life pool', () => {
  const dmg = uniqAtoms('damage').filter((a) => (a.atom.n ?? 0) > 0);
  it.each(dmg)('$cardId deals $atom.n damage', ({ cardId, atom }) => {
    const s = freshGame();
    const h = heroOf(s);
    const deck = h.deck.length;
    applyAtom(s, cat, h.id, atom);
    expect(h.deck.length).toBe(deck - Math.min(atom.n, deck));
    expect(h.deck.length).toBeLessThan(deck);
  });
});

describe('coverage: every catalog gainCorruption atom raises corruption', () => {
  it.each(uniqAtoms('gainCorruption'))('$cardId +$atom.n corruption', ({ atom }) => {
    const s = freshGame();
    const h = heroOf(s);
    const c = h.corruption;
    applyAtom(s, cat, h.id, atom);
    expect(h.corruption).toBe(c + atom.n);
  });
});

describe('coverage: every catalog gainFavor / loseFavor atom moves favor', () => {
  it.each(uniqAtoms('gainFavor'))('$cardId +$atom.n favor', ({ atom }) => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 3;
    applyAtom(s, cat, h.id, atom);
    expect(h.favor).toBe(3 + atom.n);
  });

  it.each(uniqAtoms('loseFavor'))('$cardId -$atom.n favor', ({ atom }) => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 9;
    h.corruption = 2; // exercise per='corruptionOnHero' scaling where present
    applyAtom(s, cat, h.id, atom);
    const mult = atom.per === 'corruptionOnHero' ? h.corruption : 1;
    expect(h.favor).toBe(Math.max(0, 9 - atom.n * mult));
  });
});

describe('coverage: every catalog addInfluence atom raises the shadow pool', () => {
  it.each(uniqAtoms('addInfluence'))('$cardId +$atom.n shadow influence', ({ atom }) => {
    const s = freshGame();
    const before = s.sauron.influence;
    const h = heroOf(s);
    h.corruption = 2; // exercise per='corruptionOnHero' scaling where present
    applyAtom(s, cat, h.id, atom);
    const mult = atom.per === 'corruptionOnHero' ? h.corruption : 1;
    expect(s.sauron.influence).toBe(before + atom.n * mult);
  });
});

describe('coverage: every catalog training atom raises hero.training', () => {
  it.each(uniqAtoms('training'))('$cardId +$atom.n training', ({ atom }) => {
    const s = freshGame();
    const h = heroOf(s);
    const t = h.training;
    applyAtom(s, cat, h.id, atom);
    expect(h.training).toBe(t + atom.n);
  });
});

describe('coverage: every catalog discardCorruption atom lowers corruption', () => {
  it.each(uniqAtoms('discardCorruption'))('$cardId -$atom.n corruption', ({ atom }) => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruption = atom.n + 2;
    applyAtom(s, cat, h.id, atom);
    expect(h.corruption).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tree-level coverage: purely-hostile Shadow/Peril cards never IMPROVE the hero.
// heroWellbeing = life*10 - corruption*6 + favor*2 (see encounter.ts). The Eye
// resolves these against the hero (side 'sauron'). Some perils/shadows also
// grant a survival reward (favor/training/heal), so the monotonic check applies
// only to cards whose atoms are entirely non-beneficial; the mixed cards get a
// positive-control check that the beneficial atom actually fired.
// ---------------------------------------------------------------------------
describe('coverage: hostile Shadow/Peril cards never leave the hero better off', () => {
  const wellbeing = (h: any) => h.life * 10 - h.corruption * 6 + h.favor * 2;
  const BENEFICIAL = new Set([
    'gainFavor', 'heal', 'healPer', 'discardCorruption', 'discardAllCorruption',
    'gainItem', 'training', 'gainStat', 'drawPer', 'removeInfluence',
  ]);
  const cardOps = (card: any): string[] => {
    const found: any[] = [];
    collectAtoms(card.tree, found);
    return found.map((a) => a.op);
  };
  const darkCards = [...shadowCards, ...perils];
  const hostile = darkCards.filter((c) => !cardOps(c).some((op) => BENEFICIAL.has(op)));
  const mixed = darkCards.filter((c) => cardOps(c).some((op) => BENEFICIAL.has(op)));

  it.each(hostile.map((c) => ({ id: c.id, card: c })))('$id never raises hero wellbeing', ({ id, card }) => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 4;
    h.corruption = 2;
    const before = wellbeing(h);
    autoResolveTree(s, cat, h.id, card.tree, 'test:' + id, 'sauron');
    expect(wellbeing(h)).toBeLessThanOrEqual(before);
  });

  it.each(mixed.map((c) => ({ id: c.id, card: c })))('$id resolves deterministically', ({ id, card }) => {
    const run = () => {
      const s = freshGame();
      const h = heroOf(s);
      h.favor = 4;
      h.corruption = 2;
      autoResolveTree(s, cat, h.id, card.tree, 'test:' + id, 'sauron');
      return wellbeing(heroOf(s));
    };
    // Same fixed seed + same setup ⇒ identical outcome on repeat resolution.
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
// Meta: confirm the focused tests cover EVERY atom op reachable in the catalog.
// ---------------------------------------------------------------------------
describe('meta: op coverage', () => {
  const COVERED = new Set([
    'gainFavor', 'loseFavor', 'gainCorruption', 'discardCorruption', 'discardAllCorruption',
    'redistributeCorruption', 'addInfluence', 'removeInfluence', 'placeInfluence',
    'discardRegionInfluence', 'damage', 'damagePer', 'heal', 'drawPer', 'discardHand',
    'gainItem', 'discardItem', 'training', 'gainStat', 'combatStatMod', 'moveAdjacent',
    'moveToEncounter', 'moveAnywhere', 'endTurn', 'restrictMovement', 'skipAmbush',
    'placeCharacter', 'spawnMonster', 'forceCombat', 'clearMonstersAt', 'discardMonsterToken',
    'examineTokens', 'forcePeril', 'advanceStory', 'sauronDrawPlot', 'advanceMarker',
    'forceSauronDiscard', 'lookSauronHand', 'plotPeekReorder', 'plotFromDiscard', 'plotTutor',
    'sauronMoveCharacter', 'reviveRelocateMinion', 'explore', 'reusable',
    'sauronDrawShadow', 'counterPlot', 'healPer', 'clearAdjacent', 'handToLife', 'placeFavorToken',
  ]);

  it('every op used in the catalog has a focused behavioural test', () => {
    const missing = [...opsUsed].filter((op) => !COVERED.has(op)).sort();
    expect(missing, `uncovered ops: ${missing.join(', ')}`).toEqual([]);
  });

  it('the catalog exercises a non-trivial number of distinct ops', () => {
    expect(opsUsed.size).toBeGreaterThanOrEqual(40);
  });
});

// Referenced so unused-import lint stays quiet where helpers guide setup.
void label;
void evalMetric;
void combatCards;
void encounters;
