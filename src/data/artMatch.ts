// BYO-art matching: fuzzily map a user's own copy of the VASSAL module art
// files to the filenames the game expects. Pure + unit-tested; no DOM/React so
// it can run under Vitest and be reused by both the loader UI and art.ts.

/** Fold an art filename to a stable, comparable key: strip any directory path,
 *  drop the extension, lowercase, and remove everything that isn't alphanumeric
 *  (this also collapses whitespace and underscores). Idempotent. */
export function normalizeArtName(name: string): string {
  if (!name) return '';
  // strip directory path (both POSIX and Windows separators)
  const base = name.replace(/^.*[\\/]/, '');
  // drop the file extension (last dot segment), if any
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Known VASSAL filename typos → their corrected spelling, as normalized
 *  substrings. The user's vmod may ship files under VASSAL's original (typo'd)
 *  names, while our expected names use the corrected spelling we curated in
 *  art-manifest.json — these aliases let the typo'd file still match. */
export const ART_ALIASES: Record<string, string> = {
  // art-manifest.json maps the catalog id `*-concetrate` onto the corrected
  // "concentrate x3.jpg" scans; alias the typo so a typo-named file matches.
  concetrate: 'concentrate',
};

/** Apply the alias table to an already-normalized key (substring replacement,
 *  so it works inside longer names like "eleanorconcetratex3"). */
function applyAliases(normalized: string): string {
  let out = normalized;
  for (const [typo, correct] of Object.entries(ART_ALIASES)) {
    if (out.includes(typo)) out = out.split(typo).join(correct);
  }
  return out;
}

/** The canonical lookup key for a filename: normalized + aliased. Applied to
 *  both user files and expected names so the two sides always agree. */
function keyFor(name: string): string {
  return applyAliases(normalizeArtName(name));
}

/** Build a lookup from normalized-expected-name → blob url for a set of
 *  user-supplied files. The first file wins on a key collision (stable). */
export function buildArtIndex(userFiles: { name: string; url: string }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const f of userFiles) {
    const key = keyFor(f.name);
    if (!key || index.has(key)) continue;
    index.set(key, f.url);
  }
  return index;
}

/** Look up the user blob url for an expected game filename, or undefined. */
export function matchExpected(expectedFilename: string, index: Map<string, string>): string | undefined {
  const key = keyFor(expectedFilename);
  if (!key) return undefined;
  return index.get(key);
}
