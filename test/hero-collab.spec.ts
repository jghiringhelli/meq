import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { heuristic, applyHeroAction } from '../src/engine/heroAI';
import type { GameState } from '../src/engine/types';

/** Put two co-located, active heroes into HeroActions with a counterable plot
 *  sitting on their shared location. The active hero holds `cost - shortBy`
 *  favor; the ally holds `allyFavor`. Returns the state and the plot's cost. */
function pooledPlotGame(shortBy: number, allyFavor: number): { s: GameState; cost: number } {
  const s = freshGame();
  const plot = cat.plots.find((p) => (p.favorToCounter ?? 2) >= 2)!;
  const cost = plot.favorToCounter ?? 2;
  s.phase = 'HeroActions';
  s.activeHeroIndex = 0;
  const [active, ally] = s.heroes;
  active.status = 'active';
  ally.status = 'active';
  ally.location = active.location; // co-located → free trade is legal (rulebook p.24)
  active.actionsRemaining = 1;
  active.favor = Math.max(0, cost - shortBy);
  ally.favor = allyFavor;
  active.corruptionCards = [];
  ally.corruptionCards = [];
  s.map.monstersAt = {}; // no ambush/engage to distract the planner
  s.sauron.activePlots = [{ eventId: plot.id, location: active.location } as never];
  return { s, cost };
}

describe('hero AI collaboration — favor pooling to break plots (rulebook p.24)', () => {
  it('pulls the exact shortfall from a co-located ally when short on favor', () => {
    const { s } = pooledPlotGame(1, 3);
    const act = heuristic.heroAction(s, cat, s.heroes[0].id, () => 0.5);
    expect(act).toEqual({ kind: 'trade-favor', fromId: s.heroes[1].id, toId: s.heroes[0].id, n: 1 });
  });

  it('trade then counter: after pooling, the hero can break the plot', () => {
    const { s, cost } = pooledPlotGame(1, 3);
    const trade = heuristic.heroAction(s, cat, s.heroes[0].id, () => 0.5);
    const s2 = applyHeroAction(s, cat, s.heroes[0].id, trade);
    expect(s2.heroes[0].favor).toBe(cost);
    expect(s2.heroes[1].favor).toBe(3 - 1);
    const next = heuristic.heroAction(s2, cat, s2.heroes[0].id, () => 0.5);
    expect(next).toEqual({ kind: 'counter-plot' });
    const s3 = applyHeroAction(s2, cat, s2.heroes[0].id, next);
    expect(s3.sauron.activePlots ?? []).toHaveLength(0);
  });

  it('counters directly (no trade) when the active hero can already afford it', () => {
    const { s } = pooledPlotGame(0, 3);
    const act = heuristic.heroAction(s, cat, s.heroes[0].id, () => 0.5);
    expect(act).toEqual({ kind: 'counter-plot' });
  });

  it('does not trade when no ally is co-located', () => {
    const { s } = pooledPlotGame(1, 3);
    const other = Object.keys(cat.locations).find((l) => l !== s.heroes[0].location)!;
    s.heroes[1].location = other;
    const act = heuristic.heroAction(s, cat, s.heroes[0].id, () => 0.5);
    expect(act.kind).not.toBe('trade-favor');
  });

  it('does not trade from an ally who has no favor', () => {
    const { s } = pooledPlotGame(1, 0);
    const act = heuristic.heroAction(s, cat, s.heroes[0].id, () => 0.5);
    expect(act.kind).not.toBe('trade-favor');
  });
});
