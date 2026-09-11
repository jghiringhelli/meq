// Quest system (rulebook pp. 8, 22): each hero randomly draws one of two
// Starting Quests at setup, follows its "Setup", and completes its "task"
// during the Explore part of his Travel step to gain the reward and reveal his
// (previously locked) Advanced Quest. This module is data-driven off
// assets/quests.json — task detection, reward application, and the Defeat-quest
// encounter substitution ("combat a <Monster> instead of drawing Encounters").
import type { Catalog, GameState, HeroState, HeroId, LocationId, MonsterId, Quest } from './types';
import { placeCharacterUnique } from './characters';
import { log } from './log';
import { grantTraining, raiseAttribute } from './mechanics';
import { restHero } from './heroLife';
import { grantFavor } from './corruption';
import { nextInt } from './rng';

type Attr = 'fortitude' | 'strength' | 'agility' | 'wisdom';
const ATTRS: Attr[] = ['fortitude', 'strength', 'agility', 'wisdom'];

/** Normalise a name for tolerant matching: lowercase, strip diacritics, a
 *  leading article, and any non-alphanumeric characters. */
function norm(s: string): string {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}

/** Find a location id by (fuzzy) display name. */
export function locByName(cat: Catalog, name: string | undefined): LocationId | null {
  if (!name) return null;
  const t = norm(name);
  const locs = Object.values(cat.locations);
  let hit = locs.find((l) => norm(l.name) === t);
  if (!hit) hit = locs.find((l) => norm(l.name).includes(t) || t.includes(norm(l.name)));
  return hit ? hit.id : null;
}

/** Find a monster id by (fuzzy) name. */
function monsterByName(cat: Catalog, name: string | undefined): MonsterId | null {
  if (!name) return null;
  const t = norm(name);
  const hit = Object.values(cat.monsters).find((m) => norm(m.name) === t);
  return hit ? hit.id : null;
}

/** Find a minion id by (fuzzy) name (Defeat targets like the Black Serpent). */
function minionByName(cat: Catalog, name: string | undefined): string | null {
  if (!name) return null;
  const t = norm(name);
  const hit = Object.values(cat.minions).find((m) => norm(m.name) === t);
  return hit ? hit.id : null;
}

interface TaskSpec { exploreLocs: LocationId[]; defeatNames: string[] }

/** Parse a quest task into the locations that satisfy an "Explore" clause and
 *  the foe names that satisfy a "Defeat"/"combat" clause. Clauses are joined by
 *  " or " (e.g. "Explore Near Harad or combat the Black Serpent."). */
function parseTask(cat: Catalog, task: string): TaskSpec {
  const spec: TaskSpec = { exploreLocs: [], defeatNames: [] };
  for (const raw of (task || '').split(/\bor\b/i)) {
    const clause = raw.trim().replace(/[.,]+$/, '');
    let m = /^explore\s+(.+)$/i.exec(clause);
    if (m) { const loc = locByName(cat, m[1]); if (loc) spec.exploreLocs.push(loc); continue; }
    m = /^(?:defeat|combat)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i.exec(clause);
    if (m) spec.defeatNames.push(m[1].trim());
  }
  return spec;
}

/** The board location a Starting/Advanced Quest points the hero toward — used to
 *  place a green quest marker at setup so the player can see where to go. Prefers
 *  an Explore target; falls back to the Setup-placed character location (Defeat
 *  quests are resolved where their foe/character sits). */
export function questTargetLocation(cat: Catalog, quest: Quest, placedLoc: LocationId | null): LocationId | null {
  const spec = parseTask(cat, quest.task || '');
  if (spec.exploreLocs.length) return spec.exploreLocs[0];
  if (placedLoc) return placedLoc;
  const m = /Encounter cards\s+(?:in|at)\s+(.+?),/i.exec(quest.setup || '');
  if (m) return locByName(cat, m[1]);
  return null;
}

/** Human-readable, data-driven "how do I actually do this" note for a quest's
 *  Task — surfaced in the UI (quest chip / tooltip) because the raw Task text
 *  ("Defeat the Crebain.") assumes the reader already knows the substitution
 *  rule from the quest's Setup sentence. Built from the same parsing used to
 *  detect completion (parseTask) and the encounter-substitution regex used by
 *  registerQuestCombat, so it always matches what the engine will actually do. */
export function questHowTo(cat: Catalog, quest: Quest): string {
  const spec = parseTask(cat, quest.task || '');
  const parts: string[] = [];
  const locName = (id: LocationId) => cat.locations[id]?.name ?? id;
  const sub = /Encounter cards\s+(?:in|at)\s+(.+?),\s*combat\s+(?:a\s+|an\s+)?(.+?)\s+instead/i.exec(quest.setup || '');
  if (spec.exploreLocs.length) {
    const names = spec.exploreLocs.map(locName).join(' or ');
    parts.push(`Travel to ${names} (a green quest marker shows the spot on the map), then use the Explore action there.`);
  }
  if (sub) {
    parts.push(`Exploring there draws a combat against ${sub[2].trim()} instead of a normal Encounter card — win that fight (use the "Fight" button once it appears) to complete the quest.`);
  } else if (spec.defeatNames.length) {
    parts.push(`Defeat ${spec.defeatNames.join(' or ')} in combat (fight it via the "Fight" button when it is at your location) to complete the quest.`);
  }
  return parts.join(' ') || 'Follow the quest\u2019s Setup, then satisfy its Task via Explore or combat.';
}

function questById(cat: Catalog, id: string | undefined): Quest | undefined {
  return id ? cat.quests[id] : undefined;
}

/** The quest a hero can currently work toward of the given type: the Starting
 *  Quest until completed, then the (revealed) Advanced Quest. */
function pendingStarting(cat: Catalog, hero: HeroState): Quest | undefined {
  const q = hero.quests;
  if (!q || q.startingDone) return undefined;
  return questById(cat, q.startingQuestId);
}
function pendingAdvanced(cat: Catalog, hero: HeroState): Quest | undefined {
  const q = hero.quests;
  if (!q || !q.advancedUnlocked || q.advancedDone) return undefined;
  return questById(cat, q.advancedQuestId);
}

/** Register a Defeat-quest's encounter substitution parsed from the quest Setup:
 *  "When you would draw Encounter cards in/at <LOC>, combat a <Monster> instead."
 *  The foe is placed when the hero explores <LOC> (see questSubstituteMonster).
 *  `placedLoc` is the location the quest Setup already placed a character at,
 *  used as a fallback when the sentence's location name has a typo. */
export function registerQuestCombat(cat: Catalog, hero: HeroState, quest: Quest, placedLoc: LocationId | null): void {
  const m = /Encounter cards\s+(?:in|at)\s+(.+?),\s*combat\s+(?:a\s+|an\s+)?(.+?)\s+instead/i.exec(quest.setup || '');
  if (!m) return;
  const monster = monsterByName(cat, m[2]);
  const loc = locByName(cat, m[1]) ?? placedLoc;
  if (!monster || !loc) return;
  hero.quests ||= { startingDone: false, advancedDone: false };
  (hero.quests.combats ||= []).push({ location: loc, monster, questId: quest.id });
}

/** If the hero has an unfulfilled Defeat-quest substitution at `loc`, return the
 *  foe to place there instead of drawing Encounter cards (rulebook: "combat a
 *  <Monster> instead"). */
export function questSubstituteMonster(hero: HeroState, loc: LocationId): MonsterId | null {
  const sub = hero.quests?.combats?.find((c) => c.location === loc);
  return sub ? sub.monster : null;
}

/** Apply a quest's reward text. Effects are additive; an "N favor or 1 level of
 *  <attr>" choice auto-selects the attribute level while it still has room
 *  (levels are capped at 2/attribute), else the favor. */
export function applyQuestReward(s: GameState, cat: Catalog, hero: HeroState, quest: Quest): void {
  let text = quest.reward || '';

  // 1) "Gain N favor or 1 level of <attr>" — a genuine PLAYER choice. Surface it
  //    as an interactive pendingChoice (the human picks in the UI; the AI drivers
  //    auto-resolve it via combatOption, which takes the first, best-ordered
  //    option). Applied by resolveQuestRewardChoice when the option is chosen.
  text = text.replace(/gain\s+(\d+)\s+favor\s+or\s+1\s+level\s+of\s+(\w+)/gi, (_m, n: string, attr: string) => {
    const a = attr.toLowerCase() as Attr;
    const favorOpt = { id: `qr:${hero.id}:favor:${n}`, label: `Gain ${n} favor` };
    const attrOpt = { id: `qr:${hero.id}:attr:${a}`, label: `1 level of ${a}` };
    const roomForAttr = ATTRS.includes(a) && (hero.levels?.[a] ?? 0) < 2;
    // Best-first ordering: offer the attribute level first while it still has
    // room (levels are capped at 2/attribute) — this preserves the prior
    // deterministic default so AI/self-play stays stable; else offer favor first.
    const seat = Math.max(0, s.heroes.indexOf(hero));
    s.pendingChoice = {
      id: `quest-reward-${quest.id}`, seat, kind: 'quest-reward',
      prompt: `${quest.name} — reward, choose one:`,
      options: roomForAttr ? [attrOpt, favorOpt] : [favorOpt, attrOpt],
    };
    return '';
  });

  // 2) plain "Gain N favor"
  for (const m of text.matchAll(/gain\s+(\d+)\s+favor/gi)) {
    grantFavor(cat, hero, parseInt(m[1], 10));
    log(s, 'hero-quest', hero.id, `reward: +${m[1]} favor`);
  }
  // 3) "1 level of <attr>" (the additive, non-choice form)
  for (const m of text.matchAll(/1\s+level\s+of\s+(\w+)/gi)) {
    const a = m[1].toLowerCase() as Attr;
    if (ATTRS.includes(a)) {
      const got = raiseAttribute(hero, a, 1);
      log(s, 'hero-quest', hero.id, `reward: +${got} ${a}`);
    }
  }
  // 4) training
  if (/receive training/i.test(text)) {
    grantTraining(s, cat, hero, 1);
    log(s, 'hero-quest', hero.id, 'reward: received training (Skill card)');
  }
  // 5) Item card ("Gain a \"Boat\" Item card")
  const item = /gain\s+a\s+"?([A-Za-z ]+?)"?\s+item card/i.exec(text);
  if (item) { hero.items.push(item[1].trim()); log(s, 'hero-quest', hero.id, `reward: gained ${item[1].trim()} Item`); }
  // 6) place character(s) on the board
  for (const m of text.matchAll(/place\s+([A-Za-z'’.\- ]+?)\s+in\s+([A-Za-z'’.\- ]+?)[.,]/gi)) {
    const loc = locByName(cat, m[2]);
    if (loc) {
      placeCharacterUnique(s, m[1], loc);
      log(s, 'hero-quest', hero.id, `reward: placed ${m[1].trim()} at ${cat.locations[loc]?.name ?? loc}`);
    }
  }
  // 7) shuffle rest pool into life pool
  if (/shuffle your rest pool into your life pool/i.test(text)) {
    restHero(s, hero);
    log(s, 'hero-quest', hero.id, 'reward: shuffled rest pool into life pool');
  }
  // 8) remove influence from the Shadow Pool
  const rem = /remove\s+(\d+)\s+influence from the Shadow Pool/i.exec(text);
  if (rem) {
    const n = Math.min(parseInt(rem[1], 10), s.sauron.influence);
    s.sauron.influence -= n;
    log(s, 'hero-quest', hero.id, `reward: removed ${n} influence from the Shadow Pool`);
  }
  // 9) force Sauron to discard random Shadow card(s)
  const disc = /discard\s+(\d+)\s+random Shadow card/i.exec(text);
  if (disc) {
    let n = parseInt(disc[1], 10);
    while (n-- > 0 && s.sauron.shadowHand.length) {
      const idx = nextInt(s, s.sauron.shadowHand.length);
      const cid = s.sauron.shadowHand.splice(idx, 1)[0];
      s.sauron.shadowDiscard.push(cid);
    }
    log(s, 'hero-quest', hero.id, `reward: forced Sauron to discard ${disc[1]} Shadow card(s)`);
  }
  // 10) Sauron must choose: discard 1 plot card FROM HIS HAND, or lose N influence
  //     from the Shadow Pool. Now that the plot hand is modelled, resolve it in
  //     Sauron's favour: discard his weakest plot (lowest marker advance) if he
  //     holds any, otherwise take the influence loss.
  const choose = /discard\s+(\d+)\s+plot card.*?or\s+(\d+)\s+influence/i.exec(text);
  if (choose) {
    const hand = s.sauron.plotHand ?? [];
    if (hand.length) {
      const weakest = [...hand].sort((a, b) =>
        ((cat.plots.find((p) => p.id === a)?.advance ?? 1) - (cat.plots.find((p) => p.id === b)?.advance ?? 1)))[0];
      s.sauron.plotHand = hand.filter((id) => id !== weakest);
      (s.sauron.plotDiscard ??= []).push(weakest);
      log(s, 'hero-quest', hero.id, 'reward: Sauron discards a Plot card from his hand');
    } else {
      const n = Math.min(parseInt(choose[2], 10), s.sauron.influence);
      s.sauron.influence -= n;
      log(s, 'hero-quest', hero.id, `reward: Sauron lost ${n} influence (no plot in hand)`);
    }
  }
}

/** Resolve an interactive quest-reward "A or B" choice. `optionId` is
 *  `qr:<heroId>:favor:<n>` or `qr:<heroId>:attr:<attr>`. */
export function resolveQuestRewardChoice(s: GameState, cat: Catalog, optionId: string): void {
  const parts = optionId.split(':');
  if (parts[0] !== 'qr') return;
  const hero = s.heroes.find((h) => h.id === parts[1]);
  if (!hero) return;
  if (parts[2] === 'favor') {
    const n = parseInt(parts[3], 10) || 0;
    grantFavor(cat, hero, n);
    log(s, 'hero-quest', hero.id, `reward: +${n} favor`);
  } else if (parts[2] === 'attr') {
    const a = parts[3] as Attr;
    if (ATTRS.includes(a)) {
      const got = raiseAttribute(hero, a, 1);
      log(s, 'hero-quest', hero.id, `reward: +${got} ${a}`);
    }
  }
}

/** Complete a quest: mark it done, apply the reward, and — for a Starting Quest
 *  — reveal (unlock) the hero's Advanced Quest. */
/** Remove a hero's green Quest markers from the board (called when a quest of
 *  his completes; the next objective, if any, places a fresh marker). */
function clearQuestMarker(s: GameState, heroId: HeroId): void {
  const qa = s.map.questAt;
  if (!qa) return;
  for (const loc of Object.keys(qa)) {
    qa[loc] = qa[loc].filter((h) => h !== heroId);
    if (!qa[loc].length) delete qa[loc];
  }
}

function completeQuest(s: GameState, cat: Catalog, hero: HeroState, quest: Quest): void {
  const q = (hero.quests ||= { startingDone: false, advancedDone: false });
  clearQuestMarker(s, hero.id);
  if (quest.type === 'Starting Quest') {
    q.startingDone = true;
    q.advancedUnlocked = true;
    // drop any lingering Defeat substitution for this quest
    q.combats = (q.combats ?? []).filter((c) => c.questId !== quest.id);
    // Reveal the now-unlocked Advanced Quest objective with a fresh green marker.
    const adv = questById(cat, q.advancedQuestId);
    const advLoc = adv ? questTargetLocation(cat, adv, null) : null;
    if (advLoc) ((s.map.questAt ||= {})[advLoc] ||= []).push(hero.id);
  } else {
    q.advancedDone = true;
  }
  log(s, 'hero-quest', hero.id, `completed ${quest.type}: ${quest.name}`);
  applyQuestReward(s, cat, hero, quest);
  if (hero.id === 'eleanor' && !hero.abilityUsedThisTurn) {
    hero.abilityUsedThisTurn = true; grantFavor(cat, hero, 1);
    log(s, 'hero-ability', hero.id, 'Eleanor: +1 favor for completing a Quest');
  }
}

/** Complete the hero's current pending quest (Starting first, then the revealed
 *  Advanced) explicitly — used by the manual "Complete quest" action once the
 *  hero has fulfilled its task. Returns the completed quest, or null if none. */
export function completeCurrentQuest(s: GameState, cat: Catalog, hero: HeroState): Quest | null {
  const quest = pendingStarting(cat, hero) ?? pendingAdvanced(cat, hero);
  if (!quest) return null;
  completeQuest(s, cat, hero, quest);
  return quest;
}

/** True when the active hero stands on a location that satisfies an Explore task
 *  of one of his pending quests — i.e. the manual completion is available. */
export function questTaskReadyHere(s: GameState, cat: Catalog, heroId: HeroId): boolean {
  const hero = s.heroes.find((h) => h.id === heroId);
  if (!hero) return false;
  for (const quest of [pendingStarting(cat, hero), pendingAdvanced(cat, hero)]) {
    if (!quest) continue;
    if (parseTask(cat, quest.task).exploreLocs.includes(hero.location)) return true;
  }
  return false;
}

export function tryCompleteQuestsOnExplore(s: GameState, cat: Catalog, heroId: HeroId, loc: LocationId): void {
  const hero = s.heroes.find((h) => h.id === heroId);
  if (!hero) return;
  for (const quest of [pendingStarting(cat, hero), pendingAdvanced(cat, hero)]) {
    if (!quest) continue;
    const spec = parseTask(cat, quest.task);
    if (spec.exploreLocs.includes(loc)) completeQuest(s, cat, hero, quest);
  }
}

/** Try to complete the hero's active quests whose task is to defeat `monsterId`
 *  (a monster or minion). Called from combat resolution on a hero victory. */
export function tryCompleteQuestsOnDefeat(s: GameState, cat: Catalog, heroId: HeroId, foeId: string): void {
  const hero = s.heroes.find((h) => h.id === heroId);
  if (!hero) return;
  const foeName = norm(cat.monsters[foeId as MonsterId]?.name ?? cat.minions[foeId]?.name ?? '');
  if (!foeName) return;
  for (const quest of [pendingStarting(cat, hero), pendingAdvanced(cat, hero)]) {
    if (!quest) continue;
    const spec = parseTask(cat, quest.task);
    const wants = spec.defeatNames.some((n) => {
      const mid = monsterByName(cat, n) ?? minionByName(cat, n);
      return mid ? norm(cat.monsters[mid as MonsterId]?.name ?? cat.minions[mid]?.name ?? '') === foeName : norm(n) === foeName;
    });
    if (wants) completeQuest(s, cat, hero, quest);
  }
}
