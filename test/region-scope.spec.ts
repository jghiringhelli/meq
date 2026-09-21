// "Your region" on an Encounter/Event card (e.g. "A Shadow Under the Shadow":
// "if your hero's strength equals or exceeds the influence in your region")
// must be scoped to the hero's current COLOR sub-region (e.g. "Brown" within
// the merged "Mordor and Brown Lands" Encounter-deck area), not the whole
// two-color deck-pair. Two colors share one physical Encounter deck for
// component convenience, but the manual treats each color as an independently
// scoped region for card effects.
import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { evalMetric } from '../src/engine/encounter';

describe('"your region" metrics are scoped to the color sub-region, not the merged deck-pair', () => {
  it('influenceInRegion only counts locations sharing the same regionColor as the hero', () => {
    const s = freshGame();
    const h = s.heroes[0];
    // Mordor and Brown Lands splits into "Brown" and "Red" sub-regions.
    const brown = Object.values(cat.locations).find((l) => l.regionColor === 'Brown')!;
    const red = Object.values(cat.locations).find((l) => l.regionColor === 'Red')!;
    expect(brown.regionId).toBe(red.regionId); // same merged deck-pair…
    expect(brown.regionColor).not.toBe(red.regionColor); // …but distinct regions

    h.location = brown.id;
    s.sauron.locationInfluence = { [brown.id]: 2, [red.id]: 9 };
    // Only the Brown location's 2 influence should count — NOT the Red
    // location's 9, even though both share the same merged regionId.
    expect(evalMetric(s, cat, h.id, { count: 'influenceInRegion' })).toBe(2);
  });

  it('monstersInRegion only counts monster tokens in the same color sub-region', () => {
    const s = freshGame();
    const h = s.heroes[0];
    const brown = Object.values(cat.locations).find((l) => l.regionColor === 'Brown')!;
    const red = Object.values(cat.locations).find((l) => l.regionColor === 'Red')!;
    h.location = brown.id;
    s.map.monstersAt = { [brown.id]: ['orc'], [red.id]: ['orc', 'orc', 'orc'] };
    expect(evalMetric(s, cat, h.id, { count: 'monstersInRegion' })).toBe(1);
  });
});
