// M10 acceptance test — the hero economy (Explore actions + Rest cleanse) and
// the secret-mission setup. Exercises each action from a fresh game and asserts
// the state deltas. Run: npx tsx scripts/test-m10-economy.ts
import { loadCatalog } from '../src/data/loadAssets';
import {
  newGame, heroDarkPath, heroRetrieveFavor, heroConsultCharacter,
  heroCompleteQuest, heroDiscardPlot, heroTradeFavor, heroCleanseCorruption,
  favorHere, charactersHere,
} from '../src/engine/game';
import type { GameState } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

const cat = loadCatalog();

// A fresh game always enters HeroActions after refresh; force it there.
function ready(): GameState {
  const s = newGame(cat, 7);
  s.phase = 'HeroActions';
  s.heroes.forEach((h) => (h.actionsRemaining = 9));
  return s;
}

// --- secret missions chosen at setup ---
{
  const s = newGame(cat, 7);
  assert(!!s.secretHeroMission && !!cat.heroMissions[s.secretHeroMission], 'a secret hero mission is chosen');
  assert(!!s.secretSauronMission && !!cat.sauronMissions[s.secretSauronMission], 'a secret Sauron mission is chosen');
  const s2 = newGame(cat, 8);
  assert(s.secretHeroMission !== s2.secretHeroMission || s.secretSauronMission !== s2.secretSauronMission,
    'different seeds can pick different secret missions');
}

// --- dark path: +1 favor, +1 corruption ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const f0 = s.heroes[0].favor, c0 = s.heroes[0].corruption;
  const s1 = heroDarkPath(s, cat, id);
  assert(s1.heroes[0].favor === f0 + 1 && s1.heroes[0].corruption === c0 + 1, 'dark path grants +1 favor +1 corruption');
}

// --- retrieve favor from the board ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const loc = s.heroes[0].location;
  s.map.favorAt![loc] = 2;
  assert(favorHere(s, id) === 2, 'favorHere reports the board token');
  const s1 = heroRetrieveFavor(s, cat, id);
  assert(s1.heroes[0].favor === 2 && (s1.map.favorAt![loc] ?? 0) === 0, 'retrieve favor takes the token');
}

// --- consult a Character -> favor OR ability (manual: not both) ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const loc = s.heroes[0].location;
  s.map.charactersAt![loc] = ['gandalf'];
  assert(charactersHere(s, id).includes('gandalf'), 'charactersHere lists the character');
  // ability: recruits ally, no favor, character leaves the board
  const sAbility = heroConsultCharacter(s, cat, id, 'gandalf', 'ability');
  assert(sAbility.heroes[0].allies!.includes('gandalf') && sAbility.heroes[0].favor === 0, 'consult (ability) recruits ally and grants no favor');
  assert(!(sAbility.map.charactersAt![loc] ?? []).includes('gandalf'), 'character leaves the board once consulted for ability');
  // favor: +2 favor, no ally, character still leaves the board
  const sFavor = heroConsultCharacter(s, cat, id, 'gandalf', 'favor');
  assert(sFavor.heroes[0].favor === 2 && !(sFavor.heroes[0].allies ?? []).includes('gandalf'), 'consult (favor) grants 2 favor and no ally');
  assert(!(sFavor.map.charactersAt![loc] ?? []).includes('gandalf'), 'character leaves the board when consulted for favor');
}

// --- complete quest at a haven with favor ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const haven = Object.values(cat.locations).find((l) => l.kind === 'haven')!;
  s.heroes[0].location = haven.id;
  s.heroes[0].favor = 3;
  const s1 = heroCompleteQuest(s, cat, id);
  assert(s1.heroes[0].quests!.startingDone, 'first quest completion sets startingDone');
  const s2 = heroCompleteQuest(s1, cat, id);
  assert(s2.heroes[0].quests!.advancedDone, 'second quest completion sets advancedDone');
}

// --- counter a plot at its location ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const slot = Object.values(cat.locations).find((l) => l.plotSlot)!;
  s.heroes[0].location = slot.id;
  s.heroes[0].favor = 6;
  const plot = cat.plots.find((p) => !p.starting && (p.favorToCounter ?? 0) > 0 && !p.affects)!;
  s.sauron.activePlots = [{ eventId: plot.id, step: 0 }];
  const before = s.heroes[0].favor;
  const s1 = heroDiscardPlot(s, cat, id);
  assert(
    (s1.sauron.activePlots ?? []).length === 0 && s1.heroes[0].favor === before - (plot.favorToCounter as number),
    'countering a plot removes it and pays its favor-to-counter cost',
  );
}

// --- trade favor between co-located heroes ---
{
  const s = ready();
  const a = s.heroes[0], b = s.heroes[1];
  b.location = a.location;
  a.favor = 3;
  const s1 = heroTradeFavor(s, cat, a.id, b.id, 2);
  assert(s1.heroes[0].favor === 1 && s1.heroes[1].favor === b.favor + 2, 'trade moves favor to the co-located hero');
}

// --- cleanse corruption at a haven paying favor ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const haven = Object.values(cat.locations).find((l) => l.kind === 'haven')!;
  s.heroes[0].location = haven.id;
  s.heroes[0].favor = 3;
  s.heroes[0].corruption = 2;
  const s1 = heroCleanseCorruption(s, cat, id);
  assert(s1.heroes[0].corruption === 1 && s1.heroes[0].favor === 1, 'cleanse removes 1 corruption for 2 favor');
}

console.log(failures === 0 ? '\nM10 hero-economy: PASS' : `\nM10 hero-economy: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
