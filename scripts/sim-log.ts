import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import { advance, endHeroActions, encounterPlan, resolveChoice, resolveEncounter, chooseEncounter, autoResolvePendingTree } from '../src/engine/game';
import { applyHeroAction, describeHeroAction, missionAware, mulberry32 } from '../src/engine/heroAI';
import * as fs from 'node:fs';

const cat = loadCatalog();
const dir = process.argv[2];
const seeds = process.argv.slice(3).map(Number);
const strat = missionAware;
for (const seed of seeds) {
  let s = newGame(cat, seed, undefined);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const lines: string[] = [];
  let steps = 0;
  let seen = 0;
  const flush = () => {
    for (; seen < s.log.length; seen++) {
      const e = s.log[seen] as unknown as Record<string, unknown>;
      lines.push(`[T${e.turn} ${String(e.side ?? '').slice(0, 1)} ${e.phase}] ${e.actor ?? ''}: ${e.detail ?? e.msg ?? JSON.stringify(e)}`);
    }
  };
  while (!s.winner && steps < 30000) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); flush(); continue; }
    if (s.pendingCombat && !s.pendingTree) { continue; }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); flush(); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng)); flush(); continue; }
      s = resolveEncounter(s, cat); flush(); continue;
    }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); flush(); continue; }
      const act = strat.heroAction(s, cat, hero.id, rng);
      lines.push(`  >> HERO ${describeHeroAction(s, cat, hero.id, act)}`);
      s = applyHeroAction(s, cat, hero.id, act);
      flush();
      continue;
    }
    s = advance(s, cat);
    flush();
  }
  lines.push(`RESULT seed ${seed}: winner=${s.winner} reason=${s.winReason} turns=${s.story.turn} steps=${steps}`);
  fs.writeFileSync(`${dir}/game-${seed}.log`, lines.join('\n'));
  console.log(lines[lines.length - 1], 'lines', lines.length);
}
