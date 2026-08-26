// Verifies M2 combat-effect coverage: every effectKey assigned to a combat card
// (assets/combat-cards.json) must be implemented in the engine effect registry
// (src/engine/effects.ts), and every card must carry a non-empty effectKey when
// it has ability text. Exits non-zero on any gap.
//
// Run: node scripts/verify-effect-coverage.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cards = JSON.parse(readFileSync(join(root, 'assets/combat-cards.json'), 'utf8')).cards;
const effectsSrc = readFileSync(join(root, 'src/engine/effects.ts'), 'utf8');

// Registry keys: entries of `key: '<name>'` inside the EFFECTS object.
const registry = new Set([...effectsSrc.matchAll(/key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));

const problems = [];

// 1. Every card with ability text must have an effectKey.
const missingKey = cards.filter((c) => c.ability && String(c.ability).trim() && !c.effectKey);
if (missingKey.length) {
  problems.push(`${missingKey.length} card(s) with ability text but no effectKey:`);
  for (const c of missingKey.slice(0, 10)) problems.push(`   ${c.id}: ${c.ability}`);
}

// 2. Every assigned effectKey must exist in the registry.
const usedKeys = new Set(cards.map((c) => c.effectKey).filter(Boolean));
const unimplemented = [...usedKeys].filter((k) => !registry.has(k));
if (unimplemented.length) {
  problems.push(`${unimplemented.length} effectKey(s) used by cards but missing from registry:`);
  for (const k of unimplemented) problems.push(`   ${k}`);
}

// 3. Report (warn only) registry keys never used by any card.
const unused = [...registry].filter((k) => !usedKeys.has(k));

console.log(`combat cards: ${cards.length}`);
console.log(`cards with effectKey: ${cards.filter((c) => c.effectKey).length}`);
console.log(`distinct effectKeys used: ${usedKeys.size}`);
console.log(`registry effect specs: ${registry.size}`);
if (unused.length) console.log(`note: ${unused.length} registry key(s) unused by any card: ${unused.join(', ')}`);

if (problems.length) {
  console.error('\nEFFECT COVERAGE FAILED:');
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('\neffect coverage: PASS (all card abilities mapped and implemented)');
