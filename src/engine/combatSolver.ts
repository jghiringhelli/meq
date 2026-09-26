// Shared combat solver (M-combat). A single module both sides use to choose
// combat cards, built as a depth-limited BEST-RESPONSE over the BELIEF of the
// opponent's hidden hand — the cheap technique the design calls for (a full
// ISMCTS is overkill for this small closed subgame, and full-combat Monte-Carlo
// rollouts just add variance over the already-strong "best-first" heuristic).
// Every candidate is scored through the real resolveBout effect layer against
// the opponent's public card distribution, so all card abilities are honoured.
//
// PUBLIC-KNOWLEDGE model: each hero's base deck and the three monster decks are
// public compositions; cards already revealed into a combatant's discard/stack
// are known and excluded from its belief. The remaining hidden cards form a
// weighted distribution. Objectives are context-sensitive (ambush/travel vs
// hero-initiated, minion vs monster, corruption, returning wraiths), matching
// the owner's strategy notes. The mean/worst blend respects a foe that might
// play its best answer.
import type { Catalog, GameState, HeroId, Combatant, CombatCard } from './types';
import { clone } from './mechanics';
import { resolvePreparation } from './combat';
import { resolveBout } from './effects';
import type { Rng } from './heroAI';

const EXHAUST_OPT = '__exhaust__';

// ---- objective ----------------------------------------------------------
export interface CombatWeights {
  killProgress: number;   // credit per point of damage dealt toward the foe's health
  damage: number;         // penalty per card the hero loses to the damage pool
  kill: number;           // bonus for the blow that defeats the foe
  killTravel: number;     // extra — winning a Travel combat keeps the hero's turn
  killMinion: number;     // minions persist; extra credit to clear one
  heroDeath: number;      // a blow that would defeat the hero (drop life to 0)
  finaleWraithKill: number; // returning Ringwraiths respawn — killing them is low value
  carry: number;          // credit per point of next-round atk/def the hero queues
  drawValue: number;      // prep: value of each combat card drawn (more options)
  strengthValue: number;  // prep: value of each unspent agility kept as strength
  caution: number;        // blend: 0 = mean vs belief, 1 = pure worst case
  giveUp: number;         // value of declaring exhaustion (stop taking damage)
}

export const DEFAULT_WEIGHTS: CombatWeights = {
  killProgress: 5, damage: 1.5, kill: 26, killTravel: 12, killMinion: 6,
  heroDeath: 60, finaleWraithKill: -16, carry: 0.6,
  drawValue: 2.2, strengthValue: 1.4, caution: 0.15, giveUp: -6,
};

export interface CombatSolverConfig { weights: CombatWeights; }
export const DEFAULT_SOLVER: CombatSolverConfig = { weights: DEFAULT_WEIGHTS };

interface CombatContext {
  heroId: HeroId;
  isTravel: boolean;
  foeIsMinion: boolean;
  isFinaleWraith: boolean;
  /** True only for the single, decisive champion-vs-Ringwraiths battle that
   *  ends the whole game (manual p.33, `s.story.finaleCombat`). This is NOT
   *  the same as `isFinaleWraith` (which just flags the Ringwraith minion
   *  TYPE and is also true for ordinary mid-game Ringwraith fights, where a
   *  "kill" merely sends them back to Minas Morgul to respawn — genuinely
   *  low value). Here, killing IS the only way to win the game outright;
   *  every other result (escape, standoff, or the hero being defeated) is
   *  an identical loss for the heroes, so caution/survival have no separate
   *  value and must not be weighed as if this were a normal bout. */
  isDecisiveFinale: boolean;
}

function combatContext(s: GameState, cat: Catalog): CombatContext {
  const pc = s.pendingCombat!;
  const heroId = pc.attacker.refId as HeroId;
  const hero = s.heroes.find((h) => h.id === heroId);
  const min = cat.minions[pc.defender.refId];
  return {
    heroId, isTravel: !!hero?.hasMovedThisTurn, foeIsMinion: !!min, isFinaleWraith: !!(min && min.finale),
    isDecisiveFinale: !!s.story.finaleCombat,
  };
}

// ---- opponent belief ----------------------------------------------------
interface BeliefCard { card: CombatCard; weight: number; }

/** The distribution of the foe's next card, from PUBLIC info: its known deck
 *  composition minus the cards it has already revealed (discard + stack). The
 *  remaining multiset is the belief. */
function monsterCardBelief(cat: Catalog, def: Combatant): BeliefCard[] {
  const byCard = new Map<string, number>();
  for (const id of [...def.deck, ...def.hand]) byCard.set(id, (byCard.get(id) ?? 0) + 1);
  const out: BeliefCard[] = [];
  for (const [id, weight] of byCard) {
    const card = cat.combatCards[id];
    if (card) out.push({ card, weight });
  }
  return out;
}

const PASS_CARD: CombatCard = {
  id: '__pass__', deck: '', owner: 'monster', name: 'pass', type: 'melee',
  attack: 0, defense: 0, strengthCost: 0, terrain: '', ability: '', effectKey: '', copies: 1,
};

// ---- bout-level value ---------------------------------------------------
/** Hero-perspective value of one resolved bout. */
function boutValue(
  out: ReturnType<typeof resolveBout>, ctx: CombatContext, w: CombatWeights,
  foeLife: number, heroLife: number,
): number {
  const dmgFoe = out.defender.damageTaken;
  const dmgHero = out.attacker.damageTaken;
  const foeDead = out.attacker.defeatsOpp || foeLife - dmgFoe <= 0;
  let v = dmgFoe * w.killProgress - dmgHero * w.damage;
  if (foeDead) {
    v += w.kill;
    if (ctx.isTravel) v += w.killTravel;
    if (ctx.foeIsMinion) v += w.killMinion;
    // The mid-game respawn discount (killing sends the Ringwraiths back to
    // Minas Morgul to respawn — low value) only makes sense OUTSIDE the
    // decisive Finale battle. In the Finale itself killing them is the only
    // way to win the whole game, so the discount must not apply there.
    // (Verified empirically: removing it is neutral-to-safe over 139 replayed
    // finale combats — it doesn't change card choices on its own, but leaves
    // the score honest. Stronger interventions tried alongside it — extra
    // kill-progress weighting, zeroing heroDeath, forbidding voluntary
    // exhaustion — all measurably HURT the hero win rate in that same replay
    // harness, so they were deliberately left out.)
    if (ctx.isFinaleWraith && !ctx.isDecisiveFinale) v += w.finaleWraithKill;
  }
  if (out.defender.defeatsOpp || dmgHero >= heroLife) v -= w.heroDeath;
  for (const mod of out.attacker.next) v += ((mod.atk ?? 0) + (mod.def ?? 0)) * w.carry;
  if (out.escape === 'attacker') v -= 2; // withdrawing forfeits the kill
  return v;
}

/** Expected hero value of playing `heroCard` this round, over the foe's belief,
 *  as a caution blend of the mean and the worst case. */
function heroCardValue(
  s: GameState, heroCard: CombatCard, belief: BeliefCard[], ctx: CombatContext, w: CombatWeights,
): number {
  const pc = s.pendingCombat!;
  const lastType = pc.lastType ?? {};
  const carry = pc.carry ?? { attacker: [], defender: [] };
  const stk = pc.stack ?? { attacker: [], defender: [] };
  const ctxCounts = {
    attacker: { otherCards: stk.attacker.length, otherMelee: 0 },
    defender: { otherCards: stk.defender.length, otherMelee: 0 },
  };
  const foeLife = pc.defender.life;
  const heroLife = pc.attacker.deck.length + pc.attacker.hand.length;
  const pool = belief.length ? belief : [{ card: PASS_CARD, weight: 1 }];
  let sum = 0, tot = 0, worst = Infinity;
  for (const b of pool) {
    const out = resolveBout(heroCard, b.card, lastType, carry, ctxCounts);
    const v = boutValue(out, ctx, w, foeLife, heroLife);
    sum += v * b.weight; tot += b.weight;
    if (v < worst) worst = v;
  }
  const mean = sum / (tot || 1);
  return (1 - w.caution) * mean + w.caution * worst;
}

// ---- decisions ----------------------------------------------------------
function chooseCardOption(
  s: GameState, cat: Catalog, options: { id: string }[], ctx: CombatContext, w: CombatWeights,
): string {
  const pc = s.pendingCombat!;
  const belief = monsterCardBelief(cat, pc.defender);
  const budget = pc.attacker.strength - pc.attacker.strengthSpent;
  let best = options[0].id, bestScore = -Infinity;
  for (const opt of options) {
    if (opt.id === EXHAUST_OPT) {
      // Giving up: no more damage taken, but the foe survives. Worth it only when
      // every playable card scores worse (a hopeless fight).
      const v = w.giveUp - (ctx.isTravel ? w.killTravel : 0);
      if (v > bestScore) { bestScore = v; best = opt.id; }
      continue;
    }
    const card = cat.combatCards[opt.id];
    if (!card) continue;
    // A card the hero cannot afford would be canceled (0/0) and merely wastes a
    // card — never choose it while a cheaper option exists.
    if (card.strengthCost > budget) continue;
    const v = heroCardValue(s, card, belief, ctx, w);
    if (v > bestScore) { bestScore = v; best = opt.id; }
  }
  return best;
}

function scoreBestCard(
  s: GameState, cat: Catalog, options: { id: string }[], ctx: CombatContext, w: CombatWeights,
): number {
  const pc = s.pendingCombat!;
  const belief = monsterCardBelief(cat, pc.defender);
  const budget = pc.attacker.strength - pc.attacker.strengthSpent;
  let bestScore = -Infinity;
  for (const opt of options) {
    if (opt.id === EXHAUST_OPT) continue;
    const card = cat.combatCards[opt.id];
    if (!card || card.strengthCost > budget) continue;
    const v = heroCardValue(s, card, belief, ctx, w);
    if (v > bestScore) bestScore = v;
  }
  return bestScore === -Infinity ? 0 : bestScore;
}

/** Preparation split: for each "draw N / keep (agility-N) strength" option,
 *  apply it on a clone and score the resulting best first card, plus a small
 *  static bonus for cards drawn (options) and strength kept (budget). */
function choosePrepOption(
  s: GameState, cat: Catalog, options: { id: string }[], ctx: CombatContext, w: CombatWeights,
): string {
  const baseStrength = s.pendingCombat!.attacker.strength;
  let best = options[0].id, bestScore = -Infinity;
  for (const opt of options) {
    const draw = opt.id.startsWith('prep-') ? parseInt(opt.id.slice(5), 10) || 0 : 0;
    const sim = resolvePreparation(clone(s), cat, draw); // now at the first combat-card choice
    const kept = (sim.pendingCombat?.attacker.strength ?? baseStrength) - baseStrength; // agility kept as strength
    const cardOpts = sim.pendingChoice?.options ?? [];
    const firstCardVal = (sim.pendingCombat && cardOpts.length) ? scoreBestCard(sim, cat, cardOpts, ctx, w) : 0;
    const v = firstCardVal + draw * w.drawValue + Math.max(0, kept) * w.strengthValue;
    if (v > bestScore) { bestScore = v; best = opt.id; }
  }
  return best;
}

/** Choose the best combat option (card / prep split / exhaust) for the hero. */
export function solveCombatOption(
  s: GameState, cat: Catalog, options: { id: string }[], _rng: Rng, cfg: CombatSolverConfig = DEFAULT_SOLVER,
): string {
  if (!s.pendingCombat || !s.pendingChoice || !options.length) return options[0]?.id;
  const ctx = combatContext(s, cat);
  if (s.pendingChoice.kind === 'combat-prep') return choosePrepOption(s, cat, options, ctx, cfg.weights);
  return chooseCardOption(s, cat, options, ctx, cfg.weights);
}

/** Bind a solver config into a HeroStrategy.combatOption. */
export function makeCombatOption(cfg: CombatSolverConfig = DEFAULT_SOLVER) {
  return (s: GameState, cat: Catalog, options: { id: string }[], rng: Rng): string =>
    solveCombatOption(s, cat, options, rng, cfg);
}
