// BYO-art loader: lets a user supply their own copy of the VASSAL module art
// at runtime. The public build ships no copyrighted art, so this is how players
// see the "real" scans. The canonical way is to pick the VASSAL module file
// itself (a `.vmod`, which is just a ZIP): we unzip it in the browser and index
// every image inside. A folder / individual image files still work as a
// fallback. Selections use object URLs, so they last for the current page
// session only — reloading the page clears them and the game falls back to the
// built-in placeholders.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildArtIndex, matchExpected } from '../data/artMatch';
import { setUserArt, expectedArtNames } from '../data/art';

interface Props {
  /** Called after a load or clear with (matched, totalExpected). */
  onLoaded?: (matched: number, total: number) => void;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** Direct download of the Middle-earth Quest VASSAL module (v1.6). */
export const VMOD_URL = 'https://obj.vassalengine.org/images/0/05/Middle_Earth_Quest_1.6.vmod';

export default function ArtLoader({ onLoaded }: Props) {
  const vmodRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);
  const [summary, setSummary] = useState<{ loaded: number; matched: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expectedTotal = useMemo(() => expectedArtNames().length, []);

  // `webkitdirectory` isn't in the React input types; set it imperatively so a
  // whole folder (including subfolders) can be picked in one go.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '');
    dirRef.current?.setAttribute('directory', '');
  }, []);

  // Release object URLs when this control unmounts.
  useEffect(() => () => { for (const u of urlsRef.current) URL.revokeObjectURL(u); }, []);

  const dropOldUrls = () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
  };

  /** Index a freshly-collected {name, url} set and report the match count. */
  const applyFiles = (files: { name: string; url: string }[]) => {
    const index = buildArtIndex(files);
    setUserArt(index);
    const expected = expectedArtNames();
    const matched = expected.filter((f) => matchExpected(f, index)).length;
    setSummary({ loaded: files.length, matched, total: expected.length });
    onLoaded?.(matched, expected.length);
  };

  const ingest = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    dropOldUrls();
    const files: { name: string; url: string }[] = [];
    for (const file of Array.from(fileList)) {
      const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (!IMAGE_RE.test(name)) continue;
      const url = URL.createObjectURL(file);
      urlsRef.current.push(url);
      files.push({ name, url });
    }
    applyFiles(files);
  };

  /** Unzip a .vmod (a renamed ZIP) and index every image entry inside it. */
  const ingestVmod = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      dropOldUrls();
      const files: { name: string; url: string }[] = [];
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const base = entry.name.replace(/^.*[\\/]/, '');
        if (!IMAGE_RE.test(base)) continue;
        const blob = await entry.async('blob');
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        files.push({ name: base, url });
      }
      if (!files.length) {
        setError('No images found inside that file — is it the Middle-earth Quest .vmod module?');
        return;
      }
      applyFiles(files);
    } catch {
      setError('Could not read that file as a VASSAL module (.vmod / .zip).');
    } finally {
      setBusy(false);
      if (vmodRef.current) vmodRef.current.value = '';
    }
  };

  const clear = () => {
    dropOldUrls();
    setUserArt(null);
    setSummary(null);
    setError(null);
    if (vmodRef.current) vmodRef.current.value = '';
    if (dirRef.current) dirRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
    onLoaded?.(0, expectedTotal);
  };

  return (
    <div className="art-loader">
      <div className="art-loader__actions">
        <button type="button" onClick={() => vmodRef.current?.click()} disabled={busy}>
          {busy ? 'Loading module…' : 'Load VASSAL module (.vmod)…'}
        </button>
        {summary && <button type="button" onClick={clear} disabled={busy}>Clear art</button>}
      </div>
      <div className="art-loader__actions art-loader__actions--secondary">
        <span className="muted">or, from extracted files:</span>
        <button type="button" onClick={() => dirRef.current?.click()} disabled={busy}>Load art folder…</button>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>Load art files…</button>
      </div>

      <input ref={vmodRef} type="file" accept=".vmod,.zip" hidden onChange={(e) => ingestVmod(e.target.files?.[0] ?? null)} />
      <input ref={dirRef} type="file" multiple hidden onChange={(e) => ingest(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => ingest(e.target.files)} />

      {error && <p className="art-loader__summary art-loader__summary--error">{error}</p>}

      {summary ? (
        <p className="art-loader__summary">
          Loaded {summary.loaded} images, matched {summary.matched} / {summary.total} expected files.
        </p>
      ) : (
        <p className="art-loader__summary art-loader__summary--hint">
          Bring your own art: pick the Middle-earth Quest VASSAL module{' '}
          (<a href={VMOD_URL} target="_blank" rel="noreferrer"><code>.vmod</code> download</a>) —
          no need to unzip it; the app reads the images inside and matches them to the cards.
          Selections last for this browser session only.
        </p>
      )}
    </div>
  );
}
