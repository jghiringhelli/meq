// Non-combat effect application (M3). Encounter + event cards carry an `ops`
// list (parsed in scripts/build-catalog.py) of atomic operations. applyOps()
// applies them to a hero (favor / corruption / life) or globally (influence),
// clamped to legal ranges. Unparsed cards carry no ops and act as flavor.
import type { Catalog, GameState, HeroId, EffectOp } from './types';
import { defeatHero } from './mechanics';
import { dealHeroDamage, heroDefeated } from './heroLife';
import { gainCorruption, discardCorruption, grantFavor } from './corruption';
import { log } from './log';

/** Apply a list of card ops. `heroId` is the affected hero (for hero-scoped
 *  ops); global ops (influence) ignore it. Mutates `s` in place. */
export function applyOps(s: GameState, cat: Catalog, heroId: HeroId | null, ops: EffectOp[], source: string): void {
  const hero = heroId ? s.heroes.find((h) => h.id === heroId) ?? null : null;
  for (const op of ops) {
    switch (op.op) {
      case 'gainFavor': if (hero) grantFavor(cat, hero, op.n); break;
      case 'loseFavor': if (hero) hero.favor = Math.max(0, hero.favor - op.n); break;
      case 'gainCorruption': if (hero) gainCorruption(s, cat, hero.id, op.n); break;
      case 'removeCorruption': if (hero) discardCorruption(s, cat, hero.id, op.n); break;
      case 'damage':
        if (hero) {
          dealHeroDamage(hero, op.n);
          if (heroDefeated(hero)) defeatHero(s, cat, hero);
        }
        break;
      case 'addInfluence': s.sauron.influence += op.n; break;
      case 'removeInfluence': s.sauron.influence = Math.max(0, s.sauron.influence - op.n); break;
    }
  }
  if (ops.length) {
    const summary = ops.map((o) => `${o.op}${'n' in o ? ` ${o.n}` : ''}`).join(', ');
    log(s, 'effect', heroId ?? 'system', `${source}: ${summary}`);
  }
}
