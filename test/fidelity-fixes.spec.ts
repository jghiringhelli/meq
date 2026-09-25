import { describe, it, expect } from 'vitest';
import { cat, freshGame, minions } from './helpers';
import { gameStage, hasItem, legalMoves, ambushPending } from '../src/engine/mechanics';
import { deployMinion } from '../src/engine/setup';
import { heroRest, heroMove, resolveCombatOrPeril } from '../src/engine/phases';
import { canSurvey, heroSurvey, resolveSurveyChoice } from '../src/engine/economy';
import { adjacentLocations } from '../src/engine/sauronPlay';
import { eyePlaceInfluenceOnce } from '../src/engine/ai';
import { applyAction } from '../src/engine/actions';
import { influenceAt } from '../src/engine/influence';
import { applyHeroAction } from '../src/engine/heroAI';

const boardInfluenceTotal = (s: ReturnType<typeof freshGame>) =>
  Object.values(s.sauron.locationInfluence ?? {}).reduce((n, v) => n + (v as number), 0);

const activeHero = (s: ReturnType<typeof freshGame>) =>
  s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];

// --- C3: game stage follows the story marker CLOSEST to the Finale ----------
describe('C3 — game stage tracks the furthest-advanced story marker', () => {
  it('reads the hero (green) marker when it leads', () => {
    const s = freshGame();
    s.story.sauronProgress = 8; // stage 2
    s.story.sauron = { yellow: 0, red: 0, black: 0 };
    expect(gameStage(s)).toBe(2);
  });

  it('reads a Sauron marker when one of them is furthest along', () => {
    const s = freshGame();
    s.story.sauronProgress = 1; // hero marker barely moved
    s.story.sauron = { yellow: 0, red: 13, black: 2 }; // red is in stage 3
    expect(gameStage(s)).toBe(3);
  });

  it('is stage 1 only when every marker is in the first band', () => {
    const s = freshGame();
    s.story.sauronProgress = 6;
    s.story.sauron = { yellow: 4, red: 5, black: 6 };
    expect(gameStage(s)).toBe(1);
  });
});

// --- C2: the Ringwraiths are a normal stage-II minion AND the Finale foe -----
describe('C2 — Ringwraiths deploy as a normal stage-II minion', () => {
  it('the roster contains exactly 5 minions, one flagged finale', () => {
    expect(minions.length).toBe(5);
    expect(minions.filter((m) => m.finale).length).toBe(1);
  });

  it('all five minions (incl. the Ringwraiths) reach the board by stage 3', () => {
    const s = freshGame();
    s.story.sauronProgress = 15; // stage 3
    let guard = 0;
    while (deployMinion(s, cat) && guard++ < 20) { /* deploy full reserve */ }
    const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
    expect([...onBoard].some((mid) => cat.minions[mid].finale)).toBe(true);
    expect(onBoard.size).toBe(minions.length);
  });

  it('withholds the finale foe once the Finale has begun', () => {
    const s = freshGame();
    s.story.sauronProgress = 15;
    s.story.finale = true;
    let guard = 0;
    while (deployMinion(s, cat) && guard++ < 20) { /* deploy remaining reserve */ }
    const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
    expect([...onBoard].some((mid) => cat.minions[mid].finale)).toBe(false);
  });
});

// --- C4: the Horse item discounts any-card path costs -----------------------
describe('C4 — Horse item reduces any-card movement cost', () => {
  it('hasItem matches an item by catalog id or display name', () => {
    const hero = { items: ['item-horse'] } as never;
    expect(hasItem(hero, 'item-horse', 'Horse')).toBe(true);
    const hero2 = { items: ['Horse'] } as never;
    expect(hasItem(hero2, 'item-horse', 'Horse')).toBe(true);
    const hero3 = { items: [] } as never;
    expect(hasItem(hero3, 'item-horse', 'Horse')).toBe(false);
  });

  it('lowers the any-card cost of a move by 1 (min 1) when the hero holds a Horse', () => {
    const s = freshGame();
    const hero = activeHero(s);
    const before = legalMoves(cat, hero);
    hero.items = [...(hero.items ?? []), 'item-horse'];
    const after = legalMoves(cat, hero);
    for (const mv of after) expect(mv.cost).toBeGreaterThanOrEqual(1);
    const afterByTo = new Map(after.map((m) => [m.to, m] as const));
    // Every any-card move costing >1 without the Horse costs exactly 1 less with it.
    for (const mv of before.filter((m) => m.viaAnyCards && m.cost > 1)) {
      expect(afterByTo.get(mv.to)?.cost).toBe(mv.cost - 1);
    }
    // No move ever gets more expensive with the Horse.
    for (const mv of before) {
      const a = afterByTo.get(mv.to);
      if (a) expect(a.cost).toBeLessThanOrEqual(mv.cost);
    }
  });
});

// --- M6: Beravor may heal OR receive training when resting outside a Haven ---
describe('M6 — Beravor Survivalist rest option', () => {
  const setupBeravorRest = (wounded: boolean) => {
    const s = freshGame();
    const beravor = s.heroes.find((h) => h.id === 'beravor');
    if (!beravor) return null;
    beravor.status = 'active';
    s.activeHeroIndex = s.heroes.indexOf(beravor);
    s.phase = 'HeroActions';
    // Move her to a non-Haven, foe-free wilderness location.
    const nonHaven = Object.values(cat.locations).find(
      (l) => l.kind !== 'stronghold' && l.kind !== 'haven' && l.id !== beravor.location,
    );
    if (nonHaven) beravor.location = nonHaven.id;
    (s.map.monstersAt as Record<string, string[]>)[beravor.location] = [];
    if (s.map.minionsAt) s.map.minionsAt[beravor.location] = [];
    beravor.damagePool = wounded ? ['x1', 'x2'] : [];
    beravor.actionsRemaining = 1;
    return { s, beravor };
  };

  it('heals when Beravor has damage to recover', () => {
    const ctx = setupBeravorRest(true);
    if (!ctx) return;
    const dmgBefore = ctx.beravor.damagePool.length;
    const out = heroRest(ctx.s, cat, 'beravor');
    const after = out.heroes.find((h) => h.id === 'beravor')!;
    expect(after.damagePool.length).toBeLessThan(dmgBefore);
  });

  it('receives training when Beravor has no damage to heal', () => {
    const ctx = setupBeravorRest(false);
    if (!ctx) return;
    const out = heroRest(ctx.s, cat, 'beravor');
    const trained = out.log.some(
      (e) => e.actor === 'beravor' && /receives training/i.test(e.detail),
    );
    expect(trained).toBe(true);
  });

  it('may choose training even while wounded (survivalist is optional)', () => {
    const ctx = setupBeravorRest(true);
    if (!ctx) return;
    const dmgBefore = ctx.beravor.damagePool.length;
    const out = heroRest(ctx.s, cat, 'beravor', { beravorTrain: true });
    const after = out.heroes.find((h) => h.id === 'beravor')!;
    const trained = out.log.some(
      (e) => e.actor === 'beravor' && /receives training/i.test(e.detail),
    );
    expect(trained).toBe(true);
    expect(after.damagePool.length).toBe(dmgBefore); // chose training, not healing
  });
});

// --- Boat / water paths (rulebook p.22) -------------------------------------
describe('Boat — water paths cost 1 any-card, ignoring the printed icon', () => {
  const woodsCard = Object.values(cat.combatCards).find((c) => c.terrain === 'woods')!.id;
  const atStart = (s: ReturnType<typeof freshGame>) => {
    const hero = activeHero(s);
    hero.location = 'harlindon';
    hero.hand = [woodsCard]; // holds the matching-terrain card for the water edge
    hero.items = [];
    return hero;
  };

  it('without a Boat, the woods-icon water path is paid with the matching card', () => {
    const s = freshGame();
    const hero = atStart(s);
    const mv = legalMoves(cat, hero).find((m) => m.to === 'the-grey-havens');
    expect(mv).toBeTruthy();
    expect(mv!.viaAnyCards).toBe(false); // must spend the woods card
  });

  it('with a Boat, the same water path is crossed with any one card (cost 1)', () => {
    const s = freshGame();
    const hero = atStart(s);
    hero.items = ['Boat'];
    const mv = legalMoves(cat, hero).find((m) => m.to === 'the-grey-havens');
    expect(mv).toBeTruthy();
    expect(mv!.viaAnyCards).toBe(true);
    expect(mv!.cost).toBe(1);
  });

  it('a Horse does NOT ease water paths (only a Boat does)', () => {
    const s = freshGame();
    const hero = atStart(s);
    hero.hand = ['x1', 'x2']; // no matching-terrain card → any-card fallback
    hero.items = ['item-horse'];
    const mv = legalMoves(cat, hero).find((m) => m.to === 'the-grey-havens');
    expect(mv).toBeTruthy();
    expect(mv!.viaAnyCards).toBe(true);
    expect(mv!.cost).toBe(2); // horse gives no discount on water (base cost 2 stays)
  });
});

// --- C1: turn economy — repeatable Travel, free Explore, once-per-turn Rest --
describe('C1 — travel steps repeat (no 2-action budget)', () => {
  const activeTurnHero = (s: ReturnType<typeof freshGame>) => {
    const hero = activeHero(s);
    hero.status = 'active';
    s.activeHeroIndex = s.heroes.indexOf(hero);
    s.phase = 'HeroActions';
    hero.actionsRemaining = 1; // binary "turn active" gate, not a 2-action budget
    hero.travelStepsThisTurn = 0;
    hero.turnTravelCap = undefined;
    hero.corruptionCards = [];
    return hero;
  };

  it('offers legal moves even after many travel steps (not capped at 2)', () => {
    const s = freshGame();
    const hero = activeTurnHero(s);
    hero.travelStepsThisTurn = 5; // far beyond the old 2-action cap
    expect(legalMoves(cat, hero).length).toBeGreaterThan(0);
  });

  it('turnTravelCap (restrictMovement) blocks travel once reached', () => {
    const s = freshGame();
    const hero = activeTurnHero(s);
    hero.turnTravelCap = 1;
    hero.travelStepsThisTurn = 0;
    expect(legalMoves(cat, hero).length).toBeGreaterThan(0);
    hero.travelStepsThisTurn = 1;
    expect(legalMoves(cat, hero)).toEqual([]);
  });

  it('Hopeless corruption caps travel at 3 per turn', () => {
    const s = freshGame();
    const hero = activeTurnHero(s);
    hero.corruptionCards = ['corr-hopeless'];
    hero.travelStepsThisTurn = 2;
    expect(legalMoves(cat, hero).length).toBeGreaterThan(0);
    hero.travelStepsThisTurn = 3;
    expect(legalMoves(cat, hero)).toEqual([]);
  });

  it('Rest is once per turn — a second Rest this turn throws', () => {
    const s = freshGame();
    const hero = activeTurnHero(s);
    // Put the hero somewhere restable and foe-free.
    (s.map.monstersAt as Record<string, string[]>)[hero.location] = [];
    if (s.map.minionsAt) s.map.minionsAt[hero.location] = [];
    const out = heroRest(s, cat, hero.id);
    expect(out.heroes[s.activeHeroIndex].restedThisTurn).toBe(true);
    expect(() => heroRest(out, cat, hero.id)).toThrow(/already taken/i);
  });

  it('Rest is its own step — it must happen before Move, not after', () => {
    const s = freshGame();
    const hero = activeTurnHero(s);
    (s.map.monstersAt as Record<string, string[]>)[hero.location] = [];
    if (s.map.minionsAt) s.map.minionsAt[hero.location] = [];
    const mv = legalMoves(cat, hero)[0];
    expect(mv).toBeTruthy();
    const moved = heroMove(s, cat, hero.id, mv.to);
    // Once the hero has taken a Travel step this turn, Rest is no longer legal.
    expect(() => heroRest(moved, cat, hero.id)).toThrow(/before moving/i);
  });
});

// --- M3: Combat OR Peril choice at a perilous, occupied location (p.22) ------
describe('M3 — Sauron chooses Combat or Peril', () => {
  const anyMonster = Object.keys(cat.monsters)[0];
  const anyMinion = minions[0].id;
  const setupTravelInto = (foe: 'monster' | 'minion', hand: number) => {
    const s = freshGame();
    const hero = activeHero(s);
    hero.status = 'active';
    s.activeHeroIndex = s.heroes.indexOf(hero);
    s.phase = 'HeroActions';
    hero.actionsRemaining = 1;
    hero.travelStepsThisTurn = 0;
    hero.turnTravelCap = undefined;
    hero.corruptionCards = [];
    hero.hand = Array.from({ length: hand }, (_, i) => `dummy-${i}`);
    const mv = legalMoves(cat, hero).find((m) => cat.locations[m.to]?.kind !== 'haven');
    if (!mv) return null;
    const to = mv.to;
    // Travel spends `mv.cost` any-cards BEFORE the Combat-or-Peril check, so top the
    // hand up to leave exactly `hand` cards at the decision point — the "well-armed"
    // signal the automa reads is the post-payment hand.
    hero.hand = Array.from({ length: hand + mv.cost }, (_, i) => `dummy-${i}`);
    // Seat a foe at the destination and make it perilous with heavy influence.
    (s.map.monstersAt as Record<string, string[]>)[to] = foe === 'monster' ? [anyMonster] : [];
    (s.map.minionsAt ||= {})[to] = foe === 'minion' ? [anyMinion] : [];
    (s.sauron.locationInfluence ||= {})[to] = 30;
    return { s, hero, to };
  };

  it('automa draws Peril at a perilous, minion-free spot when the hero is well-armed', () => {
    const ctx = setupTravelInto('monster', 6);
    if (!ctx) return;
    const out = heroMove(ctx.s, cat, ctx.hero.id, ctx.to);
    const hero = out.heroes[out.activeHeroIndex];
    expect(hero.perilResolvedAt).toContain(ctx.to);
    expect(ambushPending(out, hero)).toBe(false); // may travel on past the foe
  });

  it('automa forces combat when a minion guards the location', () => {
    const ctx = setupTravelInto('minion', 6);
    if (!ctx) return;
    const out = heroMove(ctx.s, cat, ctx.hero.id, ctx.to);
    const hero = out.heroes[out.activeHeroIndex];
    expect(hero.perilResolvedAt ?? []).not.toContain(ctx.to);
    expect(ambushPending(out, hero)).toBe(true); // must fight the minion
    // The Combat-or-Peril decision must be explicit in the log, not silent
    // (players need to see that the Eye deliberately chose combat).
    expect(out.log.some((l) => l.detail.includes('Combat or Peril: forces combat'))).toBe(true);
  });

  it('a human Sauron gets an interactive Combat-or-Peril decision', () => {
    const ctx = setupTravelInto('monster', 6);
    if (!ctx) return;
    ctx.s.humanSide = 'Sauron';
    ctx.s.sauronReactsAuto = false;
    const moved = heroMove(ctx.s, cat, ctx.hero.id, ctx.to);
    expect(moved.pendingCombatOrPeril).toEqual({ heroId: ctx.hero.id, loc: ctx.to });
    // Resolving 'peril' lets the hero move on; 'combat' leaves the foe blocking.
    const asPeril = resolveCombatOrPeril(moved, cat, 'peril');
    expect(asPeril.pendingCombatOrPeril).toBeNull();
    expect(asPeril.heroes[asPeril.activeHeroIndex].perilResolvedAt).toContain(ctx.to);
    const asCombat = resolveCombatOrPeril(moved, cat, 'combat');
    expect(ambushPending(asCombat, asCombat.heroes[asCombat.activeHeroIndex])).toBe(true);
  });

  it('coerces an AI "consult" action into engaging the ambushing foe instead of throwing (regression)', () => {
    // Regression for a fuzzer-found bug: applyHeroAction's ambush-coercion list
    // omitted 'consult', so an AI hero sharing its ambushed location with a
    // Character token would crash with an uncaught "Ambush: fight the foe
    // here before exploring" error instead of being redirected to combat.
    const s = freshGame();
    const hero = activeHero(s);
    hero.status = 'active';
    s.activeHeroIndex = s.heroes.indexOf(hero);
    s.phase = 'HeroActions';
    hero.actionsRemaining = 1;
    // Move off the starting Haven — a foe/Character never forces combat in a Haven.
    const nonHaven = legalMoves(cat, hero).find((m) => cat.locations[m.to]?.kind !== 'haven');
    hero.location = nonHaven!.to;
    const anyMonster = Object.keys(cat.monsters ?? {})[0];
    (s.map.monstersAt as Record<string, string[]>)[hero.location] = [anyMonster];
    (s.map.charactersAt ||= {})[hero.location] = ['gandalf'];
    expect(ambushPending(s, hero, cat)).toBe(true);
    const out = applyHeroAction(s, cat, hero.id, { kind: 'consult', character: 'gandalf', choice: 'favor' });
    // Should be redirected into combat (engagement), not throw and not consult.
    expect(out.pendingCombat).toBeTruthy();
    expect(out.map.charactersAt?.[hero.location] ?? []).toContain('gandalf'); // untouched
  });

  it('forces combat (never Peril) when a monster guards an ACTIVE-PLOT location, even vs a strong hand', () => {
    const ctx = setupTravelInto('monster', 8); // a strong hand would normally earn Peril
    if (!ctx) return;
    ctx.s.sauron.activePlots = [{ location: ctx.to } as never];
    const out = heroMove(ctx.s, cat, ctx.hero.id, ctx.to);
    const hero = out.heroes[out.activeHeroIndex];
    expect(hero.perilResolvedAt ?? []).not.toContain(ctx.to);
    expect(ambushPending(out, hero)).toBe(true); // must fight to reach and break the plot
  });

  const setupTravelIntoRumor = (perilous: boolean) => {
    const s = freshGame();
    const hero = activeHero(s);
    hero.status = 'active';
    s.activeHeroIndex = s.heroes.indexOf(hero);
    s.phase = 'HeroActions';
    hero.actionsRemaining = 1;
    hero.travelStepsThisTurn = 0;
    hero.turnTravelCap = undefined;
    hero.corruptionCards = [];
    hero.hand = Array.from({ length: 6 }, (_, i) => `dummy-${i}`);
    const mv = legalMoves(cat, hero).find((m) =>
      cat.locations[m.to]?.kind !== 'haven' && (perilous || !cat.locations[m.to]?.perilous));
    if (!mv) return null;
    const to = mv.to;
    // A face-down BLANK token (false rumor) only — no real foe.
    (s.map.rumorsAt ||= {})[to] = 1;
    s.sauron.locationInfluence = perilous ? { [to]: 30 } : {};
    return { s, hero, to };
  };

  it('keeps a false rumor (blank) as a bluff and takes Peril at a perilous blank-only spot', () => {
    const ctx = setupTravelIntoRumor(true);
    if (!ctx) return;
    const out = heroMove(ctx.s, cat, ctx.hero.id, ctx.to);
    const hero = out.heroes[out.activeHeroIndex];
    expect(out.map.rumorsAt?.[ctx.to]).toBe(1);       // the bluff survives (Sauron chose Peril)
    expect(ambushPending(out, hero)).toBe(false);     // no real foe blocks travel/explore
  });

  it('reveals and discards a false rumor at a non-perilous blank-only spot', () => {
    const ctx = setupTravelIntoRumor(false);
    if (!ctx) return;
    const out = heroMove(ctx.s, cat, ctx.hero.id, ctx.to);
    expect(out.map.rumorsAt?.[ctx.to] ?? 0).toBe(0);  // blank flipped, revealed false, discarded
  });
});

// --- Reveal asymmetry: Argalad's Survivalist can tell a bluff from a monster --
// A hero cannot normally distinguish a face-down monster from a false rumor
// (blank). Argalad's Survivalist reveals an adjacent location's tokens, which
// must include blank-only locations (he sees the bluff for what it is).
describe('Reveal — Survivalist sees both monsters and false rumors', () => {
  const setupArgaladNextTo = (kind: 'monster' | 'rumor') => {
    const s = freshGame();
    const argalad = s.heroes.find((h) => h.id === 'argalad');
    if (!argalad) return null;
    argalad.status = 'active';
    argalad.abilityUsedThisTurn = false;
    s.phase = 'HeroActions';
    s.activeHeroIndex = s.heroes.indexOf(argalad);
    // Find an adjacent non-haven location to seat a face-down token.
    const adj = adjacentLocations(cat, argalad.location);
    const to = adj.find((l) => cat.locations[l]?.kind !== 'haven');
    if (!to) return null;
    if (kind === 'monster') {
      (s.map.monstersAt as Record<string, string[]>)[to] = [Object.keys(cat.monsters)[0]];
    } else {
      (s.map.rumorsAt ||= {})[to] = 1;
    }
    return { s, argalad, to };
  };

  it('lists a blank-only (false rumor) location as a survey target', () => {
    const ctx = setupArgaladNextTo('rumor');
    if (!ctx) return;
    expect(canSurvey(ctx.s, cat, ctx.argalad.id)).toBe(true);
    const out = heroSurvey(ctx.s, cat, ctx.argalad.id);
    // Either it auto-revealed the single target or offered it as the sole option.
    const revealed = out.map.revealedMonstersAt ?? [];
    const offered = out.pendingChoice?.options?.some((o) => o.id.endsWith(ctx.to)) ?? false;
    expect(revealed.includes(ctx.to) || offered).toBe(true);
  });

  it('surveying a blank removes its bluff so the hero no longer routes around it', () => {
    const ctx = setupArgaladNextTo('rumor');
    if (!ctx) return;
    let out = heroSurvey(ctx.s, cat, ctx.argalad.id);
    if (out.pendingChoice) {
      const opt = out.pendingChoice.options.find((o) => o.id.endsWith(ctx.to))!;
      resolveSurveyChoice(out, cat, opt.id);
    }
    expect((out.map.revealedMonstersAt ?? []).includes(ctx.to)).toBe(true);
  });
});

// --- M5: Shadow Pool economy — board influence is NOT paid from the Pool -----
// (rulebook pp. 15-16): a Place-Influence action draws board tokens from the
// unlimited Influence area; the Shadow Pool is a separate reserve (≤2/turn,
// cap 4×stage) spent on spawns/plots. The automa's board placement must not
// deduct the Pool.
describe('M5 — placing board influence never drains the Shadow Pool', () => {
  it('places a board token with the Pool at 0 and leaves the Pool untouched', () => {
    const s = freshGame();
    s.sauron.influence = 0; // empty Pool — old code refused to place here
    const boardBefore = boardInfluenceTotal(s);
    const placed = eyePlaceInfluenceOnce(s, cat);
    expect(placed).toBe(true);
    expect(s.sauron.influence).toBe(0); // Pool untouched
    expect(boardInfluenceTotal(s)).toBe(boardBefore + 1); // one board token from supply
  });

  it('keeps the Pool constant across several board placements', () => {
    const s = freshGame();
    s.sauron.influence = 3;
    for (let i = 0; i < 4; i++) eyePlaceInfluenceOnce(s, cat);
    expect(s.sauron.influence).toBe(3); // never spent on the board
    expect(influenceAt(s, s.heroes[0].location) >= 0).toBe(true);
  });
});

// --- Setup fidelity: single starting hand + plot-driven Shadow Pool ----------
describe('Setup — starting hand is dealt once (rulebook p.10, p.19)', () => {
  it('freshGame deals exactly fortitude cards, flagged so the first refresh skips its draw', () => {
    const s = freshGame();
    const h = s.heroes[s.activeHeroIndex];
    const fort = cat.heroes[h.id].fortitude;
    expect(h.hand.length).toBe(fort);
    expect(h.startingHandReady).toBe(true);
  });

  it('the first Hero Refresh does NOT re-draw (no double hand on turn 1)', () => {
    const fresh = freshGame();
    const h0 = fresh.heroes[fresh.activeHeroIndex];
    const fort = cat.heroes[h0.id].fortitude;
    const after = applyAction(fresh, cat, { t: 'advance' }); // runs HeroRefresh
    const h = after.heroes[after.activeHeroIndex];
    expect(h.hand.length).toBe(fort); // still one hand, not 2×fortitude
    expect(h.startingHandReady).toBeFalsy();
  });
});

describe('Setup — the Shadow Pool is seeded from the starting plot, not a default', () => {
  it('pool influence equals the active starting plot’s "in the Shadow Pool" number', () => {
    const s = freshGame();
    const startId = (s.sauron.activePlots ?? [])[0]?.eventId;
    const plot = cat.plots.find((p) => p.id === startId);
    const m = /(\d+)\s+in the Shadow Pool/i.exec(plot?.effect ?? '');
    const expected = m ? parseInt(m[1], 10) : 0;
    expect(s.sauron.influence).toBe(expected);
    // Board influence (each-stronghold + extension) was placed separately.
    expect(boardInfluenceTotal(s)).toBeGreaterThan(0);
  });
});
