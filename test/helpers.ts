// Shared fixtures for the Vitest engine suites. The catalog is immutable and
// loaded once; each test that mutates state builds its own fresh game via
// `freshGame()` so tests never leak into one another.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/game';
import type { Catalog, GameState, CombatCard, Plot } from '../src/engine/types';

export const cat: Catalog = loadCatalog();

export function freshGame(seed = 5): GameState {
  return newGame(cat, seed);
}

export const combatCards: CombatCard[] = Object.values(cat.combatCards);
export const encounters = Object.values(cat.encounters);
export const events = cat.events;
export const perils = Object.values(cat.perils);
export const plots: Plot[] = cat.plots;
export const shadowCards = Object.values(cat.shadow);
export const monsters = Object.values(cat.monsters);
export const minions = Object.values(cat.minions);
export const quests = Object.values(cat.quests);
export const heroMissions = Object.values(cat.heroMissions);
export const sauronMissions = Object.values(cat.sauronMissions);
export const heroes = Object.values(cat.heroes);

/** A label safe for a test name (no newlines, bounded length). */
export function label(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Structural validation of a compiled effect tree: no unmodeled `raw`
 *  remainder, no unknown node kinds, every `op` node carries an atom. Returns a
 *  list of human-readable problems (empty = well-formed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectTreeProblems(tree: any, name: string): string[] {
  const problems: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') { problems.push(`${name}: non-object node`); return; }
    switch (node.k) {
      case 'raw': problems.push(`${name}: raw remainder "${node.text}"`); break;
      case 'op': if (!node.atom || !node.atom.op) problems.push(`${name}: op node missing atom`); break;
      case 'seq': (node.steps ?? []).forEach(walk); break;
      case 'if': walk(node.then); if (node.else) walk(node.else); break;
      case 'optional': walk(node.eff); break;
      case 'choice': (node.options ?? []).forEach((o: { eff: unknown }) => walk(o.eff)); break;
      case 'shieldBlock': walk(node.reward); break;
      case 'none': break;
      default: problems.push(`${name}: unknown node kind '${node.k}'`);
    }
  };
  walk(tree);
  return problems;
}

