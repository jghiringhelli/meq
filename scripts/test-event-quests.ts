// Event quests (event cards with a printed quest location) must NOT resolve
// when drawn: they sit on the single Current Event Card space and resolve only
// when a hero Explores their location. A new quest replaces the old one; an
// ordinary event leaves it alone.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import { sauronResolveEvents as runSauronEvents, heroExplore } from '../src/engine/phases';
import { moveHero } from '../src/engine/mechanics';
import { applyAtoms } from '../src/engine/encounter';
import { adjacentLocations } from '../src/engine/sauronPlay';

const cat = loadCatalog();
let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

const arwen = cat.events.find((e) => e.cardNo === '11' && e.turn === '1' && /ARWEN/i.test(e.name))!;
const gandalf = cat.events.find((e) => /GANDALF VISITS FRODO/i.test(e.name))!;
const plain = cat.events.find((e) => !e.questLocation && e.turn === '1')!;

function drawing(card: typeof arwen) {
  const s = newGame(cat, 123, ['beravor']);
  s.phase = 'SauronEvents';
  s.sauron.eventStage = 1;
  s.sauron.eventDeck = [card.id, ...(s.sauron.eventDeck ?? []).filter((x) => x !== card.id)];
  return s;
}

const a = drawing(arwen);
const favorBefore = a.heroes[0].favor;
const a1 = runSauronEvents(a, cat);
check((a1.sauron.activeEventPlots ?? []).some((m) => m.eventId === arwen.id), 'Arwen quest is in play after drawing');
check(a1.heroes[0].favor === favorBefore && !a1.eventTreeQueue?.length && !a1.pendingTree, 'drawing Arwen resolves nothing immediately');

const loc = (a1.sauron.activeEventPlots ?? [])[0].location!;
check(loc === 'weathertop', `quest location is Weathertop (got ${loc})`);

const heroLoc = a1.heroes[0].location;
check(heroLoc !== loc, 'hero starts elsewhere (not auto-resolved)');
moveHero(a1, 'beravor', loc);
a1.phase = 'HeroActions';
a1.heroes[0].actionsRemaining = 1;
a1.heroes[0].encounterStepDone = false;
a1.humanSide = 'Sauron';
const a2 = heroExplore(a1, cat, 'beravor');
check(!(a2.sauron.activeEventPlots ?? []).length, 'exploring the quest location discards the quest');
check(a2.log.some((e) => /event ARWEN/i.test(e.detail)), 'exploring applied the quest effect');

// a quest is replaced by a new quest, kept by a plain event
const b = drawing(arwen);
const b1 = runSauronEvents(b, cat);
b1.phase = 'SauronEvents';
b1.sauron.eventDeck = [plain.id, ...(b1.sauron.eventDeck ?? [])];
const b2 = runSauronEvents(b1, cat);
check((b2.sauron.activeEventPlots ?? []).some((m) => m.eventId === arwen.id), 'a plain event does not remove the quest');
b2.phase = 'SauronEvents';
b2.sauron.eventDeck = [gandalf.id, ...(b2.sauron.eventDeck ?? [])];
const b3 = runSauronEvents(b2, cat);
const ids = (b3.sauron.activeEventPlots ?? []).map((m) => m.eventId);
check(ids.length === 1 && ids[0] === gandalf.id, 'a new quest replaces the previous one');

// Owner-verified list of cards that carry the green event-marker flag.
const FLAGGED: Record<string, number[]> = { '1': [9, 10, 11, 12, 13, 14], '2': [1, 2, 5, 6, 10, 11, 13], '3': [1, 2, 6, 7, 10, 12, 13, 14] };
for (const [turn, nums] of Object.entries(FLAGGED)) {
  const got = cat.events.filter((e) => e.turn === turn && e.questLocation).map((e) => Number(e.cardNo)).sort((x, y) => x - y);
  check(JSON.stringify(got) === JSON.stringify(nums), `stage ${turn} flagged cards = ${nums.join(',')} (got ${got.join(',')})`);
}

// Arnor, That Was of Old: choose (a) clear influence + monsters within 1 of Fornost, or (b) a favor token on Fornost.
{
  const arnor = cat.events.find((e) => /ARNOR, THAT WAS OF OLD/i.test(e.name))!;
  const opts = (arnor.tree as any).options as { eff: { atom: any } }[];
  const mk = () => {
    const s = newGame(cat, 5, ['beravor']);
    const near = adjacentLocations(cat, 'fornost')[0];
    return { s, near };
  };
  const { s: s1, near } = mk();
  if (near) {
    s1.sauron.locationInfluence = { ...(s1.sauron.locationInfluence ?? {}), fornost: 2, [near]: 3 };
    (s1.map.monstersAt[near] ||= []).push(Object.keys(cat.monsters)[0]);
  }
  applyAtoms(s1, cat, 'beravor', [opts[0].eff.atom], 'test');
  check(!!near && !(s1.sauron.locationInfluence?.fornost) && !(s1.sauron.locationInfluence?.[near!]) && !(s1.map.monstersAt[near!]?.length),
    'Arnor option 1 clears influence and monsters within 1 space of Fornost');
  const { s: s2 } = mk();
  const before = s2.map.favorAt?.fornost ?? 0;
  const favHero = s2.heroes[0].favor;
  applyAtoms(s2, cat, 'beravor', [opts[1].eff.atom], 'test');
  check((s2.map.favorAt?.fornost ?? 0) === before + 1 && s2.heroes[0].favor === favHero, 'Arnor option 2 places a favor token on Fornost (not on the hero)');
}

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nevent quests: PASS');
