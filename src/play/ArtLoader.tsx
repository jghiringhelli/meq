// BYO-art loader: lets a user supply their own copy of the VASSAL module art
// (a folder or a set of image files) at runtime. The public build ships no
// copyrighted art, so this is how players see the "real" scans. Selections use
// object URLs, so they last for the current page session only — reloading the
// page clears them and the game falls back to the built-in placeholders.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildArtIndex, matchExpected } from '../data/artMatch';
import { setUserArt, expectedArtNames } from '../data/art';

interface Props {
  /** Called after a load or clear with (matched, totalExpected). */
  onLoaded?: (matched: number, total: number) => void;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export default function ArtLoader({ onLoaded }: Props) {
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);
  const [summary, setSummary] = useState<{ loaded: number; matched: number; total: number } | null>(null);

  const expectedTotal = useMemo(() => expectedArtNames().length, []);

  // `webkitdirectory` isn't in the React input types; set it imperatively so a
  // whole folder (including subfolders) can be picked in one go.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '');
    dirRef.current?.setAttribute('directory', '');
  }, []);

  // Release object URLs when this control unmounts.
  useEffect(() => () => { for (const u of urlsRef.current) URL.revokeObjectURL(u); }, []);

  const ingest = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    // Drop any previously-created blob urls before replacing the set.
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];

    const files: { name: string; url: string }[] = [];
    for (const file of Array.from(fileList)) {
      const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (!IMAGE_RE.test(name)) continue;
      const url = URL.createObjectURL(file);
      urlsRef.current.push(url);
      files.push({ name, url });
    }

    const index = buildArtIndex(files);
    setUserArt(index);
    const expected = expectedArtNames();
    const matched = expected.filter((f) => matchExpected(f, index)).length;
    setSummary({ loaded: files.length, matched, total: expected.length });
    onLoaded?.(matched, expected.length);
  };

  const clear = () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
    setUserArt(null);
    setSummary(null);
    if (dirRef.current) dirRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
    onLoaded?.(0, expectedTotal);
  };

  return (
    <div className="art-loader">
      <div className="art-loader__actions">
        <button type="button" onClick={() => dirRef.current?.click()}>Load art folder…</button>
        <button type="button" onClick={() => fileRef.current?.click()}>Load art files…</button>
        {summary && <button type="button" onClick={clear}>Clear art</button>}
      </div>

      <input ref={dirRef} type="file" multiple hidden onChange={(e) => ingest(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => ingest(e.target.files)} />

      {summary ? (
        <p className="art-loader__summary">
          Loaded {summary.loaded} images, matched {summary.matched} / {summary.total} expected files.
        </p>
      ) : (
        <p className="art-loader__summary art-loader__summary--hint">
          Bring your own art: pick your Middle-earth Quest VASSAL module art folder (or its image
          files) to use in place of the built-in placeholders. Selections last for this browser
          session only.
        </p>
      )}
    </div>
  );
}
