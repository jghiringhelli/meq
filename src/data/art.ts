// M10: typed accessors over assets/art-manifest.json (owner's vmod art, served
// from public/dev-assets/art). All fields are optional — the UI degrades to text
// when art is missing.
import manifest from '../../assets/art-manifest.json';
import { matchExpected } from './artMatch';

type Dict = Record<string, string>;
interface ArtManifest {
  board?: string; battleBoard?: string;
  heroes?: Record<string, Dict>;
  monsters?: Dict; characters?: Dict; items?: Dict;
  shadow?: Dict; plots?: Dict; startingPlots?: Dict; corruption?: Dict;
  encounters?: Dict; perils?: Dict; events?: Dict;
  combatCards?: Dict; combatCardsByOwner?: Record<string, Dict>;
  heroMissions?: Dict; sauronMissions?: Dict;
  tokens?: Dict; backs?: Dict;
}

const art = manifest as ArtManifest;
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ── BYO-art runtime override ────────────────────────────────────────────────
// The public build ships no copyrighted VASSAL art; a user supplies their own
// copy at runtime (see src/play/ArtLoader.tsx) which builds an index of
// normalized-filename → blob url. Every resolver below routes its served
// /dev-assets/art URL through `withUserArt`, so a matching user file wins.
// When no user art is loaded (userArtIndex === null) this is a no-op and the
// base game renders exactly as before.
let userArtIndex: Map<string, string> | null = null;

/** Install (or clear, with null) the user's BYO-art index. */
export function setUserArt(index: Map<string, string> | null): void {
  userArtIndex = index;
}
/** The currently-installed BYO-art index, or null. */
export function getUserArt(): Map<string, string> | null {
  return userArtIndex;
}

/** Swap a served /dev-assets/art URL for the user's matching blob url when one
 *  is loaded; otherwise return the URL unchanged (empty stays empty). */
function withUserArt(url: string): string {
  if (!userArtIndex || !url) return url;
  let file = url.slice(url.lastIndexOf('/') + 1);
  try { file = decodeURIComponent(file); } catch { /* keep the raw basename */ }
  return matchExpected(file, userArtIndex) ?? url;
}

/** Every distinct art filename the game can reference (manifest basenames),
 *  used by the BYO-art loader to report how many expected files were matched. */
export function expectedArtNames(): string[] {
  const set = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.includes('/dev-assets/art/')) {
        let file = v.slice(v.lastIndexOf('/') + 1);
        try { file = decodeURIComponent(file); } catch { /* keep raw */ }
        set.add(file);
      }
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(art);
  return [...set];
}

export const boardArt = () => withUserArt(art.board || '');
export const battleBoardArt = () => withUserArt(art.battleBoard || '');
export const heroArt = (id: string) => {
  const h = art.heroes?.[id];
  if (!h) return {};
  if (!userArtIndex) return h;
  const out: Dict = {};
  for (const [k, v] of Object.entries(h)) out[k] = withUserArt(v);
  return out;
};
export const monsterArt = (id: string) => withUserArt(art.monsters?.[id] || '');
export const characterArt = (name: string) => withUserArt(art.characters?.[norm(name)] || '');
export const itemArt = (name: string) => withUserArt(art.items?.[norm(name)] || '');
export const shadowArt = (id: string) => withUserArt(art.shadow?.[id] || '');
export const encounterArt = (id: string) => withUserArt(art.encounters?.[id] || '');
export const perilArt = (id: string) => withUserArt(art.perils?.[id] || '');
export const eventArt = (id: string) => withUserArt(art.events?.[id] || '');
export const heroMissionArt = (id: string) => withUserArt(art.heroMissions?.[id] || '');
export const sauronMissionArt = (id: string) => withUserArt(art.sauronMissions?.[id] || '');
export const token = (k: string) => withUserArt(art.tokens?.[k] || '');
export const back = (k: string) => withUserArt(art.backs?.[k] || '');
/** Keys of the art maps, for reference-browser listings. */
export const itemArtKeys = () => Object.keys(art.items ?? {});
export const characterArtKeys = () => Object.keys(art.characters ?? {});

const ART_BASE = '/dev-assets/art/';
/** Plot-card art: plots.json stores the raw scan filename (e.g. "plot01.jpg"
 *  or "starting plot 1.jpg"); resolve it to the served dev-assets URL. */
export const plotArt = (file: string) => (file ? withUserArt(ART_BASE + encodeURIComponent(file)) : '');

/** Minion art: minions.json stores the raw VASSAL filename (e.g. "minion 1.PNG"). */
export const minionArt = (file: string) => (file ? withUserArt(ART_BASE + encodeURIComponent(file)) : '');

/** Shadow-pool overlay: the VASSAL pool board with `n` influence slots lit
 *  (0 → the empty base board, 1..12 → that many tokens placed). */
export const shadowPoolArt = (n: number) => {
  const k = Math.max(0, Math.min(12, Math.round(n)));
  return withUserArt(ART_BASE + encodeURIComponent(k === 0 ? 'shadow pool.jpg' : `shadow pool ${k}.jpg`));
};

/** Best-effort combat-card art. Resolution order: exact card id → the card
 *  owner's art keyed by the (normalised) card NAME. The owner key is taken from
 *  `ownerHint` when given (e.g. the acting hero/monster id), else derived from
 *  the card's `deck` field ("hero-beravor" → "beravor", "monster-ravager" →
 *  "ravager"). NB: the manifest keys by card NAME, not ability text, and the
 *  card's own `owner` field ("hero"/"monster") is NOT a valid owner key. */
export function combatCardArt(
  card: { id: string; name?: string; deck?: string } | string,
  ownerHint?: string,
): string {
  const id = typeof card === 'string' ? card : card.id;
  const name = typeof card === 'string' ? '' : (card.name ?? '');
  const deckOwner = typeof card === 'string' ? '' : (card.deck ?? '').replace(/^(hero|monster|minion)-/, '');
  const ownerKey = norm(ownerHint || deckOwner);
  // Prefer the acting owner's OWN copy of the card (its face) when it exists —
  // many cards are shared across heroes, and the generic id art is just one
  // hero's scan (e.g. Argalad). Fall back to the id art, then nothing.
  const byOwner = art.combatCardsByOwner?.[ownerKey];
  if (byOwner?.[norm(name)]) return withUserArt(byOwner[norm(name)]);
  if (art.combatCards?.[id]) return withUserArt(art.combatCards[id]);
  return '';
}
