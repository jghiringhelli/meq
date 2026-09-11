// Regression tests for consulting a Character's "Use Ability" choice (rulebook:
// consult for 2 favor OR the ability printed on the Character token — never
// both). The 8 texts below are owner-verified from the physical tokens (the
// full set in the box; there are no Galadriel/Elrond tokens in this game).
import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame, advance } from '../src/engine/game';
import { heroConsultCharacter } from '../src/engine/economy';

function ready(seed: number) {
  let s = newGame(cat, seed, ['beravor', 'thalin']);
  for (let i = 0; i < 50 && s.phase !== 'HeroActions'; i++) s = advance(s, cat);
  return s;
}

function place(s: ReturnType<typeof newGame>, character: string) {
  const hero = s.heroes[s.activeHeroIndex];
  (s.map.charactersAt ||= {})[hero.location] = [character];
  return hero;
}

describe('Character consult abilities', () => {
  it('Gandalf: +1 wisdom', () => {
    let s = ready(1);
    const hero = place(s, 'Gandalf');
    const before = hero.statBonus?.wisdom ?? 0;
    s = heroConsultCharacter(s, cat, hero.id, 'Gandalf', 'ability');
    const h2 = s.heroes.find((h) => h.id === hero.id)!;
    expect((h2.statBonus?.wisdom ?? 0)).toBe(before + 1);
  });

  it('Boromir: +1 strength', () => {
    let s = ready(1);
    const hero = place(s, 'Boromir');
    s = heroConsultCharacter(s, cat, hero.id, 'Boromir', 'ability');
    const h2 = s.heroes.find((h) => h.id === hero.id)!;
    expect(h2.statBonus?.strength ?? 0).toBe(1);
  });

  it('Aragorn: +1 agility', () => {
    let s = ready(1);
    const hero = place(s, 'Aragorn');
    s = heroConsultCharacter(s, cat, hero.id, 'Aragorn', 'ability');
    const h2 = s.heroes.find((h) => h.id === hero.id)!;
    expect(h2.statBonus?.agility ?? 0).toBe(1);
  });

  it("Théoden: gains a Horse item", () => {
    let s = ready(1);
    const hero = place(s, 'Théoden');
    s = heroConsultCharacter(s, cat, hero.id, 'Théoden', 'ability');
    const h2 = s.heroes.find((h) => h.id === hero.id)!;
    expect(h2.items).toContain('Horse');
  });

  it('Dain II: trains twice (raises a pending training choice, chained)', () => {
    let s = ready(1);
    const hero = place(s, 'Dain II');
    s = heroConsultCharacter(s, cat, hero.id, 'Dain II', 'ability');
    expect(s.pendingChoice?.kind).toBe('training');
    expect(s.pendingTraining?.remaining).toBe(2);
  });

  it('Denethor: pays 3 favor to advance the hero story marker, or no-ops if too poor', () => {
    let s = ready(1);
    let hero = place(s, 'Denethor');
    hero.favor = 5;
    const beforeProgress = s.story.sauronProgress;
    s = heroConsultCharacter(s, cat, hero.id, 'Denethor', 'ability');
    let h2 = s.heroes.find((h) => h.id === hero.id)!;
    expect(h2.favor).toBe(2);
    expect(s.story.sauronProgress).toBe(beforeProgress + 1);

    // Too poor: no effect, no throw.
    let s2 = ready(1);
    let hero2 = place(s2, 'Denethor');
    hero2.favor = 1;
    const before2 = s2.story.sauronProgress;
    s2 = heroConsultCharacter(s2, cat, hero2.id, 'Denethor', 'ability');
    expect(s2.heroes.find((h) => h.id === hero2.id)!.favor).toBe(1);
    expect(s2.story.sauronProgress).toBe(before2);
  });

  it('Saruman: Sauron discards up to 2 random Shadow cards', () => {
    let s = ready(1);
    const hero = place(s, 'Saruman');
    const before = s.sauron.shadowHand.length;
    s = heroConsultCharacter(s, cat, hero.id, 'Saruman', 'ability');
    expect(s.sauron.shadowHand.length).toBe(Math.max(0, before - 2));
  });

  it('Thranduil: removes up to 2 influence from the Shadow Pool', () => {
    let s = ready(1);
    const hero = place(s, 'Thranduil');
    s.sauron.influence = 5;
    s = heroConsultCharacter(s, cat, hero.id, 'Thranduil', 'ability');
    expect(s.sauron.influence).toBe(3);
  });

  it('an unmodeled Character (no ability data) falls back to the ally placeholder without throwing', () => {
    let s = ready(1);
    const hero = place(s, 'Someone Else');
    expect(() => heroConsultCharacter(s, cat, hero.id, 'Someone Else', 'ability')).not.toThrow();
  });
});
