// Behavioural tests for the corrected training / attribute model (rulebook p.26):
//  * "Training" draws the top two Skill-deck cards and keeps one (added to the
//    hero's single deck) — it does NOT inject synthetic "Agility/Strength
//    Training" combat cards.
//  * Raising an attribute (agility / strength / wisdom / fortitude) is a Level
//    Token bump via raiseAttribute, capped at twice per attribute per game.
import { describe, it, expect } from 'vitest';
import { freshGame, cat } from './helpers';
import { grantTraining, raiseAttribute, isTrainedCard } from '../src/engine/mechanics';

describe('training — draws real Skill cards (not synthetic attribute cards)', () => {
  it('the synthetic advanced training cards no longer exist in the catalog', () => {
    expect(cat.combatCards['cmb-advanced-agility']).toBeUndefined();
    expect(cat.combatCards['cmb-advanced-strength']).toBeUndefined();
  });

  it('the Skill deck is seeded from the 20 deck:"skills" cards', () => {
    const s = freshGame();
    const skillTotal = Object.values(cat.combatCards).filter((c) => c.deck === 'skills').length;
    expect(skillTotal).toBe(20);
    expect(s.skillDeck?.length).toBe(20);
    expect(s.skillDiscard?.length).toBe(0);
  });

  it('one level of training draws two Skill cards and keeps one', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    const deck0 = hero.deck.length;
    const skill0 = s.skillDeck!.length;
    grantTraining(s, cat, hero, 1);
    expect(hero.deck.length).toBe(deck0 + 1);           // kept 1
    expect(s.skillDeck!.length).toBe(skill0 - 2);       // drew 2
    expect(s.skillDiscard!.length).toBe(1);             // discarded the other
    expect(hero.trainedCount).toBe(1);
    expect(hero.training).toBe(1);
    const kept = hero.deck.filter((id) => isTrainedCard(cat, id));
    expect(kept.length).toBe(1);
    expect(cat.combatCards[kept[0]].deck).toBe('skills');
  });

  it('a kept Skill card raises the hero max health (part of the deck)', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    const before = hero.deck.length + hero.hand.length + hero.discard.length;
    grantTraining(s, cat, hero, 1);
    const after = hero.deck.length + hero.hand.length + hero.discard.length;
    expect(after).toBe(before + 1);
  });

  it('training stops cleanly when the shared Skill deck is exhausted', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    // 20 skill cards → at most 10 levels of training before the deck runs dry.
    grantTraining(s, cat, hero, 50);
    expect(s.skillDeck!.length).toBe(0);
    expect(hero.trainedCount).toBeLessThanOrEqual(10);
    expect(hero.deck.filter((id) => isTrainedCard(cat, id)).length).toBe(hero.trainedCount);
  });
});

describe('attributes — raiseAttribute is a level bump capped at twice per game', () => {
  it.each(['fortitude', 'strength', 'agility', 'wisdom'] as const)(
    'raising %s applies up to two increases, then no more', (stat) => {
      const s = freshGame();
      const hero = s.heroes[0];
      expect(raiseAttribute(hero, stat, 1)).toBe(1);
      expect(raiseAttribute(hero, stat, 1)).toBe(1);
      expect(raiseAttribute(hero, stat, 1)).toBe(0);   // third increase refused
      expect(hero.statBonus[stat]).toBe(2);
      expect(hero.levels?.[stat]).toBe(2);
    });

  it('raising an attribute never adds a card to the hero deck', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    const deck0 = hero.deck.length;
    raiseAttribute(hero, 'agility', 1);
    raiseAttribute(hero, 'strength', 1);
    expect(hero.deck.length).toBe(deck0);
  });

  it('a single request for +2 is still capped at the 2-per-game maximum', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    expect(raiseAttribute(hero, 'wisdom', 5)).toBe(2);
    expect(hero.statBonus.wisdom).toBe(2);
  });
});
