// A stable per-browser player identity, persisted across reloads/reconnects.
// PeerJS assigns a fresh random network peer-id on every `join()` call, which
// is useless for recognizing "the same person came back" after a disconnect
// (tab refresh, wifi hiccup, laptop sleep). This id is generated once and
// kept in localStorage so a reconnecting client can be matched back to the
// role(s) it previously claimed instead of joining as a brand-new stranger.
const KEY = 'meq.player-identity.v1';

function randomId(): string {
  // Not cryptographically significant — just needs to be unique per browser.
  return `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function getLocalPlayerId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = randomId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // localStorage disabled/unavailable (private mode, quota) — fall back to
    // a per-session id; reconnection just won't survive a reload here.
    return randomId();
  }
}
