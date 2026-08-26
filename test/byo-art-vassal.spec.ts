// Bring-your-own-art against a simulated VASSAL module folder — including the
// module's real mislabeled / oddly-spaced file names. Proves our curated
// translation map + normalization resolves a user's art folder to the cards,
// and that clearing it restores the built-in fallback paths.
import { describe, it, expect, afterEach } from 'vitest';
import { normalizeArtName, buildArtIndex, matchExpected, ART_ALIASES } from '../src/data/artMatch';
import { setUserArt, getUserArt, expectedArtNames, plotArt } from '../src/data/art';

const blob = (name: string) => ({ name, url: `blob:mock/${encodeURIComponent(name)}` });

afterEach(() => setUserArt(null));

describe('BYO-art — loading a full VASSAL image folder', () => {
  const expected = expectedArtNames().filter(Boolean);

  it('exposes a non-trivial set of expected art files', () => {
    expect(expected.length).toBeGreaterThan(100);
  });

  it('resolves (nearly) every expected file when the user supplies the whole folder', () => {
    const index = buildArtIndex(expected.map(blob));
    let matched = 0;
    const missing: string[] = [];
    for (const name of expected) {
      if (matchExpected(name, index)) matched++;
      else missing.push(name);
    }
    // The folder IS the expected set, so matching must be complete.
    expect(missing, `unmatched: ${missing.slice(0, 20).join(', ')}`).toEqual([]);
    expect(matched).toBe(expected.length);
  });

  it('still matches files the VASSAL module mislabels (case / spacing / typos)', () => {
    // pick a spaced filename and mangle its case + spacing like a real export
    const spaced = expected.find((n) => n.includes(' ')) ?? expected[0];
    const mangled = spaced.toUpperCase().replace(/ +/g, '  ');
    const index = buildArtIndex([blob(mangled)]);
    expect(matchExpected(spaced, index)).toBeTruthy();
  });

  it('applies the curated typo aliases (e.g. concetrate → concentrate)', () => {
    for (const [typo, correct] of Object.entries(ART_ALIASES)) {
      // a user file carrying the typo must resolve to the corrected expected name
      const userName = `some ${typo} card.jpg`;
      const expectedName = `some ${correct} card.jpg`;
      const index = buildArtIndex([blob(userName)]);
      expect(matchExpected(expectedName, index), `alias ${typo}→${correct}`).toBeTruthy();
    }
  });

  it('normalizeArtName is stable and folds case / separators / extension', () => {
    const a = normalizeArtName('  Argalad  Aimed_Shot X4.JPG ');
    const b = normalizeArtName('argalad aimed shot x4.jpg');
    expect(a).toBe(b);
    expect(normalizeArtName(a)).toBe(a); // idempotent
  });

  it('does not match unrelated files', () => {
    const index = buildArtIndex([blob('totally-unrelated-holiday-photo.jpg')]);
    expect(matchExpected('plot09.jpg', index)).toBeUndefined();
  });
});

describe('BYO-art — resolvers honor the loaded folder then fall back', () => {
  it('a resolver returns the user blob when loaded, and the built-in path when cleared', () => {
    // With no user art, plotArt yields the built-in dev-assets path.
    setUserArt(null);
    const builtin = plotArt('plot09.jpg');
    expect(builtin).toContain('plot09.jpg');
    expect(builtin.startsWith('blob:')).toBe(false);

    // Load a user folder containing plot09.jpg → resolver returns the blob url.
    setUserArt(buildArtIndex([blob('plot09.jpg')]));
    expect(getUserArt()).not.toBeNull();
    const user = plotArt('plot09.jpg');
    expect(user.startsWith('blob:')).toBe(true);

    // Clear → back to the built-in path.
    setUserArt(null);
    expect(plotArt('plot09.jpg')).toBe(builtin);
  });
});
