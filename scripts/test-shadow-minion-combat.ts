declare const process: { exit(code: number): never };
// Forces the two minion-combat Shadow cards (Morgul-Blade, The Black Breath) to
// fire at the "start of combat" window, for both the automa and a human Sauron.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame, heroEngage, resolveShadowReaction, autoResolvePendingTree } from '../src/engine/game';
import { toHeroActions } from './_util';
import type { GameState } from '../src/engine/types';

let failures = 0;
function assert(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}
const cat = loadCatalog();

function setup(card: string, human: boolean, minionId: string): GameState {
  let s = toHeroActions(newGame(cat, 3), cat);
  const hero = s.heroes[s.activeHeroIndex];
  s.humanSide = human ? 'Sauron' : 'Hero';
  s.sauron.shadowHand = [card];
  s.sauron.influence = 10;
  s.shadowPlayedThisHeroTurn = false;
  s.map.minionsAt = { [hero.location]: [minionId] };
  s.map.monstersAt[hero.location] = [];
  return s;
}
const corruption = (s: GameState, id: string) => s.heroes.find((h) => h.id === id)!.corruptionCards?.length ?? 0;

for (const card of ['shadow-morgul-blade', 'shadow-the-black-breath']) {
  for (const human of [false, true]) {
    const label = `${card} (${human ? 'human' : 'automa'} Sauron)`;
    const s0 = setup(card, human, 'minion-black-serpent');
    const heroId = s0.heroes[s0.activeHeroIndex].id;
    const corrBefore = corruption(s0, heroId);
    let s = heroEngage(s0, cat, heroId, 'minion-black-serpent');
    if (human) {
      assert(!!s.pendingShadowReaction, `${label}: reaction window is offered`);
      assert(!!s.pendingShadowReaction?.options.some((o) => o.id === card), `${label}: the card is an option`);
      s = resolveShadowReaction(s, cat, card);
    }
    if (s.pendingTree) s = autoResolvePendingTree(s, cat);
    assert(!s.sauron.shadowHand.includes(card) && s.sauron.shadowDiscard.includes(card), `${label}: card was played`);
    assert(corruption(s, heroId) > corrBefore || (card.includes('morgul') && s.heroes.find((h) => h.id === heroId)!.damagePool.length > 0),
      `${label}: effect landed on the hero`);
  }
}

// Black Breath's strength/agility penalty must actually reach the combatant.
{
  const run = (withCard: boolean) => {
    const s0 = setup('shadow-the-black-breath', false, 'minion-black-serpent');
    if (!withCard) s0.sauron.shadowHand = [];
    const id = s0.heroes[s0.activeHeroIndex].id;
    let s = heroEngage(s0, cat, id, 'minion-black-serpent');
    if (s.pendingTree) s = autoResolvePendingTree(s, cat);
    const a = s.pendingCombat?.attacker;
    return `${a?.strength}|${s.heroes.find((h) => h.id === id)!.combatMods?.length ?? 0}`;
  };
  const [withB, without] = [run(true), run(false)];
  const sWith = Number(withB.split('|')[0]), sWithout = Number(without.split('|')[0]);
  assert(sWith < sWithout, `Black Breath lowers the combatant's Strength (${sWith} < ${sWithout})`);
}

// Not offered when the fight is not against a minion.
{
  const s0 = setup('shadow-morgul-blade', true, 'minion-black-serpent');
  const hero = s0.heroes[s0.activeHeroIndex];
  s0.map.minionsAt = {};
  const mon = Object.keys(cat.monsters)[0];
  s0.map.monstersAt[hero.location] = [mon];
  const s = heroEngage(s0, cat, hero.id, mon);
  assert(!s.pendingShadowReaction, 'minion-only Shadow card is not offered against a plain monster');
}

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all ok');
