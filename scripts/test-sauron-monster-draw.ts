// Place Monster Token (rulebook p.18): Sauron chooses a PILE, a random token is drawn,
// then he places it on an influenced, hero-free location of that region; one per Command action.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import { sauronDrawMonsterToken, sauronSpawnMonster, monsterTargetsIn } from '../src/engine/sauronPlay';

const cat = loadCatalog();
let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

const s0 = newGame(cat, 7, ['beravor']);
s0.phase = 'SauronMinions';
s0.sauronPending = { track: 'command', remaining: 3 };

const region = Object.keys(cat.monsterBags).find((r) => monsterTargetsIn(s0, cat, r).length > 0);
check(!!region, 'some pile has a legal location');
const s1 = sauronDrawMonsterToken(s0, cat, region!);
const held = s1.sauronPending?.heldToken;
check(!!held && held.regionId === region, 'drawing from a pile holds a token');
check(s1.sauronPending!.remaining === 3, 'drawing alone does not spend a command');
check(sauronDrawMonsterToken(s1, cat, region!) === s1, 'cannot draw again while a token is held');

const target = monsterTargetsIn(s1, cat, region!)[0];
const other = Object.keys(cat.locations).find((l) => cat.locations[l].regionId !== region);
check(sauronSpawnMonster(s1, cat, other as never) === s1, 'cannot place outside the pile region');

const s2 = sauronSpawnMonster(s1, cat, target);
const placed = held!.token === 'blank' ? (s2.map.rumorsAt?.[target] ?? 0) > 0 : (s2.map.monstersAt[target] ?? []).includes(held!.token);
check(placed, 'token is placed on the chosen location');
check(s2.sauronPending?.remaining === 2 && s2.sauronPending.monsterDone === true, 'placing spends one command and marks the monster used');
const other2 = Object.keys(cat.monsterBags).find((r) => monsterTargetsIn(s2, cat, r).length > 0);
check(!other2 || sauronDrawMonsterToken(s2, cat, other2) === s2, 'only one monster token per Command action');

console.log(`FAIL (${fails})`);
process.exit(fails ? 1 : 0);
