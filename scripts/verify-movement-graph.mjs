// Validate the restructured movement graph against the board taxonomy and print
// a per-region, per-node worklist of everything that still needs a hand-correction.
// Read-only. Run:  node scripts/verify-movement-graph.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const g = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'movement-graph.json'), 'utf8'));

const TERRAINS = ['woods', 'swamp', 'mountain', 'plains', 'hill'];

function edgeFlags(e) {
  const f = [];
  if (e.cost == null) f.push('missing-cost');
  else if (e.cost < 1 || e.cost > 4) f.push(`cost-out-of-range(${e.cost})`);
  else if (e.cost === 1 && e.terrain) f.push(`cost1-should-have-no-terrain(has ${e.terrain})`);
  else if (e.cost >= 2 && !e.terrain) f.push('cost>=2-needs-terrain');
  if (e.terrain && !TERRAINS.includes(e.terrain)) f.push(`invalid-terrain(${e.terrain})`);
  if (e.horse !== !e.boat) f.push('horse-must-equal-!boat');
  return f;
}

if (g.schema !== 'movement-graph-v3-review') {
  console.error(`Unexpected schema "${g.schema}" — expected movement-graph-v3-review.`);
  process.exit(1);
}

let edgeCount = 0, flagged = 0;
const seenPairs = new Set();
let dupes = 0;
const report = [];

for (const rid of (g._meta?.regionOrder ?? Object.keys(g.regions))) {
  const region = g.regions[rid];
  if (!region) continue;
  const lines = [];
  for (const [id, node] of Object.entries(region.nodes)) {
    for (const e of node.edges) {
      edgeCount++;
      const pair = [id, e.to].sort().join('|');
      if (seenPairs.has(pair)) { dupes++; lines.push(`    ${id} -> ${e.to}  ! DUPLICATE edge (already stored elsewhere)`); }
      seenPairs.add(pair);
      const f = edgeFlags(e);
      if (f.length) {
        flagged++;
        const dir = e.toRegion ? ` [->${e.toRegion}]` : '';
        lines.push(`    ${id} -> ${e.to}${dir}  {cost:${e.cost ?? 'null'}, terrain:'${e.terrain || ''}', boat:${e.boat}}  ==> ${f.join('; ')}`);
      }
    }
  }
  if (lines.length) report.push(`\n[${rid}] ${region.regionName}`, ...lines);
}

console.log('=== Movement graph validation worklist ===');
console.log(`schema        : ${g.schema}`);
console.log(`unique edges  : ${edgeCount}`);
console.log(`flagged edges : ${flagged}`);
console.log(`duplicate edges: ${dupes}`);
console.log(`isolated nodes: ${(g._meta?.isolated ?? []).join(', ') || '(none)'}`);
if (report.length) console.log(report.join('\n'));
else console.log('\nAll edges satisfy the taxonomy. Nothing to correct. ✓');

const clean = flagged === 0 && dupes === 0 && (g._meta?.isolated?.length ?? 0) === 0;
console.log(`\n${clean ? 'PASS' : 'INCOMPLETE'} — ${flagged} flagged, ${dupes} duplicates, ${(g._meta?.isolated?.length ?? 0)} isolated.`);
