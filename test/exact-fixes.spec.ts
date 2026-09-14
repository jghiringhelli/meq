import { describe, it, expect } from 'vitest';
import { cat, freshGame, events, shadowCards, plots } from './helpers';
import { applyAtom, evalMetric } from '../src/engine/encounter';
import { sauronResolveEvents } from '../src/engine/game';

const activeId = (s: ReturnType<typeof freshGame>) =>
  (s.heroes.find((h) => h.status === 'active') ?? s.heroes[0]).id;

describe('exact modeling of previously-abstracted cards', () => {
  it('sauronMoveCharacter banishes a board Character to the named location', () => {
    const s = freshGame();
    s.map.charactersAt = { bree: ['gandalf'] };
    applyAtom(s, cat, activeId(s), { op: 'sauronMoveCharacter', location: 'mouth-of-the-greyflood' });
    expect(s.map.charactersAt['mouth-of-the-greyflood']).toContain('gandalf');
    expect(s.map.charactersAt['bree'] ?? []).not.toContain('gandalf');
  });

  it('sauronMoveCharacter prefers a Character sharing an active hero location', () => {
    const s = freshGame();
    const hero = s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];
    s.map.charactersAt = { bree: ['aragorn'], [hero.location]: ['gandalf'] };
    applyAtom(s, cat, hero.id, { op: 'sauronMoveCharacter', location: 'mouth-of-the-greyflood' });
    expect(s.map.charactersAt['mouth-of-the-greyflood']).toContain('gandalf');
    expect(s.map.charactersAt['bree']).toContain('aragorn');
  });

  it('sauronMoveCharacter is a no-op when no Character is on the board', () => {
    const s = freshGame();
    s.map.charactersAt = {};
    const out = applyAtom(s, cat, activeId(s), { op: 'sauronMoveCharacter', location: 'mouth-of-the-greyflood' });
    expect(out).toBe('');
  });

  it('clearMonstersAt removes every monster token from the named location', () => {
    const s = freshGame();
    s.map.monstersAt['the-trollshaws'] = ['mon-orc', 'mon-snaga'];
    applyAtom(s, cat, activeId(s), { op: 'clearMonstersAt', location: 'the-trollshaws' });
    expect(s.map.monstersAt['the-trollshaws']).toEqual([]);
  });

  it('shireControl metric reflects 3+ influence OR a minion in The Shire', () => {
    const id = (s: ReturnType<typeof freshGame>) => activeId(s);
    let s = freshGame();
    (s.sauron.locationInfluence ||= {})['the-shire'] = 2;
    expect(evalMetric(s, cat, id(s), { count: 'shireControl' })).toBe(2);
    (s.sauron.locationInfluence!)['the-shire'] = 3;
    expect(evalMetric(s, cat, id(s), { count: 'shireControl' })).toBeGreaterThanOrEqual(3);
    // A minion alone (no influence) also clears the threshold.
    s = freshGame();
    (s.map.minionsAt ||= {})['the-shire'] = ['minion-ringwraiths'];
    expect(evalMetric(s, cat, id(s), { count: 'shireControl' })).toBeGreaterThanOrEqual(3);
  });

  it('the four Explore-to-Discard events map to eventDeckPlot plots and carry no one-shot tree', () => {
    const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const id of [
      'event-t2-of-serpents-and-sand',
      'event-t2-the-glades-of-orthanc-darken',
      'event-t3-dark-news-from-erebor',
      'event-t3-the-blood-of-rh-n',
    ]) {
      const e = events.find((x) => x.id === id)!;
      expect(e, id).toBeTruthy();
      expect((e.tree as { k: string }).k, `${id} tree should be a no-op (lifecycle is authoritative)`).toBe('none');
      const plot = plots.find((p) => p.eventDeckPlot && norm(p.name) === norm(e.name));
      expect(plot, `${id} must have a matching eventDeckPlot`).toBeTruthy();
    }
  });

  it('a newly resolved eventDeckPlot replaces (not stacks with) one already on the Current Event Card space (manual p.15)', () => {
    let s = freshGame();
    s.phase = 'SauronEvents';
    s.story.sauron = { yellow: 7, red: 0, black: 0 }; // gameStage() -> 2, so drawEventCards keeps our forced deck
    s.sauron.eventStage = 2; // matches t2 events; skip the deck rebuild
    s.sauron.eventDeck = ['event-t2-the-glades-of-orthanc-darken', 'event-t2-of-serpents-and-sand'];
    s.sauron.eventDiscard = [];

    s = sauronResolveEvents(s, cat);
    expect(s.sauron.activeEventPlots?.map((p) => p.eventId)).toEqual(['glades-of-orthanc-darken']);
    expect(s.map.charactersAt?.['isengard']).toContain('saruman');

    s.phase = 'SauronEvents'; // simulate the next Sauron turn's Event Step
    s = sauronResolveEvents(s, cat);
    // Replaced, not stacked: exactly one active event-deck plot remains.
    expect(s.sauron.activeEventPlots?.map((p) => p.eventId)).toEqual(['of-serpents-and-sand']);
    // The bumped card's Character is removed and the card returns to discard.
    expect(s.map.charactersAt?.['isengard'] ?? []).not.toContain('saruman');
    expect(s.sauron.eventDiscard).toContain('event-t2-the-glades-of-orthanc-darken');
  });

  it('refined event/shadow trees use the exact atoms', () => {    const atomsIn = (tree: unknown): string[] => {
      const out: string[] = [];
      const walk = (n: any): void => {
        if (!n || typeof n !== 'object') return;
        if (n.k === 'op' && n.atom?.op) out.push(n.atom.op);
        (n.steps ?? []).forEach(walk);
        if (n.then) walk(n.then);
        if (n.else) walk(n.else);
        if (n.eff) walk(n.eff);
        (n.options ?? []).forEach((o: { eff: unknown }) => walk(o.eff));
      };
      walk(tree);
      return out;
    };
    const thieves = events.find((e) => e.id === 'event-t1-the-thieves-of-tharbad')!;
    expect(atomsIn(thieves.tree)).toContain('sauronMoveCharacter');
    const foe = events.find((e) => e.id === 'event-t2-the-foe-hammer')!;
    expect(atomsIn(foe.tree)).toContain('clearMonstersAt');
    const shire = shadowCards.find((c) => c.id === 'shadow-shire-baggins')!;
    expect(atomsIn(shire.tree)).toContain('advanceMarker');
  });

  it('advanceMarker advances the named marker as a direct integer sum', () => {
    const s = freshGame();
    s.story.sauron = { yellow: 3, red: 1, black: 0 };
    // A named coloured marker advances directly (feeds dominance / Finale).
    applyAtom(s, cat, activeId(s), { op: 'advanceMarker', marker: 'yellow', n: 2 });
    expect(s.story.sauron).toEqual({ yellow: 5, red: 1, black: 0 });
    // 'green' moves the hero clock; a negative n slows the heroes, clamped at 0.
    s.story.sauronProgress = 4;
    applyAtom(s, cat, activeId(s), { op: 'advanceMarker', marker: 'green', n: -1 });
    expect(s.story.sauronProgress).toBe(3);
    s.story.sauronProgress = 0;
    applyAtom(s, cat, activeId(s), { op: 'advanceMarker', marker: 'green', n: -5 });
    expect(s.story.sauronProgress).toBe(0);
  });
});

describe('concrete Sauron plot-deck manipulation (was plotManip)', () => {
  const byAdvance = [...plots].sort((a, b) => (a.advance ?? a.track.length) - (b.advance ?? b.track.length));
  const lo = byAdvance[0].id;
  const hi = byAdvance[byAdvance.length - 1].id;

  it('plotPeekReorder buries a weak top plot so a stronger one can surface', () => {
    const s = freshGame();
    s.sauron.plotDeck = [lo, hi];
    applyAtom(s, cat, activeId(s), { op: 'plotPeekReorder' });
    expect(s.sauron.plotDeck).toEqual([hi, lo]);
  });

  it('plotPeekReorder keeps a strong top plot on top', () => {
    const s = freshGame();
    s.sauron.plotDeck = [hi, lo];
    applyAtom(s, cat, activeId(s), { op: 'plotPeekReorder' });
    expect(s.sauron.plotDeck).toEqual([hi, lo]);
  });

  it('plotFromDiscard moves the best discarded plot into the Sauron hand', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDiscard = [lo, hi];
    applyAtom(s, cat, activeId(s), { op: 'plotFromDiscard' });
    expect(s.sauron.plotHand).toContain(hi);
    expect(s.sauron.plotDiscard).not.toContain(hi);
    expect(s.sauron.plotDiscard).toContain(lo);
  });

  it('plotFromDiscard is a no-op with an empty discard', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDiscard = [];
    expect(applyAtom(s, cat, activeId(s), { op: 'plotFromDiscard' })).toBe('');
    expect(s.sauron.plotHand).toEqual([]);
  });

  it('plotTutor fetches a named plot from the deck into the hand', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDeck = ['saruman-falls-to-corruption', 'denethor-falls-into-madness'];
    s.sauron.plotDiscard = [];
    applyAtom(s, cat, activeId(s), { op: 'plotTutor', ids: ['denethor-falls-into-madness', 'saruman-falls-to-corruption'] });
    // First id present is fetched; deck loses exactly it.
    expect(s.sauron.plotHand).toContain('denethor-falls-into-madness');
    expect(s.sauron.plotDeck).not.toContain('denethor-falls-into-madness');
    expect(s.sauron.plotDeck).toContain('saruman-falls-to-corruption');
  });

  it('plotTutor falls back to the discard pile and is a no-op when absent', () => {
    const s = freshGame();
    s.sauron.plotHand = [];
    s.sauron.plotDeck = [];
    s.sauron.plotDiscard = ['saruman-falls-to-corruption'];
    applyAtom(s, cat, activeId(s), { op: 'plotTutor', ids: ['denethor-falls-into-madness', 'saruman-falls-to-corruption'] });
    expect(s.sauron.plotHand).toContain('saruman-falls-to-corruption');
    expect(s.sauron.plotDiscard).toEqual([]);
    // Nothing to fetch -> no-op.
    expect(applyAtom(s, cat, activeId(s), { op: 'plotTutor', ids: ['no-such-plot'] })).toBe('');
  });

  it('the three shadow cards no longer use the abstract plotManip atom', () => {
    const raw = JSON.stringify(shadowCards);
    expect(raw).not.toContain('plotManip');
  });
});

describe('A Broken Line of Kings has two physical copies', () => {  it('appears twice in the plot catalogue with distinct ids', () => {
    const copies = plots.filter((p) => p.name === 'A Broken Line of Kings');
    expect(copies.map((p) => p.id).sort()).toEqual(['a-broken-line-of-kings', 'a-broken-line-of-kings-2']);
  });

  it('both copies are seeded into the 15-card Sauron plot pool', () => {
    const s = freshGame();
    const pool = [...(s.sauron.plotDeck ?? []), ...(s.sauron.plotHand ?? [])];
    expect(pool.length).toBe(15);
    expect(pool).toContain('a-broken-line-of-kings');
    expect(pool).toContain('a-broken-line-of-kings-2');
  });
});

describe('Shadow deck models the physical duplicate copies', () => {
  it.each([
    ['His Arm Has Grown Long', 'shadow-his-arm-has-grown-long'],
    ['Dark Promises', 'shadow-dark-promises'],
    ['Storms of Mordor', 'shadow-storms-of-mordor'],
  ])('%s has two independent copies (distinct ids, same name)', (name, baseId) => {
    const copies = shadowCards.filter((c) => c.name === name);
    expect(copies.map((c) => c.id).sort()).toEqual([baseId, `${baseId}-2`]);
  });

  it('every other Shadow card is a single copy (only those three duplicate)', () => {
    const counts = new Map<string, number>();
    for (const c of shadowCards) counts.set(c.name!, (counts.get(c.name!) ?? 0) + 1);
    const duped = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n).sort();
    expect(duped).toEqual(['Dark Promises', 'His Arm Has Grown Long', 'Storms of Mordor']);
  });

  it('both copies are drawable from the Shadow pool (set-based deck keys)', () => {
    const ids = new Set(Object.keys(cat.shadow));
    for (const base of ['shadow-his-arm-has-grown-long', 'shadow-dark-promises', 'shadow-storms-of-mordor']) {
      expect(ids.has(base)).toBe(true);
      expect(ids.has(`${base}-2`)).toBe(true);
    }
  });
});

describe('They Are Terrible fully heals and redeploys a minion', () => {
  it('uses the concrete reviveRelocateMinion atom (not spawnMonster)', () => {
    const card = shadowCards.find((c) => c.id === 'shadow-they-are-terrible')!;
    expect((card.tree as { atom?: { op: string } }).atom?.op).toBe('reviveRelocateMinion');
  });

  it('revives a defeated minion at full health onto the most-influenced location', () => {
    const s = freshGame();
    s.sauron.locationInfluence = { 'the-shire': 2, 'bree': 5 };
    s.map.minionsAt = {};              // all minions off the board (defeated)
    s.map.minionHealth = {};
    const out = applyAtom(s, cat, activeId(s), { op: 'reviveRelocateMinion' });
    const placed = s.map.minionsAt!['bree']?.[0];      // highest influence wins
    expect(placed, 'a minion should be placed at Bree').toBeTruthy();
    expect(s.map.minionHealth![placed!]).toBe(cat.minions[placed!].health); // damage removed
    expect(out).toContain('redeployed');
  });

  it('removes all damage from a wounded on-board minion and relocates it', () => {
    const s = freshGame();
    s.sauron.locationInfluence = { 'minas-morgul': 3 };
    // Both stage-1 minions on the board; only Black Serpent is wounded, so it is
    // the sole useful target (a full-health minion is left untouched).
    s.map.minionsAt = { 'the-shire': ['minion-black-serpent'], 'bree': ['minion-mouth-of-sauron'] };
    s.map.minionHealth = { 'minion-black-serpent': 1, 'minion-mouth-of-sauron': 9 };
    applyAtom(s, cat, activeId(s), { op: 'reviveRelocateMinion' });
    expect(s.map.minionsAt!['the-shire'] ?? []).not.toContain('minion-black-serpent');
    expect(s.map.minionsAt!['minas-morgul']).toContain('minion-black-serpent');
    expect(s.map.minionHealth!['minion-black-serpent']).toBe(cat.minions['minion-black-serpent'].health);
  });

  it('fizzles when no location holds influence', () => {
    const s = freshGame();
    s.sauron.locationInfluence = {};
    expect(applyAtom(s, cat, activeId(s), { op: 'reviveRelocateMinion' })).toBe('');
  });
});
