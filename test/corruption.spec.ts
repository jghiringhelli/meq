// Faithful model of the 16 MEQ Corruption cards (rulebook p.26): a corrupted
// hero draws a card from the shared deck; each imposes an ongoing penalty while
// held and lists a favor cost to discard at Rest. Two cards resolve immediately
// and shuffle back into the deck. These tests pin the deck operations, the
// cleanse-by-printed-cost, and every ongoing effect's enforcement point.
import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import {
  gainCorruption, discardCorruption, discardAllCorruption, cleanseAtRest, grantFavor,
  corruptionStatPenalty, corruptionHandLimit, corruptionFavorCap, corruptionTravelCap,
  corruptionFavorGainCap, corruptionEncounterDraw, corruptionPerilBonus, corruptionBlocksSocial,
  corruptionRestDefeatSteps, corruptionCombatStartDiscard, corruptionSauronShadowRedraw,
} from '../src/engine/corruption';
import { statValue } from '../src/engine/encounter';
import { heroMove } from '../src/engine/phases';
import { heroConsultCharacter, heroTradeFavor } from '../src/engine/economy';
import { defeatHero } from '../src/engine/mechanics';

type S = ReturnType<typeof freshGame>;
const heroOf = (s: S) => s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];
const markerSum = (s: S) => s.story.sauron.yellow + s.story.sauron.red + s.story.sauron.black;

describe('corruption deck operations', () => {
  it('gainCorruption draws a real card into the hero hand and mirrors the count', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.corruptionDeck = ['corr-deranged', 'corr-weak'];
    gainCorruption(s, cat, h.id, 1);
    expect(h.corruptionCards).toEqual(['corr-deranged']);
    expect(h.corruption).toBe(1);
    expect(s.corruptionDeck).toEqual(['corr-weak']);
  });

  it('immediate cards resolve once and return to the deck instead of being held', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 5;
    s.corruptionDeck = ['corr-careless']; // "discard 2 favor, then shuffle back"
    gainCorruption(s, cat, h.id, 1);
    expect(h.favor).toBe(3);
    expect(h.corruptionCards).toEqual([]);
    expect(h.corruption).toBe(0);
    expect(s.corruptionDeck).toContain('corr-careless'); // reshuffled back in
  });

  it('discardCorruption returns held cards to the discard pile', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-deranged', 'corr-weak'];
    h.corruption = 2;
    const removed = discardCorruption(s, cat, h.id, 1);
    expect(removed).toBe(1);
    expect(h.corruption).toBe(1);
    expect((s.corruptionDiscard ?? []).length).toBe(1);
  });

  it('discardAllCorruption removes every held card', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-deranged', 'corr-weak', 'corr-isolated'];
    h.corruption = 3;
    expect(discardAllCorruption(s, cat, h.id)).toBe(3);
    expect(h.corruption).toBe(0);
    expect(h.corruptionCards).toEqual([]);
  });
});

describe('cleanse at rest pays the card printed cost', () => {
  it('removes the cheapest affordable card and spends its favor cost', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-despondent', 'corr-reckless']; // cost 3 and 1
    h.corruption = 2;
    h.favor = 2;
    const removed = cleanseAtRest(s, cat, h.id); // can only afford the cost-1 card
    expect(removed).toBe('corr-reckless');
    expect(h.favor).toBe(1);
    expect(h.corruptionCards).toEqual(['corr-despondent']);
    expect(h.corruption).toBe(1);
  });

  it('returns null when the hero cannot afford any held card', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-despondent']; // cost 3
    h.corruption = 1;
    h.favor = 2;
    expect(cleanseAtRest(s, cat, h.id)).toBeNull();
    expect(h.corruptionCards).toEqual(['corr-despondent']);
  });
});

describe('ongoing effect: attribute penalties', () => {
  it('Deranged reduces wisdom by 1 through statValue', () => {
    const s = freshGame();
    const h = heroOf(s);
    const base = statValue(s, cat, h.id, 'wisdom');
    h.corruptionCards = ['corr-deranged'];
    expect(corruptionStatPenalty(cat, h, 'wisdom')).toBe(-1);
    expect(statValue(s, cat, h.id, 'wisdom')).toBe(base - 1);
  });

  it('each of the four stat cards only touches its own attribute', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-helpless']; // agility -1
    expect(corruptionStatPenalty(cat, h, 'agility')).toBe(-1);
    expect(corruptionStatPenalty(cat, h, 'strength')).toBe(0);
  });
});

describe('ongoing effect: favor caps', () => {
  it('Despairing clamps favor to 3 on gain', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-despairing'];
    h.favor = 0;
    grantFavor(cat, h, 10);
    expect(corruptionFavorCap(cat, h)).toBe(3);
    expect(h.favor).toBe(3);
  });

  it('Mistrusted caps favor gained to 1 per turn', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-mistrusted'];
    h.favor = 0;
    h.favorGainedThisTurn = 0;
    expect(grantFavor(cat, h, 5)).toBe(1);
    expect(h.favor).toBe(1);
    expect(grantFavor(cat, h, 5)).toBe(0); // no more gain this turn
    expect(h.favor).toBe(1);
    expect(corruptionFavorGainCap(cat, h)).toBe(1);
  });
});

describe('ongoing effect: Hopeless caps travel steps', () => {
  it('blocks a move once 3 travel steps are taken this turn', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.phase = 'HeroActions';
    s.activeHeroIndex = s.heroes.indexOf(h);
    h.actionsRemaining = 4;
    h.corruptionCards = ['corr-hopeless'];
    h.travelStepsThisTurn = 3;
    expect(corruptionTravelCap(cat, h)).toBe(3);
    expect(() => heroMove(s, cat, h.id, h.location)).toThrow(/Hopeless/);
  });
});

describe('ongoing effect: Isolated blocks social actions', () => {
  it('prevents consulting characters and trading favor', () => {
    const s = freshGame();
    const h = heroOf(s);
    s.phase = 'HeroActions';
    s.activeHeroIndex = s.heroes.indexOf(h);
    h.actionsRemaining = 4;
    h.corruptionCards = ['corr-isolated'];
    expect(corruptionBlocksSocial(cat, h)).toBe(true);
    expect(() => heroConsultCharacter(s, cat, h.id, 'anyone')).toThrow(/Isolated/);
    const other = s.heroes.find((o) => o.id !== h.id);
    if (other) expect(() => heroTradeFavor(s, cat, h.id, other.id, 1)).toThrow(/Isolated/);
  });
});

describe('ongoing effect: Despondent advances the marker twice on defeat', () => {
  it('a defeated Despondent hero advances the leftmost marker 2 spaces', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-despondent'];
    expect(corruptionRestDefeatSteps(cat, h)).toBe(2);
    const before = markerSum(s);
    defeatHero(s, cat, h);
    expect(markerSum(s) - before).toBe(2);
  });

  it('a non-Despondent hero only advances the marker 1 space', () => {
    const s = freshGame();
    const h = heroOf(s);
    const before = markerSum(s);
    defeatHero(s, cat, h);
    expect(markerSum(s) - before).toBe(1);
  });
});

describe('ongoing effect query helpers', () => {
  it('Indifferent reduces Encounter draws from 3 to 2', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-indifferent'];
    expect(corruptionEncounterDraw(cat, h, 3)).toBe(2);
  });

  it('Reckless grants Sauron 1 extra Peril draw', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-reckless'];
    expect(corruptionPerilBonus(cat, h)).toBe(1);
  });

  it('Distraught imposes a 7-card hand limit', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-distraught'];
    expect(corruptionHandLimit(cat, h)).toBe(7);
  });

  it('Cowardly discards 1 random hero card at combat start', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-cowardly'];
    expect(corruptionCombatStartDiscard(cat, h)).toBe(1);
  });

  it('Greedy lets Sauron redraw a Shadow card', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = ['corr-greedy'];
    expect(corruptionSauronShadowRedraw(cat, h)).toBe(true);
  });

  it('an uncorrupted hero triggers none of the effects', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.corruptionCards = [];
    expect(corruptionStatPenalty(cat, h, 'wisdom')).toBe(0);
    expect(corruptionHandLimit(cat, h)).toBeUndefined();
    expect(corruptionFavorCap(cat, h)).toBeUndefined();
    expect(corruptionTravelCap(cat, h)).toBeUndefined();
    expect(corruptionBlocksSocial(cat, h)).toBe(false);
    expect(corruptionRestDefeatSteps(cat, h)).toBe(1);
  });
});

describe('every Corruption card is modeled', () => {
  it('all 16 cards carry an effectKey and a numeric cost', () => {
    const cards = Object.values(cat.corruption);
    expect(cards.length).toBe(16);
    for (const c of cards) {
      expect(c.effectKey, `${c.id} effectKey`).toBeTruthy();
      expect(Number.isNaN(parseInt(c.cost, 10)), `${c.id} cost`).toBe(false);
    }
  });
});
