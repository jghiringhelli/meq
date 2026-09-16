import { useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, GameState } from '../engine/types';
import { STORY_FINALE } from '../engine/types';
import { reserveMinions } from '../engine/sauronPlay';
import { characterArt, minionArt, heroArt, token, plotArt, monsterArt, shadowPoolArt } from '../data/art';
import { useInspect, type InspectPayload } from './CardInspector';

interface Props {
  state: GameState; cat: Catalog;
  moveTargets: string[];
  onMove?: (to: string) => void;
  /** Characters at the active hero's location who can be consulted this turn
   *  (matches econ.characters in App.tsx) — clicking their board token opens a
   *  favor/ability choice instead of just showing info. */
  consultable?: string[];
  consultDisabled?: boolean;
  onConsult?: (character: string, choice: 'favor' | 'ability') => void;
}

const TERRAIN_COLOR: Record<string, string> = {
  woods: '#7dc86a', swamp: '#c9d15a', mountain: '#d9d9d9',
  plains: '#f0cf6a', hill: '#e08a4a', '': '#aaa',
};

// Region-pair colours for facedown monster-token backs (heroes see only the
// square region token, never the monster's identity until combat reveals it).
const REGION_COLOR: Record<string, string> = {
  Orange: '#d2691e', Yellow: '#d9b32b', Purple: '#7d3ca0',
  Grey: '#8a8a8a', Green: '#3a9d4a', Red: '#b23b3b', Blue: '#3a6ea5',
};

// Per-token outline colors so figures read clearly against the board art:
// red = Sauron minions, orange = monster tokens, white = allies/characters,
// and each hero gets its own signature color.
const MINION_BORDER = '#e02424';
const MONSTER_BORDER = '#f08a1e';
const ALLY_BORDER = '#f5f5f5';
const HERO_COLOR: Record<string, string> = {
  thalin: '#3fa7ff', argalad: '#4ad07a', eleanor: '#c86ad0',
  eometh: '#e8c23a', beravor: '#d0503a',
};
const heroColor = (id: string) => HERO_COLOR[id] ?? '#e8dcc0';
const pretty = (id: string) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const CAL = false; // calibration: show a dot at every node centre
const MIN_ZOOM = 1, MAX_ZOOM = 5;

// "Turn Reference" phase highlight. The board art (top-left parchment) prints
// the turn sequence; we light the line(s) matching the current engine phase so
// the player always sees "you are here". The printed order famously has a step
// out of place vs. the manual, so we map by MEANING (not printed position):
// each engine phase points at the y-band(s) of the line(s) it represents on the
// reference art (measured in reference-image pixels, then scaled to the board).
const TR_REF_W = 6112, TR_REF_H = 4203;
const TR_BANDS: Record<string, [number, number][]> = {
  // Heroes ready & rest — the "Hero Rally Step" and the hero-turn "Rest Step".
  HeroRefresh: [[805, 841], [1063, 1099]],
  // Ambush → Travel (Move / Combat-Peril / Explore) → Encounter, plus the free
  // Exploring actions (Retrieve Favor … Discard Plots): one contiguous block.
  HeroActions: [[1100, 1570]],
  SauronRefresh: [[839, 875]],   // Story Step
  SauronEvents: [[877, 947]],    // Plot Step + Event Step
  SauronMinions: [[948, 984]],   // Action Step
  StoryAdvance: [[992, 1028]],   // Hero Draw Step (end-of-turn housekeeping)
};

interface Chip { key: string; art: string; border: string; count: number; label: string; fill: string; init: string; fit?: 'meet' | 'slice'; facedown?: boolean; tip?: string; inspect?: InspectPayload; }

export default function Board({ state, cat, moveTargets, onMove, consultable, consultDisabled, onConsult }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const inspect = useInspect();
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const locs = Object.values(cat.locations);
  const { width: w, height: h, image } = cat.board;
  const targetSet = new Set(moveTargets);

  // Distance to the nearest other node — drives per-node token scale so a
  // location's figures never spill into its neighbours' circles.
  const nn = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of locs) {
      let best = Infinity;
      for (const b of locs) {
        if (a.id === b.id) continue;
        const d = Math.hypot(a.coords.x - b.coords.x, a.coords.y - b.coords.y);
        if (d < best) best = d;
      }
      m[a.id] = Number.isFinite(best) ? best : 400;
    }
    return m;
  }, [locs]);

  // All figures occupying a location, in draw priority (heroes first).
  const buildFigs = (lid: string): Chip[] => {
    const figs: Chip[] = [];
    const heroes = state.map.heroesAt[lid] ?? [];
    if (heroes.length) {
      const h0 = cat.heroes[heroes[0]!];
      const h0State = state.heroes.find((h) => h.id === heroes[0]);
      const bonusTxt = (key: 'fortitude' | 'strength' | 'agility' | 'wisdom') => {
        const b = h0State?.statBonus?.[key] ?? 0;
        return b ? `+${b}` : '';
      };
      figs.push({
        key: 'hero', art: heroArt(heroes[0]!).figure, border: heroColor(heroes[0]!),
        count: heroes.length, label: heroes.map((id) => cat.heroes[id].name).join(', '),
        fill: '#22406e', init: heroes.map((id) => cat.heroes[id].name[0]).join(''), fit: 'meet',
        tip: h0 ? `${h0.name}\nFortitude ${h0.fortitude}${bonusTxt('fortitude')} · Strength ${h0.strength}${bonusTxt('strength')} · Agility ${h0.agility}${bonusTxt('agility')} · Wisdom ${h0.wisdom}${bonusTxt('wisdom')}\n${h0.abilityName}: ${h0.abilityText}` : undefined,
        inspect: h0 ? { title: h0.name, img: heroArt(h0.id).portrait || heroArt(h0.id).figure,
          subtitle: `Hero · Fort ${h0.fortitude}${bonusTxt('fortitude')} · Str ${h0.strength}${bonusTxt('strength')} · Agi ${h0.agility}${bonusTxt('agility')} · Wis ${h0.wisdom}${bonusTxt('wisdom')}`,
          lines: [`${h0.abilityName}`], text: h0.abilityText } : undefined,
      });
    }
    for (const mid of state.map.minionsAt?.[lid] ?? []) {
      const m = cat.minions[mid];
      const hp = state.map.minionHealth?.[mid] ?? m?.health;
      figs.push({ key: 'min' + mid, art: m ? minionArt(m.image) : '', border: MINION_BORDER, count: 1,
        label: m?.name ?? mid, fill: '#7a2020', init: (m?.name ?? '?')[0],
        tip: m ? `${m.name} (elite minion)\nHealth ${hp}/${m.health} · Fortitude ${m.fortitude} · Strength ${m.strength} · Wisdom ${m.wisdom}\n${m.ability}` : undefined,
        inspect: m ? { title: m.name, img: minionArt(m.image),
          subtitle: `Minion · Health ${hp}/${m.health} · Fort ${m.fortitude} · Str ${m.strength} · Wis ${m.wisdom}`,
          text: m.ability } : undefined });
    }
    const monCount: Record<string, number> = {};
    for (const id of state.map.monstersAt[lid] ?? []) monCount[id] = (monCount[id] ?? 0) + 1;
    // Monster tokens are placed facedown: heroes see only the square region-pair
    // token back, never which monster it is — UNLESS revealed (combat, Argalad's
    // Survivalist, or an "examine tokens" effect). Sauron always sees every face.
    const regionFill = REGION_COLOR[cat.locations[lid]?.regionColor] ?? '#6a4a2a';
    const revealed = state.humanSide === 'Sauron' || (state.map.revealedMonstersAt ?? []).includes(lid);
    for (const [id, c] of Object.entries(monCount)) {
      const mon = cat.monsters[id];
      figs.push({ key: 'mon' + id, art: revealed ? monsterArt(id) : '', border: MONSTER_BORDER, count: c,
        label: revealed ? (mon?.name ?? id) : 'Monster token', fill: regionFill,
        init: revealed ? (mon?.name ?? '?')[0] : '', facedown: !revealed,
        tip: revealed && mon
          ? `${mon.name}${c > 1 ? ` ×${c}` : ''}\nFortitude ${mon.fortitude} · Strength ${mon.strength} · Wisdom ${mon.wisdom}\n${mon.ability}`
          : 'Facedown monster token — hidden until combat or a reveal effect (Argalad’s Survivalist).',
        inspect: revealed && mon ? { title: mon.name, img: monsterArt(id),
          subtitle: `Monster · Fort ${mon.fortitude} · Str ${mon.strength} · Wis ${mon.wisdom}`,
          text: mon.ability } : undefined });
    }
    // False-rumor (blank) tokens are placed facedown too: to a hero they are
    // indistinguishable from a real monster token (the bluff); Sauron knows.
    const rumorCount = state.map.rumorsAt?.[lid] ?? 0;
    if (rumorCount > 0) {
      figs.push({ key: 'rumor', art: '', border: MONSTER_BORDER, count: rumorCount,
        label: revealed ? 'False rumor' : 'Monster token', fill: regionFill,
        init: '', facedown: true,
        tip: revealed
          ? 'False rumor — a blank token placed as a bluff (no monster). It is discarded if flipped in combat.'
          : 'Facedown monster token — hidden until combat or a reveal effect (Argalad’s Survivalist).' });
    }
    for (const cid of state.map.charactersAt?.[lid] ?? []) {
      const canConsult = !!onConsult && (consultable ?? []).includes(cid) && !consultDisabled;
      figs.push({
        key: 'chr' + cid, art: characterArt(cid), border: ALLY_BORDER, count: 1,
        label: pretty(cid), fill: '#4a7ea0', init: pretty(cid)[0], fit: 'meet',
        tip: canConsult ? `${pretty(cid)} — click to consult (favor or recruit as ally)` : pretty(cid),
        inspect: {
          title: pretty(cid), img: characterArt(cid), subtitle: 'Character',
          text: canConsult
            ? 'Consult this character: gain 2 favor, or recruit them as an ally (their ability).'
            : undefined,
          actions: canConsult ? [
            { label: '✦✦ Gain 2 favor', onClick: () => onConsult!(cid, 'favor') },
            { label: '→ Recruit ability', onClick: () => onConsult!(cid, 'ability') },
          ] : undefined,
        },
      });
    }
    return figs;
  };

  // Info payload for a location — every named node is inspectable (region,
  // type, current influence/favor/occupants) so the whole map reads like the
  // physical board's reference.
  const locInfo = (l: (typeof locs)[number]): InspectPayload => {
    const inf = state.sauron.locationInfluence?.[l.id] ?? 0;
    const fav = state.map.favorAt?.[l.id] ?? 0;
    const heroesHere = (state.map.heroesAt?.[l.id] ?? []).map((h) => cat.heroes[h]?.name ?? h);
    const lines = [`Region: ${l.regionName ?? l.regionColor} (${l.regionColor})`, `Type: ${l.kind}`];
    if (inf) lines.push(`Sauron influence: ${inf}`);
    if (fav) lines.push(`Favor tokens: ${fav}`);
    if (heroesHere.length) lines.push(`Heroes here: ${heroesHere.join(', ')}`);
    const enc = l.kind === 'haven' ? 'Haven' : (l.regionName ?? l.regionColor);
    if (enc) lines.push(`Encounter deck: ${enc}`);
    return { title: l.name, subtitle: `${l.regionName ?? l.regionColor} · ${l.kind}`, lines };
  };

  // Visible viewport size expressed in board (viewBox) units. Because the board
  // is fit with preserveAspectRatio="meet", one axis is letterboxed, so the
  // visible area is LARGER than w×h on that axis — we must account for it or the
  // clamp stops the board short of (or past) the true viewport edge.
  const viewport = () => {
    const svg = svgRef.current;
    const cw = svg?.clientWidth || w, ch = svg?.clientHeight || h;
    const f = Math.min(cw / w, ch / h) || 1; // viewBox → client px scale
    return { f, Vw: cw / f, Vh: ch / f };
  };
  const clampPan = (z: number, x: number, y: number) => {
    const { Vw, Vh } = viewport();
    // Lock each board edge flush to the viewport: never reveal empty background,
    // and when the board is smaller than the viewport on an axis, keep centered.
    const maxX = Math.max(0, (w * z - Vw) / 2), maxY = Math.max(0, (h * z - Vh) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };
  // Zoom on wheel, centred on the cursor. Attached as a NATIVE non-passive
  // listener: React's synthetic onWheel is passive, so there e.preventDefault()
  // is ignored and the browser zooms/scrolls the whole PAGE instead of the map.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const ctm = svg.getScreenCTM();
      const pt = ctm ? new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse()) : null;
      setView((v) => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (!pt) return { z, ...clampPan(z, v.x, v.y) };
        // Keep the board point under the cursor fixed while zooming.
        const A = pt.x - w / 2, B = pt.y - h / 2;
        const x = A - (z / v.z) * (A - v.x);
        const y = B - (z / v.z) * (B - v.y);
        return { z, ...clampPan(z, x, y) };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h]);
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y, moved: false };
    // Do NOT setPointerCapture here: capturing on pointer-down retargets the
    // following `click` to the <svg>, so child on-map handlers (a node's Travel
    // click, a deck pile opening its reference) never fire. Capture only once a
    // real DRAG begins (in onPointerMove), which keeps plain clicks intact.
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { f } = viewport();
    const scale = 1 / f; // client px → viewBox units (uniform under "meet")
    const dx = (e.clientX - d.x) * scale, dy = (e.clientY - d.y) * scale;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      d.moved = true;
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (d.moved) setView((v) => ({ z: v.z, ...clampPan(v.z, d.ox + dx, d.oy + dy) }));
  };
  const endDrag = () => { setTimeout(() => { drag.current = null; }, 0); };
  const reset = () => setView({ z: 1, x: 0, y: 0 });

  // One chip (figure token) rendered as a rounded art tile with a colored border.
  const renderChip = (c: Chip, cx: number, cy: number, T: number, s: number) => (
    <g key={c.key} transform={`translate(${cx},${cy})`}
      style={{ cursor: c.inspect ? 'help' : undefined }}
      onClick={c.inspect ? (e) => { e.stopPropagation(); inspect(c.inspect!); } : undefined}>
      {c.tip && <title>{c.tip}</title>}
      {c.art
        ? <image href={c.art} x={-T / 2} y={-T / 2} width={T} height={T} preserveAspectRatio={c.fit === 'meet' ? 'xMidYMid meet' : 'xMidYMid slice'}
            style={{ clipPath: `inset(0 round ${T * 0.18}px)` }} />
        : <><rect x={-T / 2} y={-T / 2} width={T} height={T} rx={T * 0.18} fill={c.fill} />
            {c.facedown
              ? <rect x={-T * 0.28} y={-T * 0.28} width={T * 0.56} height={T * 0.56} rx={T * 0.1} fill="#1a1012" opacity={0.55} />
              : <text y={T * 0.16} textAnchor="middle" fontSize={T * 0.5} fontWeight={700} fill="#f0e2c0">{c.init}</text>}</>}
      <rect x={-T / 2} y={-T / 2} width={T} height={T} rx={T * 0.18} fill="none" stroke={c.border} strokeWidth={Math.max(2, 3.5 * s)} />
      {c.count > 1 && (
        <g transform={`translate(${T / 2 - 3},${T / 2 - 3})`}>
          <circle r={T * 0.24} fill="#141014" stroke={c.border} strokeWidth={Math.max(1.5, 2 * s)} />
          <text y={T * 0.09} textAnchor="middle" fontSize={T * 0.32} fontWeight={700} fill="#f0e2c0">{c.count}</text>
        </g>
      )}
    </g>
  );

  return (
    <div className="board-wrap" data-testid="board">
      <div className="board-controls">
        <button onClick={() => setView((v) => ({ z: Math.min(MAX_ZOOM, v.z * 1.2), ...clampPan(Math.min(MAX_ZOOM, v.z * 1.2), v.x, v.y) }))}>＋</button>
        <button onClick={() => setView((v) => ({ z: Math.max(MIN_ZOOM, v.z / 1.2), ...clampPan(Math.max(MIN_ZOOM, v.z / 1.2), v.x, v.y) }))}>－</button>
        <button onClick={reset} title="Reset view">⟲</button>
      </div>
      <svg ref={svgRef} className="board" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={endDrag} onPointerLeave={endDrag}
        style={{ cursor: drag.current ? 'grabbing' : 'grab' }}>
        <g transform={`translate(${w / 2 + view.x} ${h / 2 + view.y}) scale(${view.z}) translate(${-w / 2} ${-h / 2})`}>
        {image && <image href={image} x={0} y={0} width={w} height={h} />}
        {image && (() => {
          const bands = TR_BANDS[state.phase];
          if (!bands) return null;
          const sx = w / TR_REF_W, sy = h / TR_REF_H;
          const x = 108 * sx, bw = 356 * sx;
          return (
            <g pointerEvents="none">
              {bands.map(([y0b, y1b], i) => (
                <rect key={'trhl' + i} x={x} y={y0b * sy} width={bw} height={(y1b - y0b) * sy}
                  rx={10 * sx} fill="#ffd970" fillOpacity={0.20}
                  stroke="#ffd970" strokeOpacity={0.85} strokeWidth={5 * sx} />
              ))}
            </g>
          );
        })()}

        {cat.edges.map((e, i) => {
          const a = cat.locations[e.a].coords, b = cat.locations[e.b].coords;
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={TERRAIN_COLOR[e.terrain] ?? '#aaa'} strokeWidth={6}
              strokeOpacity={0.35} strokeDasharray="14 12" strokeLinecap="round" />
          );
        })}

        {locs.map((l) => {
          const favor = state.map.favorAt?.[l.id] ?? 0;
          const influence = state.sauron.locationInfluence?.[l.id] ?? 0;
          // Influence intensity: 4 red bands — 1 lightest … 4 (values 4–6+)
          // super-intense, almost black. White number on the red badge.
          const infLevel = influence <= 0 ? 0 : Math.min(4, influence);
          const infColor = ['', '#e0574a', '#b8342a', '#7a1414', '#2e0606'][infLevel];
          const isTarget = targetSet.has(l.id);
          const isHover = hover === l.id;
          const regionCol = REGION_COLOR[l.regionColor] ?? '#c9a24a';
          const questHeroes = state.map.questAt?.[l.id] ?? [];
          const eventPlotsHere = (state.sauron.activeEventPlots ?? []).filter((m) => m.location === l.id);
          const figs = buildFigs(l.id);

          // Adaptive geometry: cell = half the distance to nearest neighbour,
          // so tokens grow in open country and shrink where nodes are packed.
          const cell = Math.min(nn[l.id] * 0.5, 210);
          const s = clamp(cell / 140, 0.7, 1.4);
          // Circles printed on the board art are all the SAME size, so the
          // highlight/hit ring uses a FIXED board-pixel radius measured off the
          // art (~90px to the inner edge of the printed colour ring) instead of
          // scaling with neighbour spacing.
          const rr = 90;
          const T = clamp(72 * s, 46, 104);
          const gap = 6 * s;

          // How many chips fit within the cell before we collapse to a "+n" tile.
          const maxFit = Math.max(1, Math.floor((cell * 2) / (T + gap)));
          const cap = Math.min(maxFit, 5);
          const overflow = figs.length > cap ? figs.length - (cap - 1) : 0;
          const shown = overflow ? figs.slice(0, cap - 1) : figs;
          const nTiles = shown.length + (overflow ? 1 : 0);
          const totalW = nTiles > 0 ? nTiles * T + (nTiles - 1) * gap : 0;
          const startX = -totalW / 2 + T / 2;

          return (
            <g key={l.id} transform={`translate(${l.coords.x},${l.coords.y})`}
              className={isTarget ? 'node target' : 'node'}
              onMouseEnter={() => setHover(l.id)} onMouseLeave={() => setHover(null)}
              onClick={() => {
                if (drag.current?.moved) return;
                if (isTarget) onMove?.(l.id);
                else inspect(locInfo(l));
              }}
              style={{ cursor: 'pointer' }}>

              {/* Lit ring: a legal move target (or a hovered node) is ringed in
                  its REGION colour ENTIRELY OUTSIDE the printed circle, so the
                  highlight never covers the location's name banner or art. A
                  soft wide glow sits behind a crisp ring; targets gently pulse. */}
              {(isTarget || isHover) && (() => {
                const rG = rr + 24; // just outside the printed circle's outer ring
                return (
                  <g pointerEvents="none">
                    <circle r={rG} fill="none" stroke={regionCol}
                      strokeWidth={isTarget ? 24 : 16} strokeOpacity={isTarget ? 0.22 : 0.13}>
                      {isTarget && <animate attributeName="stroke-opacity" values="0.28;0.10;0.28" dur="1.7s" repeatCount="indefinite" />}
                    </circle>
                    <circle r={rG} fill="none" stroke={regionCol}
                      strokeWidth={isTarget ? 7 : 5} strokeOpacity={isTarget ? 0.95 : 0.7}>
                      {isTarget && <animate attributeName="r" values={`${rG - 2};${rG + 3};${rG - 2}`} dur="1.7s" repeatCount="indefinite" />}
                    </circle>
                  </g>
                );
              })()}
              {influence > 0 && <circle r={rr + 2} fill={infColor} fillOpacity={0.10 + infLevel * 0.07} stroke={infColor} strokeWidth={4} strokeOpacity={0.35 + infLevel * 0.14} />}
              {CAL && <circle r={10} fill="#ff2d2d" stroke="#000" strokeWidth={2} />}

              {/* figure cluster, centered on the node */}
              {shown.map((c, i) => renderChip(c, startX + i * (T + gap), 0, T, s))}
              {overflow > 0 && (() => {
                const cx = startX + shown.length * (T + gap);
                return (
                  <g transform={`translate(${cx},0)`}>
                    <rect x={-T / 2} y={-T / 2} width={T} height={T} rx={T * 0.18} fill="#141014" stroke="#c8b890" strokeWidth={Math.max(2, 3 * s)} />
                    <text y={T * 0.16} textAnchor="middle" fontSize={T * 0.4} fontWeight={700} fill="#f0e2c0">+{overflow}</text>
                  </g>
                );
              })()}

              {/* influence badge (top-left): white number on the red band */}
              {influence > 0 && (
                <g transform={`translate(${-(rr - 2)},${-(rr - 2)})`}>
                  <circle r={13 * s} fill={infColor} stroke="#1a0303" strokeWidth={3 * s} />
                  <text y={5 * s} textAnchor="middle" fontSize={17 * s} fontWeight={700} fill="#ffffff">{influence}</text>
                </g>
              )}

              {/* hero Quest marker (top-right): a small portrait of the hero(es)
                  whose Starting/Advanced quest objective is here */}
              {questHeroes.length > 0 && (() => {
                const qx = rr - 2, qy = -(rr - 2), r = 14 * s;
                const first = questHeroes[0];
                const face = heroArt(first)?.figure;
                const extra = questHeroes.length - 1;
                return (
                  <g transform={`translate(${qx},${qy})`}>
                    <title>{`Quest objective: ${questHeroes.map((h) => cat.heroes[h]?.name ?? h).join(', ')}`}</title>
                    {/* easily-visible pulsing glow so the objective stands out */}
                    <circle r={r + 9 * s} fill="#7dffa0" fillOpacity={0.22} stroke="#7dffa0" strokeWidth={3 * s} strokeOpacity={0.85}>
                      <animate attributeName="r" values={`${r + 6 * s};${r + 12 * s};${r + 6 * s}`} dur="1.6s" repeatCount="indefinite" />
                      <animate attributeName="stroke-opacity" values="0.9;0.3;0.9" dur="1.6s" repeatCount="indefinite" />
                    </circle>
                    <circle r={r + 2 * s} fill="#1e6b2e" stroke="#8fe6a0" strokeWidth={3 * s} />
                    {face
                      ? <image href={face} x={-r} y={-r} width={r * 2} height={r * 2}
                          preserveAspectRatio="xMidYMid slice" style={{ clipPath: 'inset(0 round 50%)' }} />
                      : <text y={5 * s} textAnchor="middle" fontSize={15 * s} fontWeight={700} fill="#eafaea">
                          {(cat.heroes[first]?.name ?? first)[0]}</text>}
                    <circle r={r} fill="none" stroke={heroColor(first)} strokeWidth={3 * s} />
                    {extra > 0 && (
                      <g transform={`translate(${r * 0.7},${r * 0.7})`}>
                        <circle r={9 * s} fill="#1e6b2e" stroke="#8fe6a0" strokeWidth={2 * s} />
                        <text y={4 * s} textAnchor="middle" fontSize={12 * s} fontWeight={700} fill="#eafaea">+{extra}</text>
                      </g>
                    )}
                  </g>
                );
              })()}

              {/* active event marker (bottom-right, green): an event-deck plot
                  sits here — a hero can Explore this location to discard it */}
              {eventPlotsHere.length > 0 && (() => {
                const ex = rr - 2, ey = rr - 2, r = 13 * s;
                const plot = cat.plots.find((p) => p.id === eventPlotsHere[0].eventId);
                return (
                  <g transform={`translate(${ex},${ey})`}>
                    <title>{`Active event: ${plot?.name ?? eventPlotsHere[0].eventId}\n${plot?.effect ?? ''}\n(Explore here to discard)`}</title>
                    <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={3 * s} transform="rotate(45)"
                      fill="#1e6b2e" stroke="#8fe6a0" strokeWidth={3 * s} />
                    <text y={5 * s} textAnchor="middle" fontSize={15 * s} fontWeight={700} fill="#eafaea">!</text>
                  </g>
                );
              })()}

              {/* favor badge (bottom-left, mirroring the top-left influence badge) */}
              {favor > 0 && (() => {
                const art = token('favor');
                const fx = -(rr - 2), fy = rr - 2;
                return art
                  ? <image href={art} x={fx - 16 * s} y={fy - 16 * s} width={32 * s} height={32 * s} />
                  : <g transform={`translate(${fx},${fy})`}><circle r={13 * s} fill="#d8b24a" stroke="#5a4410" strokeWidth={3 * s} /><text y={7 * s} textAnchor="middle" fontSize={18 * s} fontWeight={700} fill="#3a2c08">{favor}</text></g>;
              })()}

              {/* active Sauron plot marker (red numbered token): a plot on the
                  tower is anchored to this location — placed top-centre, above
                  the node, its number matching the plot's tower slot (1–3). */}
              {(() => {
                const pidx = (state.sauron.activePlots ?? []).findIndex((m) => m.location === l.id);
                if (pidx < 0) return null;
                const pm = (state.sauron.activePlots ?? [])[pidx];
                const plot = cat.plots.find((p) => p.id === pm.eventId);
                const img = token('plotMarker' + (pidx + 1));
                const w = 40 * s, my = -(rr + 14 * s);
                return (
                  <g transform={`translate(0,${my})`} style={{ cursor: 'help' }}>
                    <title>{`Active plot ${pidx + 1}: ${plot?.name ?? pm.eventId}\n${plot?.affectsText ?? ''}`}</title>
                    {img
                      ? <image href={img} x={-w / 2} y={-w / 2} width={w} height={w} preserveAspectRatio="xMidYMid meet" />
                      : (<g><circle r={15 * s} fill="#7a0f0f" stroke="#e8b0a0" strokeWidth={3 * s} />
                          <text y={6 * s} textAnchor="middle" fontSize={17 * s} fontWeight={700} fill="#ffe8e0">{pidx + 1}</text></g>)}
                  </g>
                );
              })()}

              {/* name label — HOVER-ONLY (rulebook feel: the board stays clean) */}
              {isHover && (() => {
                const fs = Math.max(16, 22 * s);
                const ly = -(T / 2 + 12 * s);
                return (
                  <g transform={`translate(0,${ly})`} pointerEvents="none">
                    <rect x={-(l.name.length * fs * 0.42 + 14) / 2} y={-fs - 8} width={l.name.length * fs * 0.42 + 14} height={fs + 12}
                      rx={7} fill="#1a120b" stroke="#6b5a3a" strokeWidth={2} opacity={0.95} />
                    <text x={0} y={-6} textAnchor="middle" fontSize={fs} fill="#f0e2c0">{l.name}</text>
                  </g>
                );
              })()}

              {/* Travel hit overlay: when this node is a legal move target, a
                  transparent disc on TOP of any tokens captures the click for the
                  move — otherwise a monster/influence chip's inspect handler
                  (which stops propagation) would swallow it and the hero could
                  never travel here. Drawn last so it wins the hit test. */}
              {isTarget && onMove && (
                <circle r={rr} fill="transparent" style={{ cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) onMove(l.id); }}>
                  <title>{`Travel to ${l.name}`}</title>
                </circle>
              )}
            </g>
          );
        })}

        {/* On-map deck piles: the printed deck spaces on the board art are
            clickable, opening the same reference almanac reached from the top
            Reference bar. Left column = the six regional Encounter decks; the
            Dark Tower = the Plot deck; the Shadow Pool box = Shadow cards.
            (Drawn before the tower so active plot cards keep their own hover.) */}
        {(() => {
          const openRef = (key: string) => window.dispatchEvent(new CustomEvent('meq-open-ref', { detail: key }));
          // The left column holds the six regional Encounter decks, stacked
          // top-to-bottom in this fixed printed order (identified by their card
          // back gem colours). Each slot opens that region's sub-tab directly.
          const encOrder = [
            'Haven',
            'Eriador and Enedwaith',
            'Rhudaur and Grey Mountains',
            'Mist Mountains and Mirkwood',
            'Rohan and Gondor',
            'Mordor and Brown Lands',
          ];
          const encTop = 1690, encH = 2320, bandH = encH / encOrder.length;
          const piles: { key: string; x: number; y: number; w: number; h: number; label: string }[] = [
            ...encOrder.map((region, i) => ({
              key: `encounters:${region}`, x: 70, y: Math.round(encTop + bandH * i),
              w: 500, h: Math.round(bandH), label: `${region} encounters`,
            })),
            // The Plot *deck* (the face-down draw pile) has no numbered slot of
            // its own on the printed board — physically it sits loose above the
            // tower's 3 numbered active-plot slots. Its hotspot is kept to that
            // small area only, so it doesn't overlap/shadow the 3 slots below
            // (each of which handles its own click — see the plot-track block).
            { key: 'plots', x: 5430, y: 330, w: 220, h: 260, label: 'Plot deck' },
            { key: 'shadow', x: 5175, y: 3638, w: 810, h: 517, label: 'Shadow Pool' },
          ];
          return (
            <g>
              {piles.map((p) => (
                <rect key={'pile' + p.key} x={p.x} y={p.y} width={p.w} height={p.h} rx={16}
                  fill="transparent" style={{ cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); openRef(p.key); }}>
                  <title>{`${p.label} — click to open the ${p.key} reference`}</title>
                </rect>
              ))}
              {/* A small always-visible card-back + count badge marks the Plot
                  deck's dedicated spot (above the 3 numbered slots), so it
                  reads as "the deck lives here" rather than an invisible
                  hotspot a player has to discover by accident. */}
              {(() => {
                const n = state.sauron.plotDeck?.length ?? 0;
                const bx = 5430 + 220 / 2, by = 330 + 260 / 2;
                return (
                  <g pointerEvents="none">
                    <rect x={bx - 60} y={by - 40} width={120} height={80} rx={8}
                      fill="#1a0d0d" stroke="#c0392b" strokeWidth={3} opacity={0.85} />
                    <text x={bx} y={by - 6} textAnchor="middle" fontSize={20} fontWeight={700} fill="#f0d0c0">🂠 Deck</text>
                    <text x={bx} y={by + 22} textAnchor="middle" fontSize={20} fontWeight={700} fill="#e8c078">{n} left</text>
                  </g>
                );
              })()}
            </g>
          );
        })()}

        {/* Interactive board furniture: the printed reference regions are
            clickable and open an info panel with their live state — the top
            Story track (turn, phase, every marker) and, at the tower's base,
            Sauron's Actions / Shadow Pool economy. */}
        {(() => {
          const st = state.story.sauron ?? { yellow: 0, red: 0, black: 0 };
          const R = STORY_FINALE;
          const storyInfo = () => inspect({
            title: 'Story Track', subtitle: `Turn ${state.story.turn} · ${state.phase}`,
            lines: [
              `Hero (green): space ${Math.min(R, state.story.heroMarker ?? 0)}/${R}`,
              `Ring (yellow): space ${Math.min(R, st.yellow)}/${R}`,
              `War (red): space ${Math.min(R, st.red)}/${R}`,
              `Corruption (black): space ${Math.min(R, st.black)}/${R}`,
            ],
            text: 'Each Story Step Sauron advances his three markers toward FINALE; the Hero marker advances as the heroes complete quests. Whoever reaches FINALE on their track wins the game.',
          });
          const actionsInfo = () => inspect({
            title: 'Sauron Actions — the Eye', subtitle: 'Action Step economy',
            lines: [
              `Eye actions this step: ${state.sauronActionsLeft ?? '—'}`,
              `Shadow Pool (chest): ${state.sauron.influence}`,
              `Shadow hand: ${state.sauron.shadowHand?.length ?? 0} cards`,
              `Doctrine: ${state.sauron.doctrine ?? 'balanced'}`,
            ],
            text: 'During the Action Step Sauron spends Eye actions: (1) Gain influence — up to 2 into the Shadow Pool, the rest as extension; (2) Draw Shadow & Plot cards; (3) Command up to X minions/monster tokens (max 1 new monster token).',
          });
          const favorInfo = () => {
            const boardFavor = Object.values(state.map.favorAt ?? {}).reduce((a, b) => a + b, 0);
            const favorLocs = Object.entries(state.map.favorAt ?? {}).filter(([, n]) => n > 0);
            const chars = Object.entries(state.map.charactersAt ?? {}).flatMap(([lid, cs]) => (cs ?? []).map((c) => `${pretty(c)} at ${cat.locations[lid]?.name ?? lid}`));
            const allies = state.heroes.flatMap((hh) => (hh.allies ?? []).map((a) => `${pretty(a)} (with ${cat.heroes[hh.id]?.name ?? hh.id})`));
            const lines = state.heroes.map((hh) => `${cat.heroes[hh.id]?.name ?? hh.id}: ${hh.favor} favor${hh.bankedFavor ? ` (+${hh.bankedFavor} banked)` : ''}`);
            lines.push(`Favor tokens on the board: ${boardFavor}${favorLocs.length ? ` (${favorLocs.map(([l, n]) => `${cat.locations[l]?.name ?? l} ×${n}`).join(', ')})` : ''}`);
            if (allies.length) lines.push(`Allies recruited: ${allies.join(', ')}`);
            if (chars.length) lines.push(`Characters on the board: ${chars.join(', ')}`);
            inspect({
              title: 'Favor & Characters', subtitle: 'Hero economy',
              lines,
              text: 'Heroes earn Favor from quests and encounters and spend it to counter Sauron plots, redeem Corruption, and recruit Characters. Favor tokens dropped on the board are picked up with the free Retrieve Favor action. Recruited Characters become allies that travel with their hero.',
            });
          };
          const influenceInfo = () => {
            const li = state.sauron.locationInfluence ?? {};
            const total = Object.values(li).reduce((a, b) => a + b, 0);
            const spots = Object.entries(li).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
            const lines = [
              `Shadow Pool (chest): ${state.sauron.influence}`,
              `Influence on the map: ${total} across ${spots.length} location(s)`,
            ];
            for (const [lid, n] of spots.slice(0, 8)) lines.push(`  ${cat.locations[lid]?.name ?? lid}: ${n}`);
            if (spots.length > 8) lines.push(`  …and ${spots.length - 8} more`);
            inspect({
              title: 'Influence', subtitle: 'Sauron\'s reach',
              lines,
              text: 'Sauron places Influence on locations to make them perilous (heroes there draw Peril cards) and to fuel plots. Influence in the Shadow Pool (chest) is Sauron\'s spendable reserve. Heroes reduce influence through quests, encounters, and clearing effects.',
            });
          };
          const zones: { key: string; x: number; y: number; w: number; h: number; on: () => void; tip: string }[] = [
            { key: 'story', x: 2760, y: 40, w: 3200, h: 230, on: storyInfo, tip: 'Story track — turn, phase & markers' },
            { key: 'actions', x: 5130, y: 2960, w: 940, h: 700, on: actionsInfo, tip: 'Sauron Actions & Shadow Pool' },
            { key: 'favor', x: 1225, y: 90, w: 925, h: 480, on: favorInfo, tip: 'Favor & Characters — hero economy' },
            { key: 'influence', x: 1660, y: 3615, w: 915, h: 480, on: influenceInfo, tip: 'Influence — Sauron\'s reach' },
          ];
          return (
            <g>
              {zones.map((z) => (
                <rect key={'zone' + z.key} x={z.x} y={z.y} width={z.w} height={z.h}
                  fill="transparent" style={{ cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); z.on(); }}>
                  <title>{z.tip}</title>
                </rect>
              ))}
            </g>
          );
        })()}

        {/* Minion reference cards (left column): the five printed minion cards
            are always inspectable — clicking any opens its description, so the
            player can review a minion's stats/ability whether it is deployed on
            the map, in reserve, or defeated. (Card bounds measured off the art;
            a reserve token, when present, is drawn on top with the same info.) */}
        {(() => {
          const cards: { id: string; y: number; h: number }[] = [
            { id: 'minion-black-serpent', y: 2400, h: 300 },
            { id: 'minion-mouth-of-sauron', y: 2740, h: 300 },
            { id: 'minion-gothmog', y: 3100, h: 300 },
            { id: 'minion-ringwraiths', y: 3450, h: 300 },
            { id: 'minion-witch-king', y: 3800, h: 370 },
          ];
          return (
            <g>
              {cards.map((c) => {
                const m = cat.minions[c.id];
                if (!m) return null;
                return (
                  <rect key={'mcard' + c.id} x={960} y={c.y} width={560} height={c.h}
                    fill="transparent" style={{ cursor: 'pointer' }}
                    onClick={(e) => { e.stopPropagation(); inspect({ title: m.name, img: minionArt(m.image), subtitle: 'Minion reference card', text: m.ability }); }}>
                    <title>{`${m.name} — click for its description`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })()}

        {/* Sauron's Plot track — the three plot slots sit on the Dark Tower
            along the board's right edge (each slot bears Sauron's emblem in
            the board art, numbered 1–3 top→bottom). An active plot's card art
            overlays its slot; empty slots let the tower emblem show through.
            Clicking an empty slot just confirms it's empty — it does NOT open
            the full Plot deck browser (that's the dedicated 'plots' pile
            hotspot above slot 1, matching where the physical draw pile sits),
            so players don't mistake "no active plot here" for "browse the
            whole deck". */}
        {(() => {
          const active = state.sauron.activePlots ?? [];
          const cx = 5540, w = 220, h = 400;           // tower plot-slot geometry (board px, measured off the art)
          const ys = [800, 1400, 2000];                // slot centres, top → bottom
          return (
            <g pointerEvents="none">
              {ys.map((cy, i) => {
                const pm = active[i];
                const p = pm ? cat.plots.find((x) => x.id === pm.eventId) : undefined;
                const img = p ? plotArt(p.image) : '';
                const x = cx - w / 2, y = cy - h / 2;
                if (!p) {
                  return (
                    <rect key={'plotslot' + i} x={x} y={y} width={w} height={h} rx={10}
                      fill="transparent" stroke="#6b4a3a" strokeWidth={2} strokeDasharray="10 8" opacity={0.4}
                      pointerEvents="auto" style={{ cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); inspect({ title: `Plot slot ${i + 1}`, subtitle: 'Empty',
                        text: 'No plot is currently active in this slot. Sauron reveals plots from his Plot deck during the Action Step.' }); }}>
                      <title>{`Plot slot ${i + 1} — empty`}</title>
                    </rect>
                  );
                }
                return (
                  <g key={'plotslot' + i} pointerEvents="auto" style={{ cursor: 'pointer' }}
                    onClick={(e) => { e.stopPropagation(); inspect({ title: p.name, img, subtitle: `Active Plot ${i + 1}`,
                      lines: [`Affects: ${p.affectsText || '—'}`, `Favor to counter: ${p.favorToCounter ?? '—'}`], text: p.effect || '' }); }}>
                    <title>{`${p.name}\nAffects: ${p.affectsText || '—'}\nFavor to counter: ${p.favorToCounter ?? '—'}\n\n${p.effect || ''}`}</title>
                    <rect x={x} y={y} width={w} height={h} rx={10}
                      fill="#1a0d0d" stroke="#c0392b" strokeWidth={5} opacity={0.97} />
                    {img && (
                      <image href={img} x={x + 5} y={y + 5} width={w - 10} height={h - 10}
                        preserveAspectRatio="xMidYMid slice" style={{ clipPath: `inset(0 round 8px)` }} />
                    )}
                    <text x={cx} y={y - 12} textAnchor="middle" fontSize={22} fontWeight={700}
                      fill="#f0d0c0">{p.name}</text>
                  </g>
                );
              })}
            </g>
          );
        })()}

        {/* Sauron's Actions & Shadow Pool — live overlays at the tower's base
            (same spots as the clickable 'actions'/'shadow' hotspots above),
            drawn in the same always-visible style as the Plot track: no click
            needed to see the current state, though the hotspots remain for a
            full breakdown. Eye tokens (👁 covered / plain number = open) mirror
            CounterBar's EyeTracksViz; the Shadow Pool box shows the same
            board-photo art (0..12 tokens) used in the top HUD. */}
        {(() => {
          const eye = state.sauron.eye ?? { influence: 0, draw: 0, command: 0 };
          const tracks: { key: 'influence' | 'draw' | 'command'; label: string; slots: number[] }[] = [
            { key: 'influence', label: 'Infl', slots: [6, 5, 4] },
            { key: 'draw', label: 'Draw', slots: [2, 2, 1] },
            { key: 'command', label: 'Cmd', slots: [3, 2, 1] },
          ];
          const ax = 5130, ay = 2960, aw = 940; // 'actions' hotspot geometry
          const openShadowRef = () => window.dispatchEvent(new CustomEvent('meq-open-ref', { detail: 'shadow' }));
          const rowH = 90, rowGap = 18, top = ay + 70;
          // 'shadow' (Shadow Pool) box geometry — measured directly off the
          // printed board art (the metal-framed box around the "SHADOW POOL"
          // title + 12 influence pips): x5175,y3638,810×517 (ratio ~1.57). The
          // live overlay photo is ~1.49 ratio, so `slice` still crops a hair,
          // but the box itself is now aligned with the print instead of
          // sitting ~90px low/right of it (which produced a visible double
          // "SHADOW POOL" title — the printed one peeking out from under the
          // misaligned photo).
          const sx = 5175, sy = 3638, sw = 810, sh = 517;
          return (
            <g pointerEvents="none">
              <text x={ax + aw / 2} y={ay + 30} textAnchor="middle" fontSize={26} fontWeight={700}
                fill="#f0d0c0">Eye Actions ({state.sauronActionsLeft ?? 0} left)</text>
              {tracks.map((tr, ti) => {
                const ry = top + ti * (rowH + rowGap);
                const covered = eye[tr.key];
                return (
                  <g key={'eyetrack' + tr.key}>
                    <text x={ax + 10} y={ry + rowH / 2 + 8} fontSize={22} fill="#d8c0a8">{tr.label}</text>
                    {tr.slots.map((v, i) => {
                      const cx = ax + 160 + i * 90, cy = ry + rowH / 2, on = i < covered;
                      return (
                        <g key={i}>
                          <circle cx={cx} cy={cy} r={34} fill={on ? '#c0392b' : 'transparent'}
                            stroke="#c0392b" strokeWidth={3} opacity={on ? 0.9 : 0.5} />
                          <text x={cx} y={cy + 9} textAnchor="middle" fontSize={26} fill={on ? '#fff' : '#d8c0a8'}>
                            {on ? '👁' : v}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
              <g pointerEvents="auto" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); openShadowRef(); }}>
                <image href={shadowPoolArt(state.sauron.influence)} x={sx} y={sy} width={sw} height={sh}
                  preserveAspectRatio="xMidYMid slice" style={{ clipPath: `inset(0 round 12px)` }} />
                <title>{`Shadow Pool — ${Math.min(12, state.sauron.influence)} influence placed (chest: ${state.sauron.influence})`}</title>
              </g>
            </g>
          );
        })()}

        {/* Story-track markers on the physical track along the board's top edge:
            the Hero (green) marker and Sauron's three story markers — Ring
            (yellow), War/Military (red), Corruption (black). Space 0 = START
            (x2774, measured as the true centre of the printed START cell —
            NOT ~2867, which sat ~90px into cell 1 and made the marker cluster
            straddle the START/cell-1 boundary) … space 18 = FINALE (~x5865);
            cells are evenly spaced so each marker interpolates linearly.
            Markers are fanned in a tight 2×2 so a shared space stays legible
            without spilling into the neighbouring cell. */}
        {(() => {
          const xS = 2774, xF = 5865, ty = 150, R = STORY_FINALE;
          const st = state.story.sauron ?? { yellow: 0, red: 0, black: 0 };
          // Linear map: space 0 sits centred in the START cell (xS), space R on
          // FINALE (xF). The four markers are kept legible by their 2×2 fan —
          // sized/offset generously (board art is ~6100px wide) so they read
          // clearly even zoomed far out, and never crowd across a cell boundary.
          const at = (v: number) => xS + (xF - xS) * (Math.max(0, Math.min(R, v)) / R);
          const heroImg = token('heroStoryMarker');
          const markers = [
            { k: 'hero', v: state.story.heroMarker ?? 0, fill: '#3a9d4a', dx: -26, dy: -26, init: 'H', name: 'Hero', img: heroImg },
            { k: 'ring', v: st.yellow, fill: '#d9b32b', dx: 26, dy: -26, init: 'R', name: 'Ring', img: token('sauronStoryMarkerYellow') },
            { k: 'war', v: st.red, fill: '#b23b3b', dx: -26, dy: 26, init: 'W', name: 'War', img: token('sauronStoryMarkerRed') },
            { k: 'corruption', v: st.black, fill: '#3a3a44', dx: 26, dy: 26, init: 'C', name: 'Corruption', img: token('sauronStoryMarkerBlack') },
          ];
          const r = 22;
          return (
            <g pointerEvents="none">
              {markers.map((m) => {
                const cx = at(m.v) + m.dx, cy = ty + m.dy;
                return (
                  <g key={'story' + m.k}>
                    <title>{`${m.name} marker — space ${Math.max(0, Math.min(R, m.v))}/${R}`}</title>
                    {m.img
                      ? <image href={m.img} x={cx - r} y={cy - r} width={r * 2} height={r * 2} preserveAspectRatio="xMidYMid meet" />
                      : <><circle cx={cx} cy={cy} r={r} fill={m.fill} stroke="#1a120b" strokeWidth={3} opacity={0.97} />
                          <text x={cx} y={cy + 7} textAnchor="middle" fontSize={22} fontWeight={700} fill="#f7efd8">{m.init}</text></>}
                  </g>
                );
              })}
            </g>
          );
        })()}

        {/* "Favor and Characters" box (top-left of the board art): recruited
            allies travel WITH their hero rather than sitting on a location, so
            they have no map node — they gather here as portrait chips, ringed in
            their hero's colour. (Box interior measured off the art.) */}
        {(() => {
          const allies: { ally: string; heroId: string }[] = [];
          for (const hh of state.heroes) for (const a of hh.allies ?? []) allies.push({ ally: a, heroId: hh.id });
          if (!allies.length) return null;
          const bx0 = 1315, by0 = 175, bw = 875, csz = 96, gap = 20;
          const cols = Math.max(1, Math.floor((bw + gap) / (csz + gap)));
          const rC = csz / 2;
          return (
            <g>
              {allies.map((a, i) => {
                const col = i % cols, row = Math.floor(i / cols);
                const cx = bx0 + rC + col * (csz + gap);
                const cy = by0 + rC + row * (csz + gap);
                const art = characterArt(a.ally);
                return (
                  <g key={'ally' + a.ally + i} transform={`translate(${cx},${cy})`} style={{ cursor: 'help' }}
                    onClick={(e) => { e.stopPropagation(); inspect({ title: pretty(a.ally), img: art, subtitle: `Ally · with ${cat.heroes[a.heroId]?.name ?? a.heroId}` }); }}>
                    <title>{`${pretty(a.ally)} — ally travelling with ${cat.heroes[a.heroId]?.name ?? a.heroId}`}</title>
                    <circle r={rC + 3} fill="#140f0a" stroke={heroColor(a.heroId)} strokeWidth={5} />
                    {art
                      ? <image href={art} x={-rC} y={-rC} width={csz} height={csz} preserveAspectRatio="xMidYMid slice" style={{ clipPath: 'inset(0 round 50%)' }} />
                      : <text y={9} textAnchor="middle" fontSize={40} fontWeight={700} fill="#cfe0ea">{pretty(a.ally)[0]}</text>}
                  </g>
                );
              })}
            </g>
          );
        })()}

        {/* Off-board minions rest on their printed reference cards (left column):
            a minion not deployed on the map — never spawned yet, or defeated and
            returned to reserve — shows as a token over its description card so
            the player sees which minions are still off the board. (Card portrait
            centres measured off the art.) */}
        {(() => {
          const reserve = new Set(reserveMinions(state, cat));
          if (!reserve.size) return null;
          const slot: Record<string, { x: number; y: number }> = {
            'minion-black-serpent': { x: 1030, y: 2520 },
            'minion-mouth-of-sauron': { x: 1030, y: 2895 },
            'minion-gothmog': { x: 1030, y: 3255 },
            'minion-ringwraiths': { x: 1030, y: 3620 },
            'minion-witch-king': { x: 1030, y: 3965 },
          };
          const rC = 66;
          return (
            <g>
              {Object.entries(slot).map(([mid, p]) => {
                if (!reserve.has(mid)) return null;
                const m = cat.minions[mid];
                const art = m ? minionArt(m.image) : '';
                return (
                  <g key={'rsv' + mid} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'help' }}
                    onClick={(e) => { e.stopPropagation(); if (m) inspect({ title: m.name, img: art, subtitle: `Minion (in reserve — not on the board)`, text: m.ability }); }}>
                    <title>{`${m?.name ?? mid} — in reserve (not on the board)`}</title>
                    <circle r={rC + 3} fill="#140f0a" stroke={MINION_BORDER} strokeWidth={5} opacity={0.97} />
                    {art
                      ? <image href={art} x={-rC} y={-rC} width={rC * 2} height={rC * 2} preserveAspectRatio="xMidYMid slice" style={{ clipPath: 'inset(0 round 50%)' }} />
                      : <text y={9} textAnchor="middle" fontSize={34} fontWeight={700} fill="#e8c0b0">{(m?.name ?? '?')[0]}</text>}
                  </g>
                );
              })}
            </g>
          );
        })()}

        {/* Hover overlay: a detailed panel of every figure at the hovered node,
            drawn last so it sits above neighbouring nodes even when crowded. */}
        {(() => {
          if (!hover) return null;
          const l = cat.locations[hover];
          if (!l) return null;
          const figs = buildFigs(hover);
          if (figs.length < 2) return null; // single/empty nodes: the inline label is enough
          const rowH = 34, pad = 10, iconW = 28;
          const bw = 210, bh = pad * 2 + 24 + figs.length * rowH;
          const bx = l.coords.x + 40, by = l.coords.y - bh / 2;
          return (
            <g pointerEvents="none">
              <rect x={bx} y={by} width={bw} height={bh} rx={10} fill="#140f0a" stroke="#8a734a" strokeWidth={2.5} opacity={0.97} />
              <text x={bx + pad} y={by + pad + 16} fontSize={20} fontWeight={700} fill="#f0e2c0">{l.name}</text>
              {figs.map((c, i) => {
                const ry = by + pad + 24 + i * rowH;
                return (
                  <g key={c.key} transform={`translate(${bx + pad},${ry})`}>
                    {c.art
                      ? <image href={c.art} x={0} y={0} width={iconW} height={iconW} preserveAspectRatio="xMidYMid slice" style={{ clipPath: 'inset(0 round 5px)' }} />
                      : <><rect x={0} y={0} width={iconW} height={iconW} rx={5} fill={c.fill} /><text x={iconW / 2} y={iconW * 0.68} textAnchor="middle" fontSize={16} fontWeight={700} fill="#f0e2c0">{c.init}</text></>}
                    <rect x={0} y={0} width={iconW} height={iconW} rx={5} fill="none" stroke={c.border} strokeWidth={2.5} />
                    <text x={iconW + 8} y={iconW * 0.72} fontSize={17} fill="#e8dcc0">{c.label}{c.count > 1 ? ` ×${c.count}` : ''}</text>
                  </g>
                );
              })}
            </g>
          );
        })()}
        </g>
      </svg>
    </div>
  );
}
