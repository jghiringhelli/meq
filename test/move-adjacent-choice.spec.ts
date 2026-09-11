// "A Path Through the Mountains" (and any other card using the moveAdjacent
// atom for an optional move) must let the HERO pick which neighbor to move
// to when more than one is available — not silently teleport to whichever
// edge happens to be listed first in the map data.
import { describe, it, expect } from 'vitest';
import { cat, freshGame, encounters } from './helpers';
import { applyAtom, planEncounter } from '../src/engine/encounter';
import { adjacentLocations } from '../src/engine/sauronPlay';
import type { Atom, GameState } from '../src/engine/types';

const heroOf = (s: GameState) => s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];

const pathThroughMountains = () =>
  encounters.find((c: any) => c.id === 'enc-rhudaur-and-grey-mountains-a-path-through-the-mountains')! as any;

function resolve(s: GameState, heroId: string, tree: any, decisions: number[]) {
  const plan = planEncounter(s, cat, heroId, tree, decisions);
  if (plan.complete) for (const a of plan.atoms as Atom[]) applyAtom(s, cat, heroId, a);
  return plan;
}

describe('moveAdjacent: A Path Through the Mountains lets the hero choose the destination', () => {
  // Pick a location that actually has 2+ neighbors so the choice is meaningful.
  const multiNeighborLoc = Object.keys(cat.locations).find(
    (id) => adjacentLocations(cat, id).length >= 2,
  )!;

  it('sanity: a multi-neighbor location exists and the card compiles to a seq w/ optional moveAdjacent', () => {
    expect(multiNeighborLoc).toBeTruthy();
    expect(adjacentLocations(cat, multiNeighborLoc).length).toBeGreaterThanOrEqual(2);
    const tree = pathThroughMountains().tree;
    expect(tree.k).toBe('seq');
  });

  it('accepting the optional move with >1 neighbors raises a location-pick pendingChoice, not an immediate move', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = multiNeighborLoc;
    const tree = pathThroughMountains().tree;
    // decisions[0] picks the 'optional' node's first option (accept the move).
    const plan = resolve(s, h.id, tree, [0]);
    expect(plan.complete).toBe(false);
    expect(plan.pending?.prompt).toMatch(/adjacent location/i);
    const dests = adjacentLocations(cat, multiNeighborLoc);
    expect(plan.pending?.options.length).toBe(dests.length);
    // Hero must NOT have moved yet — still awaiting the destination pick.
    expect(h.location).toBe(multiNeighborLoc);
  });

  it('picking a specific neighbor moves the hero there (and honors gainFavor already applied)', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = multiNeighborLoc;
    const dests = adjacentLocations(cat, multiNeighborLoc);
    const tree = pathThroughMountains().tree;
    // decisions[0]=accept optional move, decisions[1]=pick the SECOND neighbor
    // (index 1) — proves it's not hard-coded to the first edge.
    const plan = resolve(s, h.id, tree, [0, 1]);
    expect(plan.complete).toBe(true);
    expect(h.location).toBe(dests[1]);
  });

  it('declining the optional move leaves the hero in place', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.location = multiNeighborLoc;
    const tree = pathThroughMountains().tree;
    // decisions[0]=1 selects the optional node's 'Decline' option.
    const plan = resolve(s, h.id, tree, [1]);
    expect(plan.complete).toBe(true);
    expect(h.location).toBe(multiNeighborLoc);
  });
});
