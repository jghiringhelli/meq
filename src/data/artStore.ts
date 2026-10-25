// Permanent browser cache for the user's own art (BYO .vmod). Blobs live in
// IndexedDB so the module only has to be loaded once per browser; nothing
// leaves the device and nothing copyrighted is shipped with the app.
import { buildArtIndex } from './artMatch';
import { setUserArt } from './art';

const DB = 'meq-art';
const STORE = 'files';

export interface StoredArt { name: string; blob: Blob }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Replace the cached art with `files`. Best effort: failures never break the game. */
export async function saveArt(files: StoredArt[]): Promise<boolean> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    st.clear();
    for (const f of files) st.put(f.blob, f.name);
    await done(tx);
    db.close();
    void navigator.storage?.persist?.();
    return true;
  } catch {
    return false;
  }
}

export async function clearStoredArt(): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
    db.close();
  } catch { /* nothing cached */ }
}

/** Load cached art (if any) and install it. Returns the object URLs created. */
export async function restoreArt(): Promise<string[] | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    const keys = await new Promise<IDBValidKey[]>((res, rej) => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const blobs = await new Promise<Blob[]>((res, rej) => { const r = st.getAll(); r.onsuccess = () => res(r.result as Blob[]); r.onerror = () => rej(r.error); });
    db.close();
    if (!keys.length) return null;
    const urls: string[] = [];
    const files = keys.map((k, i) => { const url = URL.createObjectURL(blobs[i]); urls.push(url); return { name: String(k), url }; });
    setUserArt(buildArtIndex(files));
    return urls;
  } catch {
    return null;
  }
}
