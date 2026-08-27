// Monster innate combat powers (rulebook: each monster's special ability).
// In this engine the hero is ALWAYS the attacker and the monster ALWAYS the
// defender, so every monster power operates on the defender side. Powers split
// into three phases, mirroring the bout in combat.ts:
//   1. pre-resolve  — stat / cost / cancel modifiers that feed resolveBout
//   2. post-damage  — triggers keyed off the damage the monster dealt/prevented
//   3. end-of-round — regeneration
import type { Catalog, GameState, CombatCard, CombatType, CardId, Combatant } from './types';
import { nextInt, shuffle } from './rng';
import { gainCorruption } from './corruption';
import { log } from './log';
import { bestPlacementToward, placeInfluenceAction } from './influence';

type BattleType = CombatType | '';

/** +attack innate stat powers applied to the monster's revealed card
 *  (Precision, Crushing Strength). Returns a cloned card when it modifies. */
export function monsterAdjustCard(refId: string, card: CombatCard | null): CombatCard | null {
  if (!card) return card;
  if (refId === 'mon-snaga' && card.type === 'ranged') return { ...card, attack: card.attack + 1 };
  if (refId === 'mon-huorn' && card.type === 'melee') return { ...card, attack: card.attack + 1 };
  return card;
}

/** Innate strength-cost of the monster's revealed card (Superior Tactics,
 *  Surprise Assault). `isBottomOfStack` = the monster has played no card yet. */
export function monsterCardCost(refId: string, card: CombatCard, isBottomOfStack: boolean): number {
  let cost = card.strengthCost;
  if (refId === 'mon-southron' && card.type === 'melee') cost = Math.max(0, cost - 1);
  if (refId === 'mon-warg-rider' && isBottomOfStack && card.type === 'melee') cost = 0;
  return cost;
}

/** Roar (Cave Troll): a Ranged monster card cancels the hero's Melee card. */
export function monsterCancelsHeroCard(
  refId: string, defenderCard: CombatCard | null, attackerCard: CombatCard | null,
): boolean {
  return refId === 'mon-cave-troll' && defenderCard?.type === 'ranged' && attackerCard?.type === 'melee';
}

export interface PostBoutCtx {
  refId: string;
  attackerType: BattleType;   // hero's played type this round ('' if none/canceled)
  defenderType: BattleType;   // monster's played type this round
  dmgToHero: number;          // damage the monster dealt the hero this round
  prevented: number;          // damage the monster's defense absorbed this round
  monsterMaxLife: number;
}

export interface PostBoutResult {
  /** hero damage after redirections (Crebain Spy converts ranged damage to influence). */
  dmgToHero: number;
  /** at least this many of the hero's damage must come from his hand (Oliphaunt). */
  fromHand: number;
  /** heal the monster this many at end of round (Barrow-wight Regenerate). */
  heal: number;
  /** the hero must play a random card next round (Balrog Fear). */
  forceHeroRandom: boolean;
}

function drawMonster(s: GameState, c: Combatant, n: number): void {
  for (let i = 0; i < n; i++) {
    if (c.deck.length === 0) {
      if (c.discard.length === 0) return;
      c.deck.push(...shuffle(s, c.discard));
      c.discard.length = 0;
    }
    c.hand.push(c.deck.shift()!);
  }
}

function discardHeroRandom(s: GameState, hero: Combatant): CardId | null {
  if (!hero.hand.length) return null;
  const i = nextInt(s, hero.hand.length);
  const id = hero.hand.splice(i, 1)[0];
  hero.discard.push(id);
  return id;
}

/** Apply the monster's post-damage combat power. Mutates state (draws, hero
 *  discards, corruption, influence, extra damage) and returns the adjusted
 *  damage plan for combat.ts to finish applying. */
export function applyMonsterPostBout(
  s: GameState, cat: Catalog, ctx: PostBoutCtx,
): PostBoutResult {
  const pc = s.pendingCombat!;
  const res: PostBoutResult = { dmgToHero: ctx.dmgToHero, fromHand: 0, heal: 0, forceHeroRandom: false };
  const heroCombatant = pc.attacker;
  const heroState = s.heroes.find((h) => h.id === heroCombatant.refId);
  const dealtMelee = ctx.defenderType === 'melee' && ctx.dmgToHero >= 1;
  const dealtRanged = ctx.defenderType === 'ranged' && ctx.dmgToHero >= 1;
  const once = (pc.monsterOncePerBattle ||= {});

  switch (ctx.refId) {
    case 'mon-crebain': {
      // Spy: each point of Ranged damage becomes 1 influence in extension of a
      // Shadow Stronghold (toward the combat location) instead of hurting the hero.
      if (dealtRanged) {
        let placed = 0;
        for (let i = 0; i < ctx.dmgToHero; i++) {
          const loc = bestPlacementToward(s, cat, pc.locationId);
          if (!loc || placeInfluenceAction(s, cat, loc, 1) <= 0) break;
          placed++;
        }
        res.dmgToHero = 0;
        if (placed) log(s, 'monster-ability', 'Sauron', `Crebain Spy: ${placed} damage becomes influence (no damage to hero)`);
      }
      break;
    }
    case 'mon-agent': {
      // Spread Lies: once per battle, after dealing Ranged damage, hero +1 corruption.
      if (dealtRanged && !once.spreadLies && heroState) {
        gainCorruption(s, cat, heroState.id, 1);
        once.spreadLies = true;
        log(s, 'monster-ability', heroState.id, 'Agent Spread Lies: hero gains 1 corruption');
      }
      break;
    }
    case 'mon-orc': {
      // Fanatical: if both play Melee, deal the hero 1 extra damage.
      if (ctx.attackerType === 'melee' && ctx.defenderType === 'melee') {
        res.dmgToHero += 1;
        log(s, 'monster-ability', heroCombatant.refId, 'Orc Fanatical: +1 damage (both played Melee)');
      }
      break;
    }
    case 'mon-dunlending': {
      // Counter-attack: preventing >=1 damage with a Melee card deals the hero 1.
      if (ctx.defenderType === 'melee' && ctx.prevented >= 1) {
        res.dmgToHero += 1;
        log(s, 'monster-ability', heroCombatant.refId, 'Dunlending Counter-attack: +1 damage');
      }
      break;
    }
    case 'mon-uruk-hai': {
      // Bloodfury: on dealing Melee damage, the monster draws a combat card.
      if (dealtMelee) { drawMonster(s, pc.defender, 1); log(s, 'monster-ability', 'Sauron', 'Uruk-hai Bloodfury: draws a combat card'); }
      break;
    }
    case 'mon-giant-spider': {
      // Paralyzing Venom: dealing >=2 Melee damage forces a random hand discard.
      if (ctx.defenderType === 'melee' && ctx.dmgToHero >= 2) {
        const lost = discardHeroRandom(s, heroCombatant);
        if (lost) log(s, 'monster-ability', heroCombatant.refId, 'Giant Spider Paralyzing Venom: hero randomly discards a card');
      }
      break;
    }
    case 'mon-oliphaunt': {
      // Stampede: on dealing Melee damage, at least 1 damage comes from the hand.
      if (dealtMelee) res.fromHand = 1;
      break;
    }
    case 'mon-balrog': {
      // Fear: dealing >=3 Melee damage forces the hero to play a random card next round.
      if (ctx.defenderType === 'melee' && ctx.dmgToHero >= 3) {
        res.forceHeroRandom = true;
        log(s, 'monster-ability', heroCombatant.refId, 'Balrog Fear: hero must play a random card next round');
      }
      break;
    }
    case 'mon-barrow-wight': {
      // Regenerate: end of round, if it survived and played Ranged, heal 1.
      if (ctx.defenderType === 'ranged' && pc.defender.life > 0) {
        res.heal = Math.min(1, ctx.monsterMaxLife - pc.defender.life);
      }
      break;
    }
    default: break;
  }
  return res;
}
