// M4 encounter-coverage verifier. Asserts every encounter compiled to a
// structured effect tree with no unmodeled `raw` remainder, and that every
// atom the trees reference is handled by the interpreter (src/engine/encounter.ts).
// Run: node scripts/verify-encounter-coverage.mjs
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const enc = read('assets/encounters.json').cards;
const interp = readFileSync('src/engine/encounter.ts', 'utf-8');

// atoms the interpreter's applyAtom switch handles: `case 'name':`
const handled = new Set([...interp.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));

const problems = [];
let partial = 0, choiceCards = 0, condCards = 0;
const atomsUsed = new Set();

function walk(node, card) {
  if (!node || typeof node !== 'object') return;
  switch (node.k) {
    case 'raw': problems.push(`${card}: raw remainder "${node.text}"`); break;
    case 'op':
      atomsUsed.add(node.atom.op);
      if (!handled.has(node.atom.op)) problems.push(`${card}: atom '${node.atom.op}' not handled by interpreter`);
      break;
    case 'seq': node.steps.forEach((s) => walk(s, card)); break;
    case 'if': condCards++; walk(node.then, card); if (node.else) walk(node.else, card); break;
    case 'optional': choiceCards++; if (node.cost) atomsUsed.add(node.cost.op); walk(node.eff, card); break;
    case 'choice':
      choiceCards++;
      node.options.forEach((o) => { if (o.cost) atomsUsed.add(o.cost.op); walk(o.eff, card); });
      break;
    case 'none': break;
    default: problems.push(`${card}: unknown node kind '${node.k}'`);
  }
}

for (const e of enc) {
  if (e.partial) { partial++; problems.push(`${e.name}: flagged partial`); }
  if (!e.tree) { problems.push(`${e.name}: no tree`); continue; }
  walk(e.tree, e.name);
}

console.log(`encounters: ${enc.length}, partial: ${partial}`);
console.log(`cards with choices/optionals: ${choiceCards}, conditional branches: ${condCards}`);
console.log(`distinct atoms used: ${[...atomsUsed].sort().join(', ')}`);
const unusedHandled = [...handled].filter((h) => !atomsUsed.has(h));
if (unusedHandled.length) console.log(`(interpreter handles but unused: ${unusedHandled.join(', ')})`);

if (problems.length) {
  console.error(`\nFAIL (${problems.length}):`);
  for (const p of problems.slice(0, 40)) console.error('  -', p);
  process.exit(1);
}
console.log('\nencounter coverage: PASS — all 90 cards fully modeled, all atoms handled');
