// Regression test for a real bug: a Defeat-quest's encounter substitution
// ("When you would draw Encounter cards at <LOC>, combat a <Monster> instead")
// placed its foe as the hero's LAST action of the turn (Explore), by which
// point hero.actionsRemaining was already 0. Engaging that foe went through
// heroEngage -> spendActionForCombat, which used to require actionsRemaining >
// 0 and threw — silently swallowed by the UI ("nothing happens" on Fight).
// Combat should never be gated by the action budget (rulebook: engaging a foe
// is part of Ambush/Travel, not a metered action).
import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';
import { registerQuestCombat, locByName, questSubstituteMonster } from '../src/engine/quests';
import { heroExplore, heroEngage, engageableMonsters, advance } from '../src/engine/game';

describe('quest encounter-substitution combat', () => {
  it('places a revealed foe on Explore and lets the hero fight it with 0 actions left', () => {
    let s = newGame(cat, 7, ['beravor', 'thalin']);
    for (let i = 0; i < 50 && s.phase !== 'HeroActions'; i++) s = advance(s, cat);
    const hero = s.heroes.find((h) => h.id === 'beravor')!;
    const quest = cat.quests['quest-beravor-spies-in-mithlond'];
    const loc = locByName(cat, 'The Grey Havens')!;
    hero.quests = { startingDone: false, advancedDone: false, startingQuestId: quest.id };
    registerQuestCombat(cat, hero, quest, loc);
    expect(questSubstituteMonster(hero, loc)).toBe('mon-crebain');

    // Move the hero onto the quest location and spend all actions but one via
    // direct mutation (simulating "explore is the hero's last action").
    const fromLoc = s.map.heroesAt[hero.location];
    if (fromLoc) fromLoc.splice(fromLoc.indexOf(hero.id), 1);
    hero.location = loc;
    (s.map.heroesAt[loc] ||= []).push(hero.id);

    s = heroExplore(s, cat, 'beravor');
    const h2 = s.heroes.find((h) => h.id === 'beravor')!;
    expect(h2.actionsRemaining).toBe(0);
    expect(s.map.monstersAt[loc]).toContain('mon-crebain');
    expect(s.map.revealedMonstersAt ?? []).toContain(loc);
    expect(engageableMonsters(s, 'beravor')).toContain('mon-crebain');

    // The critical assertion: engaging must NOT throw despite 0 actions left.
    expect(() => heroEngage(s, cat, 'beravor', 'mon-crebain')).not.toThrow();
    const s2 = heroEngage(s, cat, 'beravor', 'mon-crebain');
    expect(s2.pendingCombat).toBeTruthy();
  });
});
