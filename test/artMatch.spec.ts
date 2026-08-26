// Unit tests for the BYO-art matcher (src/data/artMatch.ts).
import { describe, it, expect } from 'vitest';
import { normalizeArtName, ART_ALIASES, buildArtIndex, matchExpected } from '../src/data/artMatch';

describe('normalizeArtName', () => {
  it('strips path, drops extension, lowercases and removes non-alphanumerics', () => {
    expect(normalizeArtName('C:/vmod/Art/Shadow Pool 1.JPG')).toBe('shadowpool1');
    expect(normalizeArtName('sub\\dir\\Monster_Crebain.png')).toBe('monstercrebain');
  });

  it('folds case, spaces and underscores to the same key', () => {
    const a = normalizeArtName('Monster Barrow Wight.jpg');
    const b = normalizeArtName('monster_barrow_wight.JPG');
    const c = normalizeArtName('monster___barrow   wight.jpeg');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('is idempotent', () => {
    const once = normalizeArtName('Some File Name 12.png');
    expect(normalizeArtName(once)).toBe(once);
    expect(normalizeArtName(normalizeArtName('a b_c.JPG'))).toBe(normalizeArtName('a b_c.JPG'));
  });

  it('handles empty input', () => {
    expect(normalizeArtName('')).toBe('');
  });
});

describe('ART_ALIASES', () => {
  it('maps the known VASSAL "concetrate" typo to the corrected spelling', () => {
    expect(ART_ALIASES.concetrate).toBe('concentrate');
  });
});

describe('buildArtIndex + matchExpected', () => {
  it('round-trips user files to their expected filenames', () => {
    const index = buildArtIndex([
      { name: 'Monster Crebain.jpg', url: 'blob:crebain' },
      { name: 'plot09.JPG', url: 'blob:plot09' },
    ]);
    expect(matchExpected('monster_crebain.jpg', index)).toBe('blob:crebain');
    expect(matchExpected('plot09.jpg', index)).toBe('blob:plot09');
    expect(matchExpected('does not exist.jpg', index)).toBeUndefined();
  });

  it('keeps the first file on a normalized-key collision', () => {
    const index = buildArtIndex([
      { name: 'plot 09.jpg', url: 'blob:first' },
      { name: 'PLOT09.png', url: 'blob:second' },
    ]);
    expect(matchExpected('plot09.jpg', index)).toBe('blob:first');
  });

  it('matches a user file named with the VASSAL typo to our corrected name', () => {
    const index = buildArtIndex([{ name: 'eleanor concetrate x3.jpg', url: 'blob:conc' }]);
    expect(matchExpected('eleanor concentrate x3.jpg', index)).toBe('blob:conc');
  });

  it('also matches when the user file already uses the corrected spelling', () => {
    const index = buildArtIndex([{ name: 'ravager concentrate x3.jpg', url: 'blob:rav' }]);
    expect(matchExpected('ravager concentrate x3.jpg', index)).toBe('blob:rav');
  });
});
