// M4: layered encounter-effect interpreter.
//
// Each encounter card compiles (in scripts/build-catalog.py) to an `EffTree`.
// Resolution is *replay-driven*: `planEncounter` walks the tree against the
// CURRENT (pre-resolution) game state, consuming the player's `decisions` in
// order at each choice/optional node. If it reaches a choice with no decision
// yet, it returns that prompt and stops (complete=false). Once every choice is
// decided the walk completes and returns a flat, ordered list of atomic ops,
// which `commitEncounter` applies. Conditions read live state, so evaluating
// them against the pre-resolution snapshot is correct (a card resolves against
// the board as it stands when drawn). This keeps resolution pure + serialisable
// (no stored continuations) and fully deterministic.

import type {
  Catalog, GameState, HeroId, EffTree, Atom, Cond, Metric, EffOption, LocationId,
} from './types';
import { STORY_FINALE } from './types';
import { placeCharacterUnique } from './characters';
import { clamp, grantTraining, raiseAttribute, clone, defeatHero, gameStage } from './mechanics';
import { dealHeroDamage, heroDefeated, healHero, healHeroBy, handIntoLife } from './heroLife';
import { log } from './log';
import { addCardInfluence, removeInfluenceAt, regionInfluenceTotal, influenceAt, isHaven } from './influence';
import { adjacentLocations } from './sauronPlay';
import { drawPlots, drawShadow } from './sauronmech';
import { placeFavorToken } from './economy';
import {
  gainCorruption as gainCorruptionCards,
  discardCorruption as discardCorruptionCards,
  discardAllCorruption as discardAllCorruptionCards,
  corruptionStatPenalty, grantFavor,
} from './corruption';

/** Reveal the facedown monster tokens at the given locations to the human hero
 *  player (Board shows the monster face). No-op for locations without tokens. */
export function revealMonsters(s: GameState, locs: LocationId[]): number {
  const set = new Set(s.map.revealedMonstersAt ?? []);
  let n = 0;
  for (const loc of locs) {
    const hasToken = (s.map.monstersAt[loc]?.length ?? 0) > 0 || (s.map.rumorsAt?.[loc] ?? 0) > 0;
    if (hasToken && !set.has(loc)) { set.add(loc); n++; }
  }
  s.map.revealedMonstersAt = [...set];
  return n;
}

// ---- metrics & conditions ----------------------------------------------

function heroRegion(s: GameState, cat: Catalog, heroId: HeroId): string {
  const h = s.heroes.find((x) => x.id === heroId);
  return h ? cat.locations[h.location]?.regionId ?? '' : '';
}

export function statValue(s: GameState, cat: Catalog, heroId: HeroId, stat: 'wisdom' | 'agility' | 'fortitude' | 'strength'): number {  const base = (cat.heroes[heroId] as any)?.[stat] ?? 0;
  const h = s.heroes.find((x) => x.id === heroId);
  const mods = (h?.combatMods ?? []).reduce((n, m) => n + (m.stat === stat ? m.n : 0), 0);
  const corr = h ? corruptionStatPenalty(cat, h, stat) : 0;
  return base + (h?.statBonus?.[stat] ?? 0) + mods + corr;
}

// Lightweight plot ranking used by the Sauron plot-manipulation atoms. Kept
// local (not imported from sauronmech) to avoid an import cycle; higher = more
// dangerous for the heroes, matching sauronmech's staticPlotValue ordering.
function plotValue(cat: Catalog, id: string): number {
  const p = cat.plots.find((x) => x.id === id);
  if (!p) return 0;
  return (p.advance ?? (p as any).track?.length ?? 1) * 10 + ((p as any).track?.length ?? 0);
}

export function evalMetric(s: GameState, cat: Catalog, heroId: HeroId, m: Metric): number {
  if ('num' in m) return m.num;
  if ('stat' in m) return statValue(s, cat, heroId, m.stat);
  const region = heroRegion(s, cat, heroId);
  const hero = s.heroes.find((x) => x.id === heroId);
  switch (m.count) {
    case 'monstersInRegion':
      return Object.entries(s.map.monstersAt).reduce((n, [loc, arr]) =>
        n + (cat.locations[loc]?.regionId === region ? arr.length : 0), 0);
    case 'influenceInRegion': return regionInfluenceTotal(s, cat, region);
    case 'shireControl': {
      // "at least 3 influence OR a minion in The Shire" collapsed into one metric:
      // a minion present forces the value past any threshold (>= 3).
      const minionInShire = (s.map.minionsAt?.['the-shire']?.length ?? 0) > 0;
      return influenceAt(s, 'the-shire') + (minionInShire ? 3 : 0);
    }
    case 'influenceShadowPool': return s.sauron.influence;
    case 'influenceHere': return influenceAt(s, hero?.location ?? '');
    case 'corruptionOnHero': return hero?.corruption ?? 0;
    case 'plotsInPlay': return (s.sauron.activePlots ?? []).length;
    case 'itemsOnHero': return hero?.items.length ?? 0;
    case 'handSize': return hero?.hand.length ?? 0;
    case 'favor': return hero?.favor ?? 0;
    case 'monstersTotal': return Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
    case 'minionsTotal': return Object.values(s.map.minionsAt ?? {}).reduce((n, a) => n + a.length, 0);
    case 'adjacentInfluencedLocations': {
      const adj = (cat.edges ?? []).reduce<string[]>((acc, e: any) => {
        if (e.a === hero?.location) acc.push(e.b);
        else if (e.b === hero?.location) acc.push(e.a);
        return acc;
      }, []);
      return adj.filter((loc) => influenceAt(s, loc) > 0).length;
    }
    default: return 0;
  }
}

export function evalCond(s: GameState, cat: Catalog, heroId: HeroId, c: Cond): boolean {
  if (c.cmp === 'always') return true;
  if (c.cmp === 'noCorruption') return (s.heroes.find((x) => x.id === heroId)?.corruption ?? 0) === 0;
  if (c.cmp === 'yellowClosest') {
    const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
    return st.yellow <= st.red && st.yellow <= st.black;
  }
  if (c.cmp === 'plotActive') {
    return (s.sauron.activePlots ?? []).some((p) => p.eventId === c.plot);
  }
  const l = evalMetric(s, cat, heroId, c.left);
  const r = evalMetric(s, cat, heroId, c.right);
  switch (c.cmp) {
    case 'ge': return l >= r;
    case 'gt': return l > r;
    case 'le': return l <= r;
    case 'lt': return l < r;
    case 'eq': return l === r;
    default: return false;
  }
}

// ---- affordability (for disabling illegal choice options) ---------------

function canAfford(s: GameState, _cat: Catalog, heroId: HeroId, cost?: Atom): boolean {
  if (!cost) return true;
  const h = s.heroes.find((x) => x.id === heroId);
  if (!h) return false;
  switch (cost.op) {
    case 'loseFavor': return h.favor >= cost.n;
    case 'discardHand': return h.hand.length >= cost.n;
    case 'discardItem': return h.items.length >= cost.n;
    default: return true;
  }
}

// ---- planning walk ------------------------------------------------------

export interface PlanPending { prompt: string; options: { label: string; enabled: boolean }[]; }
export interface PlanResult {
  complete: boolean;
  atoms: Atom[];
  pending?: PlanPending;
}

/** Walk `tree`, consuming `decisions` at each choice. Returns the flat op list
 *  when fully decided, or the next pending prompt. Pure (reads state only). */
export function planEncounter(
  s: GameState, cat: Catalog, heroId: HeroId, tree: EffTree, decisions: number[],
): PlanResult {
  const atoms: Atom[] = [];
  let cursor = 0;
  let pending: PlanPending | undefined;

  const optionsToChoice = (node: Extract<EffTree, { k: 'optional' }>): EffOption[] => ([
    { label: node.prompt, cost: node.cost, eff: node.eff },
    { label: 'Decline', eff: { k: 'none' } as EffTree },
  ]);

  function walk(node: EffTree): void {
    if (pending) return;
    switch (node.k) {
      case 'seq':
        for (const st of node.steps) { walk(st); if (pending) return; }
        return;
      case 'if':
        walk(evalCond(s, cat, heroId, node.cond) ? node.then : (node.else ?? { k: 'none' }));
        return;
      case 'op':
        atoms.push(node.atom);
        return;
      case 'raw':
      case 'none':
        return;
      case 'shieldBlock': {
        // Faithful partial damage reduction. The hero's hand cards each bear
        // shield icons equal to their combat DEFENSE. He may discard any number
        // of cards, one at a time, each reducing the incoming damage by that
        // card's shields. Three outcomes: discard nothing → full damage, no
        // reward; discard some but not enough → adjusted (residual) damage, no
        // reward; reduce the damage to 0 → no damage and the printed reward.
        const hero = s.heroes.find((x) => x.id === heroId)!;
        let dmg = node.damage;
        const simHand = [...hero.hand];
        for (;;) {
          if (dmg <= 0) break;
          // Distinct hand cards that would actually reduce damage (defense > 0),
          // in first-seen order; discarding a 0-shield card is never offered.
          const seen = new Set<string>();
          const discardable: { id: string; def: number; name: string }[] = [];
          for (const id of simHand) {
            const def = cat.combatCards[id]?.defense ?? 0;
            if (def > 0 && !seen.has(id)) {
              seen.add(id);
              discardable.push({ id, def, name: cat.combatCards[id]?.name ?? id });
            }
          }
          if (discardable.length === 0) break; // nothing left that can block
          const stopIndex = discardable.length;
          const idx = cursor++;
          const decision = decisions[idx];
          if (decision === undefined || decision < 0 || decision > stopIndex) {
            pending = {
              prompt: `Dealt ${node.damage} damage (${dmg} remaining). Discard a card to block by its shields — reduce it to 0 for the reward.`,
              options: [
                ...discardable.map((d) => ({ label: `Discard ${d.name} (−${d.def} damage)`, enabled: true })),
                { label: `Take the remaining ${dmg} damage`, enabled: true },
              ],
            };
            return;
          }
          if (decision === stopIndex) break; // hero stops discarding
          const chosen = discardable[decision];
          atoms.push({ op: 'discardCardId', id: chosen.id });
          dmg -= chosen.def;
          const k = simHand.indexOf(chosen.id);
          if (k >= 0) simHand.splice(k, 1);
        }
        if (dmg > 0) atoms.push({ op: 'damage', n: dmg });
        else walk(node.reward);
        return;
      }
      case 'optional':
      case 'choice': {
        const options = node.k === 'optional' ? optionsToChoice(node) : node.options;
        const idx = cursor++;
        const decision = decisions[idx];
        if (decision === undefined || decision < 0 || decision >= options.length) {
          pending = {
            prompt: node.k === 'optional' ? 'You may choose:' : node.prompt,
            options: options.map((o) => ({ label: o.label, enabled: canAfford(s, cat, heroId, o.cost) })),
          };
          return;
        }
        const chosen = options[decision];
        if (chosen.cost) atoms.push(chosen.cost);
        walk(chosen.eff);
        return;
      }
    }
  }

  walk(tree);
  return pending ? { complete: false, atoms, pending } : { complete: true, atoms };
}

// ---- application --------------------------------------------------------

function relocateHero(s: GameState, heroId: HeroId, to: string): void {
  const hero = s.heroes.find((h) => h.id === heroId);
  if (!hero) return;
  const arr = s.map.heroesAt[hero.location];
  if (arr) { const i = arr.indexOf(heroId); if (i >= 0) arr.splice(i, 1); }
  hero.location = to;
  (s.map.heroesAt[to] ||= []).push(heroId);
}

/** Resolve a location name (as printed on a card) to a location id, or null. */
function findLocation(cat: Catalog, name: string): string | null {
  const want = name.trim().toLowerCase();
  for (const [id, loc] of Object.entries(cat.locations)) {
    if (loc.name.toLowerCase() === want || id === want) return id;
  }
  return null;
}

function firstAdjacent(cat: Catalog, from: string): string | null {
  const e = cat.edges.find((x) => x.a === from || x.b === from);
  return e ? (e.a === from ? e.b : e.a) : null;
}

/** Resolve a monster name (as printed on a card) to a monster id, or null.
 *  Matches on substring so "a Cave Troll" → mon-cave-troll. */
function findMonsterByName(cat: Catalog, name: string): string | null {
  const want = name.trim().toLowerCase();
  let fallback: string | null = null;
  for (const [id, mon] of Object.entries(cat.monsters)) {
    const mn = mon.name.toLowerCase();
    if (mn === want || id === want) return id;
    if (want.includes(mn) || mn.includes(want)) fallback = id;
  }
  return fallback;
}

/** Resolve a region name (as printed on a card) to a region id, or null.
 *  Falls back to matching a location name and returning that location's region
 *  (so "The Shire"/"Edoras"/"Gothmog" resolve to their containing region). */
function findRegion(cat: Catalog, name: string): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  for (const loc of Object.values(cat.locations)) {
    const rid = (loc as any).regionId as string | undefined;
    if (rid && (rid.toLowerCase() === want || rid.toLowerCase().includes(want) || want.includes(rid.toLowerCase())))
      return rid;
  }
  for (const [id, loc] of Object.entries(cat.locations)) {
    const rid = (loc as any).regionId as string | undefined;
    const ln = loc.name.toLowerCase();
    if (rid && (ln === want || id === want || want.includes(ln) || ln.includes(want))) return rid;
  }
  return null;
}

/** Apply one atom to the hero / board. Mutates `s`. Returns a short log tag. */
export function applyAtom(s: GameState, cat: Catalog, heroId: HeroId, atom: Atom): string {
  const hero = s.heroes.find((x) => x.id === heroId)!;
  const region = heroRegion(s, cat, heroId);
  switch (atom.op) {
    case 'gainFavor': grantFavor(cat, hero, atom.n); return `+${atom.n} favor`;
    case 'loseFavor': { const n = atom.per === 'corruptionOnHero' ? atom.n * hero.corruption : atom.n; hero.favor = Math.max(0, hero.favor - n); return `-${n} favor`; }
    case 'gainCorruption': return gainCorruptionCards(s, cat, hero.id, atom.n);
    case 'discardCorruption': { const r = discardCorruptionCards(s, cat, hero.id, atom.n); return `-${r} corruption`; }
    case 'redeemGrace': {
      const k = Math.min(hero.favor, hero.corruption);
      if (k <= 0) return 'no favor/corruption to redeem';
      hero.favor -= k;
      const r = discardCorruptionCards(s, cat, hero.id, k);
      return `spent ${k} favor to discard ${r} corruption`;
    }
    case 'bankFavor': {
      const n = Math.min(hero.favor, atom.n);
      if (n <= 0) return 'no favor to bank';
      hero.favor -= n;
      hero.bankedFavor = (hero.bankedFavor ?? 0) + n;
      return `banked ${n} favor`;
    }
    case 'discardAllCorruption': { const r = discardAllCorruptionCards(s, cat, hero.id); return `-${r} corruption (all)`; }
    case 'addInfluence': { const n = atom.per === 'corruptionOnHero' ? atom.n * hero.corruption : atom.n; s.sauron.influence += n; return `+${n} shadow influence`; }
    case 'removeInfluence': s.sauron.influence = Math.max(0, s.sauron.influence - atom.n); return `-${atom.n} shadow influence`;
    case 'discardRegionInfluence': {
      // Heroes clearing influence: strip the hero's own location first, then
      // spread the remainder across other influenced locations in the region.
      let left = atom.n;
      left -= removeInfluenceAt(s, hero.location, left);
      if (left > 0) {
        for (const [loc, n] of Object.entries(s.sauron.locationInfluence ?? {})) {
          if (left <= 0) break;
          if (cat.locations[loc]?.regionId === region && n > 0) left -= removeInfluenceAt(s, loc, left);
        }
      }
      return `-${atom.n - left} region influence`;
    }
    case 'damage': {
      dealHeroDamage(hero, atom.n);
      if (heroDefeated(hero)) defeatHero(s, cat, hero);
      return `${atom.n} damage`;
    }
    case 'damagePer': {
      const per = hero.corruption;
      const dmg = atom.n * per;
      dealHeroDamage(hero, dmg);
      if (heroDefeated(hero)) defeatHero(s, cat, hero);
      return `${dmg} damage (${atom.n}×${per} corruption)`;
    }
    case 'heal': { healHero(s, hero); return 'healed (damage pool → life pool)'; }
    case 'healPer': {
      const n = statValue(s, cat, heroId, atom.per);
      const k = healHeroBy(s, hero, n);
      return `healed ${k} card(s) (${atom.per})`;
    }
    case 'training': grantTraining(s, cat, hero, atom.n); return `+${atom.n} training`;
    case 'gainItem': {
      // One of each Item title at a time (rulebook p.26): skip a duplicate.
      if (hero.items.includes(atom.item)) return `already holds ${atom.item}`;
      hero.items.push(atom.item);
      return `gain item ${atom.item}`;
    }
    case 'discardItem': { for (let i = 0; i < atom.n && hero.items.length; i++) hero.items.pop(); return `discard ${atom.n} item`; }
    case 'gainStat': {
      const stat = atom.stat === 'choice' ? 'wisdom' : atom.stat;
      const applied = raiseAttribute(hero, stat, atom.n);
      return applied > 0 ? `+${applied} ${stat} (level ${hero.levels?.[stat] ?? 0}/2)` : `${stat} already at max level`;
    }
    case 'moveAdjacent': { const to = firstAdjacent(cat, hero.location); if (to) relocateHero(s, heroId, to); return `move to ${to ?? '—'}`; }
    case 'moveToEncounter': { const id = findLocation(cat, atom.location); if (id) relocateHero(s, heroId, id); return `move to ${atom.location}`; }
    case 'placeCharacter': {
      if (atom.ifInPlay) {
        const key = String(atom.who).trim().toLowerCase();
        const inPlay = Object.values(s.map.charactersAt ?? {}).some((arr) => arr.includes(key));
        if (!inPlay) return `${atom.who} not in play`;
      }
      let loc = findLocation(cat, atom.location);
      if (!loc && /haven/i.test(String(atom.location ?? ''))) {
        loc = Object.values(cat.locations).find((l) => isHaven(cat, l.id))?.id ?? null;
      }
      if (!loc) return `place ${atom.who} (location "${atom.location}" unresolved)`;
      placeCharacterUnique(s, String(atom.who), loc);
      return `place ${atom.who} in ${cat.locations[loc]?.name ?? loc}`;
    }
    case 'explore': return `explore ${atom.location}`;
    case 'discardMonsterToken': {
      for (const [loc, arr] of Object.entries(s.map.monstersAt)) {
        if (cat.locations[loc]?.regionId === region && arr.length) { arr.splice(0, atom.n); break; }
      }
      return `discard ${atom.n} monster token`;
    }
    case 'forceSauronDiscard': {
      if (atom.pile === 'plot') {
        // Card text: "Sauron must choose 1 Plot card to discard from his hand."
        // Sauron discards in his own favour: the weakest plot (lowest advance).
        const hand = (s.sauron.plotHand ??= []);
        const disc = (s.sauron.plotDiscard ??= []);
        let done = 0;
        for (; done < atom.n && hand.length; done++) {
          const weakest = [...hand].sort((a, b) =>
            ((cat.plots.find((p) => p.id === a)?.advance ?? 1) - (cat.plots.find((p) => p.id === b)?.advance ?? 1)))[0];
          hand.splice(hand.indexOf(weakest), 1);
          disc.push(weakest);
        }
        return `Sauron discards ${done} Plot card(s)`;
      }
      // Force Sauron to discard random Shadow card(s) from his modelled hand.
      let done = 0;
      while (done < atom.n && s.sauron.shadowHand.length) {
        const len = s.sauron.shadowHand.length;
        const idx = (((s.rngCursor + done) % len) + len) % len;
        s.sauron.shadowDiscard.push(s.sauron.shadowHand.splice(idx, 1)[0]);
        done++;
      }
      return `Sauron discards ${done} Shadow card(s)`;
    }
    case 'advanceStory': s.story.sauronProgress += atom.n; return `Sauron advances ${atom.n}`;
    case 'endTurn': hero.actionsRemaining = 0; return 'turn ends';
    case 'reusable': return 'card returns to deck';
    case 'lookSauronHand': {
      const names = (s.sauron.plotHand ?? []).map((id) => cat.plots.find((p) => p.id === id)?.name ?? id);
      return names.length
        ? `look at Sauron's plots: ${names.join(', ')}`
        : "look at Sauron's plots (hand empty)";
    }
    case 'sauronDrawPlot': { drawPlots(s, cat, 1); return 'Sauron draws a plot'; }
    case 'sauronDrawShadow': { for (let i = 0; i < atom.n; i++) drawShadow(s, cat, s.sauron.shadowHand.length + 1); return `Sauron draws ${atom.n} Shadow card(s)`; }
    case 'drawPer': {
      const n = statValue(s, cat, hero.id, 'fortitude');
      const drawn = hero.deck.splice(0, n);
      hero.hand.push(...drawn);
      return `draw ${drawn.length} card(s)`;
    }
    case 'examineTokens': {
      const targets = [hero.location, ...adjacentLocations(cat, hero.location)];
      const n = revealMonsters(s, targets);
      return n ? `examine ${n} monster token(s)` : 'examine monster tokens (none adjacent)';
    }
    case 'discardHand': {
      // Faithful to the printed cards: a base count (`n`), optionally first
      // discarding DOWN TO a hand size (`toHand`, e.g. Storms of Mordor → 5),
      // and optionally 1 per Corruption card on the hero (`perCorruption`, e.g.
      // An Evil Fog / the Storms follow-up). All additive, clamped to the hand.
      let want = atom.n ?? 0;
      if (atom.toHand !== undefined) want += Math.max(0, hero.hand.length - atom.toHand);
      if (atom.perCorruption) want += hero.corruptionCards.length;
      const n = Math.min(want, hero.hand.length);
      const moved = hero.hand.splice(0, n);
      hero.discard.push(...moved);
      return `discard ${n} card(s)`;
    }
    case 'discardCardId': {
      // Discard one named card (chosen during shield-block) from hand.
      const i = hero.hand.indexOf(atom.id);
      if (i >= 0) hero.discard.push(hero.hand.splice(i, 1)[0]);
      return `discard ${cat.combatCards[atom.id]?.name ?? atom.id}`;
    }
    case 'forceCombat': {
      const mid = findMonsterByName(cat, atom.monster);
      if (!mid) return '';
      (s.map.monstersAt[hero.location] ||= []).push(mid);
      return `must combat ${cat.monsters[mid].name}`;
    }
    case 'combatReward': {
      (s.map.pendingCombatRewards ||= []).push({ location: hero.location, favor: atom.favor, training: atom.training });
      const bits = [atom.favor ? `${atom.favor} favor` : '', atom.training ? `${atom.training} training` : ''].filter(Boolean);
      return `reward on defeating the foe: ${bits.join(' + ')}`;
    }
    case 'spawnMonster': {
      const ids = Object.keys(cat.monsters);
      if (!ids.length) return '';
      let placed = 0;
      for (let i = 0; i < atom.n; i++) {
        const idx = (((s.rngCursor + i) % ids.length) + ids.length) % ids.length;
        (s.map.monstersAt[hero.location] ||= []).push(ids[idx]);
        placed++;
      }
      return `place ${placed} monster token(s)`;
    }
    case 'placeInfluence': {
      if (atom.where === 'shadowPool') { s.sauron.influence += atom.n; return `+${atom.n} shadow influence`; }
      if (atom.where === 'location') {
        const loc = (atom.location && cat.locations[atom.location]) ? atom.location : hero.location;
        const placed = addCardInfluence(s, cat, loc, atom.n);
        return placed > 0 ? `+${placed} influence on ${cat.locations[loc]?.name ?? loc}` : '';
      }
      const rgn = atom.where === 'mordor' ? findRegion(cat, 'mordor')
        : atom.where === 'shire' ? findRegion(cat, 'shire')
        : region;
      if (!rgn) return '';
      const eligible = Object.values(cat.locations).filter((l) => l.regionId === rgn && !isHaven(cat, l.id));
      // "in each location of <region>": place n on every eligible location.
      if (atom.each) {
        let cnt = 0;
        for (const l of eligible) if (addCardInfluence(s, cat, l.id, atom.n) > 0) cnt++;
        return cnt > 0 ? `+${atom.n} influence on ${cnt} location(s)` : '';
      }
      // "on any <spread> locations": spread n across that many distinct locations,
      // preferring the hero's own location, then strongholds, then the rest.
      if (atom.spread && atom.spread > 1) {
        const ordered = [
          ...eligible.filter((l) => l.id === hero.location),
          ...eligible.filter((l) => l.id !== hero.location && l.kind === 'stronghold'),
          ...eligible.filter((l) => l.id !== hero.location && l.kind !== 'stronghold'),
        ];
        let cnt = 0;
        for (const l of ordered.slice(0, atom.spread)) if (addCardInfluence(s, cat, l.id, atom.n) > 0) cnt++;
        return cnt > 0 ? `+${atom.n} influence on ${cnt} location(s)` : '';
      }
      // Single target: prefer the hero's own location, then a Shadow Stronghold,
      // then any non-haven location of that region.
      let loc: string | undefined;
      if (cat.locations[hero.location]?.regionId === rgn && !isHaven(cat, hero.location)) loc = hero.location;
      else loc = Object.values(cat.locations).find((l) => l.regionId === rgn && l.kind === 'stronghold')?.id
        ?? Object.values(cat.locations).find((l) => l.regionId === rgn && l.kind !== 'haven')?.id;
      if (!loc) return '';
      const placed = addCardInfluence(s, cat, loc, atom.n);
      return placed > 0 ? `+${placed} influence on ${cat.locations[loc]?.name ?? loc}` : '';
    }
    case 'advanceMarker': {
      // Cards name a SPECIFIC marker and a whole number of spaces. The track is a
      // direct integer sum that feeds dominance (dominantSide) and the Finale
      // trigger — so we advance the named marker directly, no abstraction.
      if (atom.marker === 'green') {
        // Hero (green) clock toward the Finale (== story length). n may be
        // negative when a shadow card slows the heroes.
        s.story.sauronProgress = clamp(s.story.sauronProgress + atom.n, 0, s.story.length);
        return `${atom.n >= 0 ? '+' : ''}${atom.n} green marker`;
      }
      const st = (s.story.sauron ||= { yellow: 0, red: 0, black: 0 });
      st[atom.marker] = clamp(st[atom.marker] + atom.n, 0, STORY_FINALE);
      return `${atom.n >= 0 ? '+' : ''}${atom.n} ${atom.marker} marker`;
    }
    case 'combatStatMod': {
      const per = atom.per === 'corruptionOnHero' ? hero.corruption : 1;
      const amount = atom.n * per;
      if (amount === 0) return '';
      (hero.combatMods ||= []).push({ stat: atom.stat, n: amount });
      return `${amount >= 0 ? '+' : ''}${amount} ${atom.stat} (combat)`;
    }
    case 'restrictMovement': { hero.moveRestriction = atom.n; return `movement capped to ${atom.n}`; }
    case 'forcePeril': {
      // Treat the hero's location as perilous now: ensure it holds influence.
      if (influenceAt(s, hero.location) < 1) addCardInfluence(s, cat, hero.location, 1);
      return 'location treated as perilous';
    }
    case 'redistributeCorruption': {
      // "Redistribute Corruption cards between two heroes" (net-zero total): the
      // Eye concentrates harm by moving one held Corruption card from another
      // active hero onto this one. The card's actual +1 comes from the seq's
      // second step (gainCorruption). No donor in a solo game -> no-op.
      const donor = s.heroes.find((o) => o.id !== hero.id && o.status === 'active' && (o.corruptionCards?.length ?? 0) > 0);
      if (!donor) return 'no corruption to redistribute';
      const id = donor.corruptionCards.shift()!;
      donor.corruption = Math.max(0, (donor.corruption ?? 0) - 1);
      (hero.corruptionCards ||= []).push(id);
      hero.corruption = (hero.corruption ?? 0) + 1;
      return `redistributes 1 Corruption from ${donor.id}`;
    }
    case 'skipAmbush': { hero.skipAmbush = true; return 'ambush avoided this turn'; }
    case 'moveAnywhere': { return 'hero may move to any location'; }
    case 'sauronMoveCharacter': {
      const dest = findLocation(cat, atom.location);
      if (!dest) return '';
      // Sauron chooses which Character to banish: prefer one sharing an active
      // hero's location (most disruptive to remove), else any on the board.
      const map = s.map.charactersAt ?? {};
      const onBoard: { name: string; loc: string }[] = [];
      for (const [loc, arr] of Object.entries(map)) for (const name of arr) onBoard.push({ name, loc });
      if (!onBoard.length) return '';
      const heroLocs = new Set(s.heroes.filter((h) => h.status === 'active').map((h) => h.location));
      const pick = onBoard.find((c) => heroLocs.has(c.loc) && c.loc !== dest) ?? onBoard[0];
      placeCharacterUnique(s, pick.name, dest);
      return `Sauron moves ${pick.name} to ${cat.locations[dest]?.name ?? dest}`;
    }
    case 'clearMonstersAt': {
      const loc = findLocation(cat, atom.location);
      if (!loc) return '';
      const had = s.map.monstersAt[loc]?.length ?? 0;
      if (had) s.map.monstersAt[loc] = [];
      return had ? `removed ${had} monster token(s) from ${cat.locations[loc]?.name ?? loc}` : '';
    }
    case 'clearAdjacent': {
      const scope = [hero.location, ...adjacentLocations(cat, hero.location)];
      let inf = 0, mon = 0;
      for (const loc of scope) {
        inf += removeInfluenceAt(s, loc, Number.MAX_SAFE_INTEGER);
        const had = s.map.monstersAt[loc]?.length ?? 0;
        if (had) { s.map.monstersAt[loc] = []; mon += had; }
      }
      return `cleared ${inf} influence, ${mon} monster token(s) within 1 space`;
    }
    case 'handToLife': {
      const moved = handIntoLife(s, hero);
      return `shuffled ${moved} hand card(s) into life pool`;
    }
    case 'placeFavorToken': {
      const loc = findLocation(cat, atom.location);
      if (!loc) return '';
      placeFavorToken(s, loc, atom.n);
      return `+${atom.n} favor token on ${cat.locations[loc]?.name ?? loc}`;
    }
    case 'removeCharacter': {
      const rgn = findRegion(cat, atom.region) ?? atom.region;
      for (const [loc, arr] of Object.entries(s.map.charactersAt ?? {})) {
        if (cat.locations[loc]?.regionId === rgn && arr.length) {
          const who = arr.shift();
          if (!arr.length) delete s.map.charactersAt![loc];
          return `removed character ${who} from ${cat.locations[loc]?.name ?? loc}`;
        }
      }
      return 'no character to remove';
    }
    case 'damageMinion': {
      const rgn = findRegion(cat, atom.region) ?? atom.region;
      for (const [loc, arr] of Object.entries(s.map.minionsAt ?? {})) {
        if (cat.locations[loc]?.regionId !== rgn || !arr.length) continue;
        const mid = arr[0];
        const max = cat.minions[mid]?.health ?? 1;
        const cur = (s.map.minionHealth ||= {})[mid] ?? max;
        const nh = cur - atom.n;
        if (nh <= 0) {
          arr.shift();
          if (!arr.length) delete s.map.minionsAt![loc];
          delete s.map.minionHealth[mid];
          return `destroyed minion ${cat.minions[mid]?.name ?? mid}`;
        }
        s.map.minionHealth[mid] = nh;
        return `dealt ${atom.n} damage to ${cat.minions[mid]?.name ?? mid}`;
      }
      return 'no minion to damage';
    }
    case 'counterPlot': {
      const active = s.sauron.activePlots ?? [];
      if (!active.length) return 'no active plot to counter';
      const affectsHaven = (m: { location?: string }) => !!m.location && isHaven(cat, m.location as LocationId);
      const pool = atom.scope === 'haven' ? active.filter(affectsHaven) : active;
      const from = pool.length ? pool : active;
      const target = [...from].sort((a, b) => plotValue(cat, b.eventId) - plotValue(cat, a.eventId))[0];
      s.sauron.activePlots = active.filter((e) => e !== target);
      return `countered plot ${cat.plots.find((p) => p.id === target.eventId)?.name ?? target.eventId}`;
    }
    case 'reviveRelocateMinion': {
      // "They Are Terrible" (Sauron Shadow, pool 8): choose a minion on the
      // board OR one that has been defeated, remove ALL its damage tokens, and
      // place it on any location that contains influence. Sauron resolves it
      // optimally: bring back the strongest available minion onto its most
      // influenced location. No legal target (no influenced location or no
      // activated minion) → the card fizzles.
      const dest = Object.entries(s.sauron.locationInfluence ?? {})
        .filter(([, n]) => (n ?? 0) > 0)
        .sort((a, b) => b[1] - a[1])[0]?.[0] as LocationId | undefined;
      if (!dest) return '';
      const onBoard = new Map<string, LocationId>();
      for (const [loc, ids] of Object.entries(s.map.minionsAt ?? {}))
        for (const id of ids) onBoard.set(id, loc as LocationId);
      const stage = gameStage(s);
      const activated = Object.values(cat.minions).filter((m) => (m.stage ?? 1) <= stage);
      if (!activated.length) return '';
      const isRevivable = (m: { id: string; health: number }) =>
        !onBoard.has(m.id) || (s.map.minionHealth?.[m.id] ?? m.health) < m.health;
      const useful = activated.filter(isRevivable);
      const pick = (useful.length ? useful : activated).sort((a, b) => {
        const offA = onBoard.has(a.id) ? 0 : 1, offB = onBoard.has(b.id) ? 0 : 1;
        if (offA !== offB) return offB - offA; // prefer a defeated (off-board) minion
        return b.health - a.health;            // then the toughest
      })[0];
      const from = onBoard.get(pick.id);
      if (from) {
        const arr = s.map.minionsAt![from];
        const i = arr.indexOf(pick.id);
        if (i >= 0) arr.splice(i, 1);
      }
      (s.map.minionsAt ||= {});
      (s.map.minionsAt[dest] ||= []).push(pick.id);
      (s.map.minionHealth ||= {})[pick.id] = pick.health; // remove all damage tokens
      if (s.map.minionReturnPending?.length)
        s.map.minionReturnPending = s.map.minionReturnPending.filter((id) => id !== pick.id);
      return `${pick.name} healed and redeployed to ${cat.locations[dest]?.name ?? dest}`;
    }
    case 'plotPeekReorder': {
      // "Look at the top card of the Plot deck and return it to the top or the
      // bottom." Sauron keeps a strong plot on top (drawn next), else buries a
      // weak one so a better card can surface.
      const deck = s.sauron.plotDeck ?? [];
      if (deck.length < 2) return '';
      const val = (id: string) => plotValue(cat, id);
      const avg = deck.reduce((n, id) => n + val(id), 0) / deck.length;
      if (val(deck[0]) < avg) { deck.push(deck.shift()!); return 'top plot sent to the bottom'; }
      return 'top plot kept on top';
    }
    case 'plotFromDiscard': {
      // "Choose a Plot card in the discard pile and place it in your hand."
      const disc = s.sauron.plotDiscard ?? [];
      if (!disc.length) return '';
      let bestI = 0;
      for (let i = 1; i < disc.length; i++) if (plotValue(cat, disc[i]) > plotValue(cat, disc[bestI])) bestI = i;
      const [id] = disc.splice(bestI, 1);
      (s.sauron.plotHand ||= []).push(id);
      return `retrieved ${cat.plots.find((p) => p.id === id)?.name ?? id} from the discard`;
    }
    case 'plotTutor': {
      // "Search the Plot deck or discard pile for <named plot> and place it in
      // your hand." First matching id present in the deck, then the discard.
      for (const want of atom.ids) {
        for (const zone of [s.sauron.plotDeck, s.sauron.plotDiscard]) {
          const i = zone?.indexOf(want) ?? -1;
          if (zone && i >= 0) {
            zone.splice(i, 1);
            (s.sauron.plotHand ||= []).push(want);
            return `tutored ${cat.plots.find((p) => p.id === want)?.name ?? want} into hand`;
          }
        }
      }
      return '';
    }
    default: return '';
  }
}

export function applyAtoms(s: GameState, cat: Catalog, heroId: HeroId, atoms: Atom[], source: string): void {
  const tags: string[] = [];
  for (const a of atoms) { const t = applyAtom(s, cat, heroId, a); if (t) tags.push(t); }
  if (tags.length) log(s, 'effect', heroId, `${source}: ${tags.join(', ')}`);
  else log(s, 'effect', heroId, `${source}: (no effect)`);
}

/** How well-off `heroId` is after a trial resolution (higher = better for the
 *  hero) — used to auto-pick the least-harmful option for AI-controlled heroes. */
function heroWellbeing(s: GameState, heroId: HeroId): number {
  const h = s.heroes.find((x) => x.id === heroId);
  if (!h) return 0;
  return h.life * 10 - h.corruption * 6 + h.favor * 2;
}

/** Resolve a whole effect `tree` against `heroId` with NO player interaction.
 *  `side` decides who controls the branches: `'hero'` greedily takes the option
 *  that leaves the hero best off (hero-explored cards); `'sauron'` takes the
 *  option that harms the hero most (peril/shadow — the Eye's own weapons).
 *  Applies the resulting atoms to `s`. */
export function autoResolveTree(
  s: GameState, cat: Catalog, heroId: HeroId, tree: EffTree, source: string,
  side: 'hero' | 'sauron' = 'hero',
): void {
  const decisions: number[] = [];
  for (let guard = 0; guard < 24; guard++) {
    const plan = planEncounter(s, cat, heroId, tree, decisions);
    if (plan.complete) { applyAtoms(s, cat, heroId, plan.atoms, source); return; }
    decisions.push(bestDecision(s, cat, heroId, tree, decisions, plan.pending!.options, side, source));
  }
  const plan = planEncounter(s, cat, heroId, tree, decisions);
  applyAtoms(s, cat, heroId, plan.atoms, source);
}

/** Pick the option a `side`-controlled AI actor would take at a decision node:
 *  the one that (via a trial resolution) leaves the hero best off for `'hero'`
 *  or worst off for `'sauron'`. Shared by the auto-resolver and the interactive
 *  resolver (which uses it for the decisions the AI owns). */
function bestDecision(
  s: GameState, cat: Catalog, heroId: HeroId, tree: EffTree, decisions: number[],
  opts: { label: string; enabled: boolean }[], side: 'hero' | 'sauron', source: string,
): number {
  const better = (a: number, b: number) => (side === 'hero' ? a > b : a < b);
  let best = -1, bestScore = 0;
  for (let i = 0; i < opts.length; i++) {
    if (!opts[i].enabled) continue;
    const trial = planEncounter(s, cat, heroId, tree, [...decisions, i]);
    const c = clone(s);
    applyAtoms(c, cat, heroId, trial.atoms, source);
    const score = heroWellbeing(c, heroId);
    if (best < 0 || better(score, bestScore)) { bestScore = score; best = i; }
  }
  return best >= 0 ? best : Math.max(0, opts.findIndex((o) => o.enabled));
}

/** Best option index for the CURRENT `s.pendingTree` decision, from the deciding
 *  actor's perspective — used by the AI drivers/rollouts to auto-resolve a tree
 *  decision that only paused because a simulation spoofs `humanSide`. */
export function bestTreeOption(s: GameState, cat: Catalog): number {
  const p = s.pendingTree;
  if (!p) return 0;
  return bestDecision(s, cat, p.heroId, p.tree, p.decisions, p.options, p.actor, p.source);
}

/** Kind of card whose internal decisions can be owned by a specific side. */
export type TreeSource = 'encounter' | 'event' | 'peril' | 'shadow';

// Cards whose PRINTED text hands the choice to the side that does not normally
// control that source (the only such exceptions in the current card data).
const TREE_HERO_OVERRIDE = new Set(['shadow-dark-promises', 'shadow-dark-promises-2']);
const TREE_SAURON_OVERRIDE = new Set(['peril-nine-for-mortal-men-doomed-to-die']);

/** Who makes the decisions printed on a card: Sauron on the cards he controls
 *  (Shadow), the affected hero otherwise (Encounter/Event/Peril) — honouring the
 *  two printed exceptions where a card hands the choice to the other side. */
export function treeActor(sourceKind: TreeSource, cardId: string): 'hero' | 'sauron' {
  if (TREE_HERO_OVERRIDE.has(cardId)) return 'hero';
  if (TREE_SAURON_OVERRIDE.has(cardId)) return 'sauron';
  return sourceKind === 'shadow' ? 'sauron' : 'hero';
}

/** Is the given decision `actor` currently a HUMAN player (who must be prompted)
 *  rather than an AI (which auto-picks)? Mirrors `sauronAuto` without importing
 *  it (avoids a module cycle): Sauron is human only when the human plays Sauron
 *  and reactions are not auto-resolved; heroes are human when the human plays
 *  the hero side. */
export function treeActorIsHuman(s: GameState, actor: 'hero' | 'sauron'): boolean {
  return actor === 'sauron'
    ? (s.humanSide === 'Sauron' && !s.sauronReactsAuto)
    : s.humanSide === 'Hero';
}

/** Context describing a card `tree` being resolved interactively. */
export interface TreeCtx {
  sourceKind: TreeSource;
  cardId: string;
  source: string;
  heroId: HeroId;
  actor: 'hero' | 'sauron';
  /** Combat-start shadow (e.g. Morgul-Blade) owes a `queuePreparation` once the
   *  internal decision completes — the caller resumes combat when this is set. */
  resumeCombat?: boolean;
}

/** Resolve a card `tree` interactively: auto-pick the decisions the AI owns and
 *  PAUSE (set `s.pendingTree`) at the first decision the human `actor` must make.
 *  Returns true if it paused (the caller must yield to the UI), false if it ran
 *  to completion and applied every atom. `decisions` seeds a resume. */
export function stepResolveTree(
  s: GameState, cat: Catalog, tree: EffTree, ctx: TreeCtx, decisions: number[] = [],
): boolean {
  const human = treeActorIsHuman(s, ctx.actor);
  let dec = decisions;
  for (let guard = 0; guard < 64; guard++) {
    const plan = planEncounter(s, cat, ctx.heroId, tree, dec);
    if (plan.complete) { applyAtoms(s, cat, ctx.heroId, plan.atoms, ctx.source); return false; }
    if (human) {
      s.pendingTree = {
        sourceKind: ctx.sourceKind, cardId: ctx.cardId, source: ctx.source,
        heroId: ctx.heroId, actor: ctx.actor, resumeCombat: ctx.resumeCombat,
        tree, decisions: dec, prompt: plan.pending!.prompt,
        options: plan.pending!.options.map((o) => ({ label: o.label, enabled: o.enabled })),
      };
      return true;
    }
    dec = [...dec, bestDecision(s, cat, ctx.heroId, tree, dec, plan.pending!.options, ctx.actor, ctx.source)];
  }
  const plan = planEncounter(s, cat, ctx.heroId, tree, dec);
  applyAtoms(s, cat, ctx.heroId, plan.atoms, ctx.source);
  return false;
}
