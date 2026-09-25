// Regression test: after a combat resolves, App.tsx needs a dismissible
// "what happened" summary (the user reported winning vs Crebain but the game
// went straight back to the map with no recap). pendingCombat still nulls
// immediately (so bots/self-play are unaffected — see other combat tests),
// but a separate `lastCombatSummary` field now survives until the player
// explicitly dismisses it via `dismissCombatSummary`.
import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';
import { registerQuestCombat, locByName } from '../src/engine/quests';
import { heroExplore, heroEngage, resolveChoice, dismissCombatSummary, advance } from '../src/engine/game';

describe('post-combat summary', () => {
  it('survives past pendingCombat clearing, and dismissCombatSummary clears it', () => {
    let s = newGame(cat, 7, ['beravor', 'thalin']);
    for (let i = 0; i < 50 && s.phase !== 'HeroActions'; i++) s = advance(s, cat);
    let hero = s.heroes.find((h) => h.id === 'beravor')!;
    const quest = cat.quests['quest-beravor-spies-in-mithlond'];
    const loc = locByName(cat, 'The Grey Havens')!;
    hero.quests = { startingDone: false, advancedDone: false, startingQuestId: quest.id };
    registerQuestCombat(cat, hero, quest, loc);
    const fromLoc = s.map.heroesAt[hero.location];
    if (fromLoc) fromLoc.splice(fromLoc.indexOf(hero.id), 1);
    hero.location = loc;
    (s.map.heroesAt[loc] ||= []).push(hero.id);

    s = heroExplore(s, cat, 'beravor');
    s = heroEngage(s, cat, 'beravor', 'mon-crebain');
    expect(s.lastCombatSummary).toBeFalsy(); // not yet resolved

    let guard = 0;
    while (s.pendingCombat && !s.pendingCombat.resolved && guard++ < 50) {
      s = resolveChoice(s, cat, s.pendingChoice!.options[0].id);
    }

    // Combat is over (pendingCombat cleared, unaffected for bots), but the
    // human-facing recap survives independently.
    expect(s.pendingCombat).toBeNull();
    expect(s.lastCombatSummary).toBeTruthy();
    expect(s.lastCombatSummary!.result).toBe('attacker');
    expect(s.lastCombatSummary!.foeName).toMatch(/Crebain/i);

    // A pending training choice (also raised by the reward) is untouched.
    expect(s.pendingChoice?.kind).toBe('training');

    s = dismissCombatSummary(s);
    expect(s.lastCombatSummary).toBeFalsy();
    // Dismissing the summary does not itself resolve the training choice.
    expect(s.pendingChoice?.kind).toBe('training');
  });

  it('keeps a persistent combatHistory (with the round-by-round report) after the summary is dismissed', () => {
    let s = newGame(cat, 7, ['beravor', 'thalin']);
    for (let i = 0; i < 50 && s.phase !== 'HeroActions'; i++) s = advance(s, cat);
    let hero = s.heroes.find((h) => h.id === 'beravor')!;
    const quest = cat.quests['quest-beravor-spies-in-mithlond'];
    const loc = locByName(cat, 'The Grey Havens')!;
    hero.quests = { startingDone: false, advancedDone: false, startingQuestId: quest.id };
    registerQuestCombat(cat, hero, quest, loc);
    const fromLoc = s.map.heroesAt[hero.location];
    if (fromLoc) fromLoc.splice(fromLoc.indexOf(hero.id), 1);
    hero.location = loc;
    (s.map.heroesAt[loc] ||= []).push(hero.id);

    s = heroExplore(s, cat, 'beravor');
    s = heroEngage(s, cat, 'beravor', 'mon-crebain');
    let guard = 0;
    while (s.pendingCombat && !s.pendingCombat.resolved && guard++ < 50) {
      s = resolveChoice(s, cat, s.pendingChoice!.options[0].id);
    }
    expect(s.combatHistory?.length).toBe(1);
    expect(s.combatHistory![0].report.length).toBeGreaterThan(0);
    expect(s.combatHistory![0]).toBe(s.lastCombatSummary);

    s = dismissCombatSummary(s);
    // The recap is gone, but the history entry survives for later review.
    expect(s.lastCombatSummary).toBeFalsy();
    expect(s.combatHistory?.length).toBe(1);
    expect(s.combatHistory![0].foeName).toMatch(/Crebain/i);
  });
});
