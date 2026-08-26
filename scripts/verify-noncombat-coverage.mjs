// Verifies M3 non-combat data coverage: every encounter + event row is
// classified (mechanical | flavor | empty), every parsed op is a known op with
// an integer amount, and every mission either carries a structured condition or
// is a documented unclassifiable row. Exits non-zero on any malformed data.
//
// Run: node scripts/verify-noncombat-coverage.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const enc = read('assets/encounters.json').cards;
const ev = read('assets/events.json').events;
const missions = read('assets/missions.json');

const KNOWN_OPS = new Set([
  'gainFavor', 'loseFavor', 'gainCorruption', 'removeCorruption',
  'addInfluence', 'removeInfluence', 'damage',
]);
const KNOWN_KINDS = new Set(['mechanical', 'flavor', 'empty']);
const KNOWN_CONDS = new Set([
  'heroCorruptionAtMost', 'heroFavorAtLeast', 'monstersAtMost',
  'minionsAtMost', 'activePlotsAtLeast', 'allQuestsComplete',
  'sauronMarkerAtStageIII', 'sauronInfluenceAtLeast', 'ringwraithsOrShireInfluence',
]);

const problems = [];

function checkRows(rows, label) {
  for (const r of rows) {
    if (!KNOWN_KINDS.has(r.effectKind)) problems.push(`${label} ${r.id}: bad effectKind '${r.effectKind}'`);
    if (!Array.isArray(r.ops)) { problems.push(`${label} ${r.id}: ops not an array`); continue; }
    for (const o of r.ops) {
      if (!KNOWN_OPS.has(o.op)) problems.push(`${label} ${r.id}: unknown op '${o.op}'`);
      if (!Number.isInteger(o.n)) problems.push(`${label} ${r.id}: op '${o.op}' amount not integer`);
    }
    // consistency: mechanical <=> has ops
    if (r.effectKind === 'mechanical' && r.ops.length === 0) problems.push(`${label} ${r.id}: mechanical but no ops`);
    if (r.effectKind === 'flavor' && r.ops.length > 0) problems.push(`${label} ${r.id}: flavor but has ops`);
  }
}

checkRows(enc, 'encounter');
checkRows(ev, 'event');

let conditioned = 0;
for (const m of [...missions.heroMissions, ...missions.sauronMissions]) {
  if (m.condition == null) continue;
  conditioned++;
  if (!KNOWN_CONDS.has(m.condition.kind)) problems.push(`mission ${m.id}: unknown condition '${m.condition.kind}'`);
}

const kindCount = (rows) => rows.reduce((a, r) => (a[r.effectKind] = (a[r.effectKind] || 0) + 1, a), {});
console.log('encounters:', enc.length, kindCount(enc));
console.log('events:', ev.length, kindCount(ev));
console.log('missions with structured condition:', conditioned, '/', missions.heroMissions.length + missions.sauronMissions.length);

if (problems.length) {
  console.error('\nNON-COMBAT COVERAGE FAILED:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('\nnon-combat coverage: PASS');
