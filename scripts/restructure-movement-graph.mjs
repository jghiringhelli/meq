// Restructure the hand-transcribed movement graph into a region-ordered,
// node-grouped, single-direction (symmetric) shape that is easy to hand-correct
// region by region. Normalizes fields per the board taxonomy and annotates each
// edge with taxonomy flags. Does NOT touch adjacency.json (the engine's loader).
//
// Taxonomy (authoritative, from the user):
//  · cost is 1..4. cost 1  <=> NO terrain type (always one card).
//                  cost >=2 <=> exactly ONE of {woods,swamp,mountain,plains,hill}.
//  · horse applies iff the edge is NOT a boat edge (fully derived => not stored).
//  · edges are symmetric: each stored once, under the earlier (region,node).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');

// Source is the original v2 hand-transcription. Prefer the backup so this script
// is idempotent even after it has overwritten movement-graph.json with v3.
const bak = join(assets, 'movement-graph.v2.bak.json');
const cur = join(assets, 'movement-graph.json');
const graph = JSON.parse(readFileSync(existsSync(bak) ? bak : cur, 'utf8'));
if (graph.schema && graph.schema.startsWith('movement-graph-v3')) {
  console.error('Source is already v3 and no v2 backup exists — refusing to run.');
  process.exit(1);
}
const locData = JSON.parse(readFileSync(join(assets, 'locations.json'), 'utf8'));
const locations = locData.locations ?? locData;

const TERRAINS = ['woods', 'swamp', 'mountain', 'plains', 'hill'];

// Geographic west -> east/south region order; havens (scattered cities) last.
const REGION_ORDER = [
  'eriador-and-enedwaith',
  'rhudaur-and-grey-mountains',
  'mist-mountains-and-mirkwood',
  'rohan-and-gondor',
  'mordor-and-brown-lands',
  'haven',
];

const nameOf = {}, regionOf = {}, nodeOrder = {};
// Canonical region display names (locations.json has some mismatched regionName
// values per regionId — a separate data bug; we key strictly off regionId here).
const regionNameOf = {
  'eriador-and-enedwaith': 'Eriador and Enedwaith',
  'rhudaur-and-grey-mountains': 'Rhudaur and Grey Mountains',
  'mist-mountains-and-mirkwood': 'Mist Mountains and Mirkwood',
  'rohan-and-gondor': 'Rohan and Gondor',
  'mordor-and-brown-lands': 'Mordor and Brown Lands',
  'haven': 'Haven',
};
for (const l of locations) {
  nameOf[l.id] = l.name;
  regionOf[l.id] = l.regionId;
  (nodeOrder[l.regionId] ??= []).push(l.id);
}

// Global rank for "earlier (region,node)" placement.
const rank = {};
let r = 0;
for (const rid of REGION_ORDER) for (const id of (nodeOrder[rid] ?? [])) rank[id] = r++;

function normTerrain(t) {
  const v = (t ?? '').trim().toLowerCase();
  if (v === 'forest') return 'woods'; // board icon is "woods"
  return v;
}

// --- Dedupe symmetric edges, keeping one record per unordered pair ---
const byPair = new Map();
for (const e of graph.edges) {
  const a = e.a, b = e.b;
  if (rank[a] == null || rank[b] == null) {
    console.warn('  ! edge endpoint not in locations:', a, b);
  }
  const key = [a, b].sort().join('|');
  const rec = {
    a, b,
    cost: e.anyCost ?? null,
    terrain: normTerrain(e.terrain),
    boat: !!e.boat,
    confidence: e.confidence ?? null,
  };
  if (!byPair.has(key)) byPair.set(key, rec);
  else {
    // Merge a duplicated reverse edge; note any conflicting attributes.
    const prev = byPair.get(key);
    const conflicts = [];
    if ((prev.cost ?? null) !== (rec.cost ?? null)) conflicts.push(`cost ${prev.cost} vs ${rec.cost}`);
    if (prev.terrain !== rec.terrain) conflicts.push(`terrain ${prev.terrain || 'any'} vs ${rec.terrain || 'any'}`);
    if (prev.boat !== rec.boat) conflicts.push(`boat ${prev.boat} vs ${rec.boat}`);
    if (conflicts.length) (prev._conflict ??= []).push(...conflicts);
  }
}

function flagsFor(e) {
  const f = [];
  if (e.cost == null) f.push('missing-cost');
  else if (e.cost < 1 || e.cost > 4) f.push(`cost-out-of-range(${e.cost})`);
  else if (e.cost === 1 && e.terrain) f.push(`cost1-should-have-no-terrain(has ${e.terrain})`);
  else if (e.cost >= 2 && !e.terrain) f.push('cost>=2-needs-terrain');
  if (e.terrain && !TERRAINS.includes(e.terrain)) f.push(`invalid-terrain(${e.terrain})`);
  if (e._conflict) f.push('reverse-edge-conflict:' + e._conflict.join('; '));
  return f;
}

// --- Assign each edge under its earlier endpoint, grouped by region -> node ---
const regions = {};
for (const rid of REGION_ORDER) {
  regions[rid] = { regionName: regionNameOf[rid] ?? rid, nodes: {} };
  for (const id of (nodeOrder[rid] ?? [])) {
    regions[rid].nodes[id] = { name: nameOf[id], edges: [] };
  }
}

for (const rec of byPair.values()) {
  const owner = rank[rec.a] <= rank[rec.b] ? rec.a : rec.b;
  const other = owner === rec.a ? rec.b : rec.a;
  const rid = regionOf[owner];
  if (!regions[rid]) continue;
  const edge = {
    to: other,
    toName: nameOf[other] ?? other,
    toRegion: regionOf[other] === rid ? undefined : regionOf[other],
    cost: rec.cost,
    terrain: rec.terrain || '',
    boat: rec.boat,
    horse: !rec.boat,            // derived, shown for reviewer convenience
    confidence: rec.confidence,
  };
  const flags = flagsFor(rec);
  if (flags.length) edge._flags = flags;
  // drop undefined toRegion for same-region edges
  if (edge.toRegion === undefined) delete edge.toRegion;
  regions[rid].nodes[owner].edges.push(edge);
}

// Sort each node's edges by the neighbor's global rank (stable, review-friendly).
for (const rid of REGION_ORDER)
  for (const id of Object.keys(regions[rid].nodes))
    regions[rid].nodes[id].edges.sort((x, y) => (rank[x.to] ?? 1e9) - (rank[y.to] ?? 1e9));

// Isolated nodes (no owned edge AND never referenced as a neighbor).
const referenced = new Set();
for (const rid of REGION_ORDER)
  for (const id of Object.keys(regions[rid].nodes))
    for (const e of regions[rid].nodes[id].edges) { referenced.add(id); referenced.add(e.to); }
const isolated = Object.keys(rank).filter((id) => !referenced.has(id));

const out = {
  schema: 'movement-graph-v3-review',
  _meta: {
    rule: graph._meta?.rule,
    taxonomy: [
      'cost is an integer 1..4.',
      "cost 1  => terrain '' (no type); it always costs one card.",
      'cost >=2 => exactly one terrain of woods|swamp|mountain|plains|hill.',
      'horse applies iff NOT a boat edge (derived; horse = !boat).',
      'edges are symmetric: each stored once, under the earlier (region, node).',
      'the map background usually matches the terrain type; the icon is consistent.',
    ],
    howToCorrect: 'Walk region by region, node by node. Same-region edges are listed under the earlier node; cross-region edges under the earlier region\'s node (see toRegion). Fix any edge carrying _flags. Run scripts/verify-movement-graph.mjs for the worklist.',
    regionOrder: REGION_ORDER,
    edgeCount: byPair.size,
    isolated,
    provenance: graph._meta?.provenance,
  },
  regions,
};

writeFileSync(join(assets, 'movement-graph.v2.bak.json'), JSON.stringify(graph, null, 2));
writeFileSync(join(assets, 'movement-graph.json'), JSON.stringify(out, null, 2));
console.log(`Restructured ${byPair.size} unique edges across ${REGION_ORDER.length} regions.`);
console.log(`Backup written to assets/movement-graph.v2.bak.json`);
console.log(`Isolated nodes: ${isolated.join(', ') || '(none)'}`);
