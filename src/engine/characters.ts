import type { GameState, LocationId } from './types';

/** Move a consultable Character's SINGLE marker to `loc`. Every consultable
 *  character (Gandalf, Aragorn, …) has exactly ONE marker: if it already sits
 *  elsewhere on the board — or in the favor tray (i.e. not yet on the map) — it
 *  is MOVED to `loc`, never duplicated. Returns the location it moved FROM (a
 *  different location), or null when it arrives fresh (was off-map / already
 *  here). */
export function placeCharacterUnique(s: GameState, cname: string, loc: LocationId): LocationId | null {
  const key = cname.trim().toLowerCase();
  const map = (s.map.charactersAt ||= {});
  let from: LocationId | null = null;
  for (const l of Object.keys(map)) {
    const arr = map[l];
    const i = arr.indexOf(key);
    if (i >= 0) {
      arr.splice(i, 1);
      if (l !== loc) from = l;
      if (!arr.length) delete map[l];
    }
  }
  const here = (map[loc] ||= []);
  if (!here.includes(key)) here.push(key);
  return from;
}

/** Remove a Character's marker from the board entirely (e.g. when the event that
 *  placed it is discarded). No-op if the character is not on the map. */
export function removeCharacter(s: GameState, cname: string): void {
  const key = cname.trim().toLowerCase();
  const map = s.map.charactersAt;
  if (!map) return;
  for (const l of Object.keys(map)) {
    const arr = map[l];
    const i = arr.indexOf(key);
    if (i >= 0) {
      arr.splice(i, 1);
      if (!arr.length) delete map[l];
    }
  }
}
