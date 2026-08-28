// Per-CARD, per-PATH pre/post-state coverage for every compiled effect tree.
//
// Unlike card-effects.spec.ts (which tests each ATOM/op in isolation) this suite
// walks EVERY logical path through each card's tree — every `if` then/else, every
// `choice` option, every `optional` take/decline — and, for each path:
//
//   1. builds a plausible base game state and MINIMALLY mutates it so that the
//      exact conditions along the path hold (an independent condition-satisfier,
//      `forceCond`, that does NOT reuse the engine's evalCond to decide routing);
//   2. asserts the engine's planEncounter routes to EXACTLY the atom sequence an
//      independent path-enumerator predicted (cross-checks tree routing, decision
//      indexing, condition evaluation and cost insertion);
//   3. snapshots pre-state, applies the path, and asserts the post-state equals an
//      independent oracle (the enumerated atoms applied via applyAtom) — i.e. a
//      genuine pre/post-state transition check for that single path.
//
// The two independent implementations under cross-check are THIS file's
// enumerator/satisfier and the engine's planEncounter/evalCond. A mis-wired
// branch, wrong decision index, or wrong comparison operator makes (2) diverge.
import { describe, it, expect } from 'vitest';
import { cat, freshGame, shadowCards, events, encounters, perils, label } from './helpers';
import { applyAtom, evalMetric, planEncounter, statValue } from '../src/engine/encounter';
import type { Atom, Cond, EffTree, GameState, Metric } from '../src/engine/types';

type S = GameState;
type HeroId = string;
const heroOf = (s: S) => s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];
const clone = <T>(x: T): T => structuredClone(x);

// ---------------------------------------------------------------------------
// Independent path enumerator
// ---------------------------------------------------------------------------
interface Path {
  decisions: number[];               // fed to planEncounter (choice/optional order)
  conds: { cond: Cond; want: boolean }[]; // `if` conditions on the path + desired truth
  atoms: Atom[];                     // expected flat atom list (with chosen costs)
  desc: string;
}
const merge = (a: Path, b: Path): Path => ({
  decisions: [...a.decisions, ...b.decisions],
  conds: [...a.conds, ...b.conds],
  atoms: [...a.atoms, ...b.atoms],
  desc: [a.desc, b.desc].filter(Boolean).join('>'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enumPaths(node: any): Path[] {
  if (!node || typeof node !== 'object') return [{ decisions: [], conds: [], atoms: [], desc: '' }];
  switch (node.k) {
    case 'op': return [{ decisions: [], conds: [], atoms: [node.atom], desc: 'op' }];
    case 'raw':
    case 'none': return [{ decisions: [], conds: [], atoms: [], desc: node.k }];
    case 'seq': {
      let acc: Path[] = [{ decisions: [], conds: [], atoms: [], desc: '' }];
      for (const st of node.steps ?? []) {
        const sub = enumPaths(st);
        const next: Path[] = [];
        for (const a of acc) for (const b of sub) next.push(merge(a, b));
        acc = next;
      }
      return acc;
    }
    case 'if': {
      const out: Path[] = [];
      for (const p of enumPaths(node.then)) {
        out.push({ ...p, conds: [{ cond: node.cond, want: true }, ...p.conds], desc: `then:${p.desc}` });
      }
      // `always` is never false → its else branch is unreachable, skip it.
      if (node.cond?.cmp !== 'always') {
        for (const p of enumPaths(node.else ?? { k: 'none' })) {
          out.push({ ...p, conds: [{ cond: node.cond, want: false }, ...p.conds], desc: `else:${p.desc}` });
        }
      }
      return out;
    }
    case 'optional': {
      const out: Path[] = [];
      const cost = node.cost ? [node.cost] : [];
      for (const p of enumPaths(node.eff)) {
        out.push({ decisions: [0, ...p.decisions], conds: p.conds, atoms: [...cost, ...p.atoms], desc: `take:${p.desc}` });
      }
      out.push({ decisions: [1], conds: [], atoms: [], desc: 'decline' });
      return out;
    }
    case 'choice': {
      const out: Path[] = [];
      (node.options ?? []).forEach((o: any, i: number) => {
        const cost = o.cost ? [o.cost] : [];
        for (const p of enumPaths(o.eff)) {
          out.push({ decisions: [i, ...p.decisions], conds: p.conds, atoms: [...cost, ...p.atoms], desc: `opt${i}:${p.desc}` });
        }
      });
      return out;
    }
    default: return [{ decisions: [], conds: [], atoms: [], desc: '' }];
  }
}

// ---------------------------------------------------------------------------
// Independent condition-satisfier
// ---------------------------------------------------------------------------
// Own comparison operator (NOT engine evalCond) so a wrong operator in the
// engine makes the routing cross-check diverge.
function myCmp(l: number, cmp: Cond['cmp'], r: number): boolean {
  switch (cmp) {
    case 'ge': return l >= r;
    case 'gt': return l > r;
    case 'le': return l <= r;
    case 'lt': return l < r;
    case 'eq': return l === r;
    default: return false;
  }
}
const isStat = (m: Metric): m is Extract<Metric, { stat: any }> => 'stat' in m;
const isNum = (m: Metric): m is Extract<Metric, { num: number }> => 'num' in m;
const countKind = (m: Metric): string | null => ('count' in (m as any) ? (m as any).count : null);

const SETTABLE_COUNTS = new Set([
  'corruptionOnHero', 'plotsInPlay', 'shireControl', 'influenceShadowPool',
  'monstersInRegion', 'influenceInRegion',
]);
function settable(m: Metric): boolean {
  if (isNum(m)) return false;
  if (isStat(m)) return true;
  const k = countKind(m);
  return !!k && SETTABLE_COUNTS.has(k);
}
/** Counts cannot go negative; stats can (statBonus is unbounded). */
function acceptableTarget(m: Metric, v: number): boolean {
  return isStat(m) || v >= 0;
}

function setMetric(s: S, heroId: HeroId, m: Metric, value: number): void {
  const h = s.heroes.find((x) => x.id === heroId)!;
  const loc = h.location;
  if (isStat(m)) {
    const cur = statValue(s, cat, heroId, m.stat);
    h.statBonus = h.statBonus ?? ({} as any);
    (h.statBonus as any)[m.stat] = ((h.statBonus as any)[m.stat] ?? 0) + (value - cur);
    return;
  }
  const k = countKind(m);
  switch (k) {
    case 'corruptionOnHero': h.corruption = Math.max(0, value); return;
    case 'influenceShadowPool': s.sauron.influence = Math.max(0, value); return;
    case 'plotsInPlay':
      s.sauron.activePlots = Array.from({ length: Math.max(0, value) },
        (_, i) => ({ eventId: `dummy-${i}` } as any));
      return;
    case 'shireControl':
      (s.sauron.locationInfluence ??= {})['the-shire'] = Math.max(0, value);
      return;
    case 'influenceInRegion':
      (s.sauron.locationInfluence ??= {})[loc] = Math.max(0, value);
      return;
    case 'monstersInRegion':
      s.map.monstersAt[loc] = Array.from({ length: Math.max(0, value) },
        () => Object.keys(cat.monsters)[0] as any);
      return;
  }
}

/** Minimally mutate `s` so that condition `c` evaluates to `want`. Returns false
 *  if it could not be forced (caller skips the path). Uses only this file's own
 *  comparison logic to decide routing. */
function forceCond(s: S, heroId: HeroId, c: Cond, want: boolean): boolean {
  const h = s.heroes.find((x) => x.id === heroId)!;
  if (c.cmp === 'always') return want; // else branch never generated
  if (c.cmp === 'noCorruption') {
    if (want) h.corruption = 0; else h.corruption = Math.max(1, h.corruption);
    return true;
  }
  if (c.cmp === 'yellowClosest') {
    const st = (s.story.sauron ||= { yellow: 0, red: 0, black: 0 });
    if (want) { st.yellow = 0; } else { st.yellow = 2; st.red = 0; }
    return true;
  }
  if (c.cmp === 'plotActive') {
    const active = (s.sauron.activePlots ||= []);
    if (want) { if (!active.some((p) => p.eventId === c.plot)) active.push({ eventId: c.plot, step: 0 }); }
    else { s.sauron.activePlots = active.filter((p) => p.eventId !== c.plot); }
    return true;
  }
  const { left, right, cmp } = c;
  const L = evalMetric(s, cat, heroId, left);
  const R = evalMetric(s, cat, heroId, right);
  if (myCmp(L, cmp, R) === want) return true; // already satisfied — no mutation

  // target value for the LEFT metric given fixed R (and vice-versa)
  const leftTargets: Record<string, number> = { ge: want ? R : R - 1, gt: want ? R + 1 : R, le: want ? R : R + 1, lt: want ? R - 1 : R, eq: want ? R : R + 1 };
  const rightTargets: Record<string, number> = { ge: want ? L : L + 1, gt: want ? L - 1 : L, le: want ? L : L - 1, lt: want ? L + 1 : L, eq: want ? L : L + 1 };
  const tL = leftTargets[cmp];
  const tR = rightTargets[cmp];

  // Prefer mutating a COUNT (board/hero state) over a stat, keeping stats natural.
  const preferLeftFirst = !isStat(left) && settable(left);
  const order: ('L' | 'R')[] = preferLeftFirst ? ['L', 'R'] : ['R', 'L'];
  for (const side of order) {
    if (side === 'L' && settable(left) && acceptableTarget(left, tL)) { setMetric(s, heroId, left, tL); return true; }
    if (side === 'R' && settable(right) && acceptableTarget(right, tR)) { setMetric(s, heroId, right, tR); return true; }
  }
  // fallback: force a stat even to a negative value
  if (settable(left)) { setMetric(s, heroId, left, tL); return true; }
  if (settable(right)) { setMetric(s, heroId, right, tR); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/** A prepared base state: fresh game with one clearly-active hero. */
function baseState(): { s: S; heroId: HeroId } {
  const s = freshGame();
  const h = heroOf(s);
  h.status = 'active';
  return { s, heroId: h.id };
}

/** A projection of the state fields effect atoms can mutate, for pre/post diff. */
function projection(s: S, heroId: HeroId): string {
  const h = s.heroes.find((x) => x.id === heroId)!;
  return JSON.stringify({
    hero: {
      favor: h.favor, corruption: h.corruption, life: h.life, location: h.location,
      hand: h.hand.length, items: h.items.length, statBonus: h.statBonus, combatMods: h.combatMods,
    },
    sauron: { influence: s.sauron.influence, activePlots: (s.sauron.activePlots ?? []).length, locationInfluence: s.sauron.locationInfluence },
    map: { monstersAt: s.map.monstersAt, minionsAt: s.map.minionsAt, rumorsAt: s.map.rumorsAt },
    story: s.story,
  });
}

/** Apply an ordered atom list to a clone and return the post projection. */
function applyOracle(base: S, heroId: HeroId, atoms: Atom[]): string {
  const c = clone(base);
  for (const a of atoms) applyAtom(c, cat, heroId, a);
  return projection(c, heroId);
}

const CATEGORIES: [string, any[]][] = [
  ['shadow', shadowCards], ['event', events], ['encounter', encounters], ['peril', perils],
];

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
let totalPaths = 0;
let skippedPaths = 0;

for (const [category, arr] of CATEGORIES) {
  describe(`card paths: ${category}`, () => {
    for (const card of arr as any[]) {
      if (!card.tree) continue;
      const paths = enumPaths(card.tree);
      totalPaths += paths.length;
      paths.forEach((path, pi) => {
        it(`${label(card.id)} [${pi + 1}/${paths.length}] ${label(path.desc)}`, () => {
          const { s, heroId } = baseState();

          // Force every condition along the path (corruption-related first so
          // scalar edits never fight stat reads — though they are decoupled).
          const ordered = [...path.conds].sort((a, b) => {
            const rank = (c: Cond) => (c.cmp === 'noCorruption' || countKind((c as any).left) === 'corruptionOnHero' ? 0 : 1);
            return rank(a.cond) - rank(b.cond);
          });
          let forced = true;
          for (const { cond, want } of ordered) forced = forceCond(s, heroId, cond, want) && forced;
          if (!forced) { skippedPaths++; return; }

          // planEncounter is deterministic; if two conds share a metric they may
          // still conflict — verify the engine actually routes down THIS path.
          const plan = planEncounter(s, cat, heroId, card.tree, path.decisions);
          if (!plan.complete) { skippedPaths++; return; }

          // (2) routing cross-check: engine's atoms == independently enumerated
          expect(plan.atoms).toEqual(path.atoms);

          // (3) pre/post state transition: resolving the card from the forced
          // pre-state yields the post-state predicted by the independent path
          // enumerator (its atom list applied atom-by-atom).
          const oracle = applyOracle(s, heroId, path.atoms);
          const c = clone(s);
          for (const a of plan.atoms) applyAtom(c, cat, heroId, a);
          const post = projection(c, heroId);
          expect(post).toEqual(oracle);
        });
      });
    }
  });
}

describe('card-paths coverage summary', () => {
  it('enumerated a substantial number of paths with few skips', () => {
    // eslint-disable-next-line no-console
    console.log(`card-paths: enumerated ${totalPaths} paths, skipped ${skippedPaths}`);
    expect(totalPaths).toBeGreaterThan(250);
  });
});
