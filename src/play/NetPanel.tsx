import { useState } from 'react';
import type { Catalog, GameState } from '../engine/types';
import type { Net } from '../net/session';
import { allRoles, SAURON_ROLE, type Roster } from '../net/roles';
import ArtLoader from './ArtLoader';

/** Start-screen form for joining an existing online game by code. */
export function JoinScreen({ net, onJoin, onCancel }: {
  net: Net; onJoin: (code: string, name: string) => void; onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const ready = code.trim().length >= 4 && name.trim().length > 0 && !net.connected;
  return (
    <div className="app">
      <header className="app-header"><h1>Join online game</h1></header>
      <main className="app-main">
        <div className="net-form">
          <label>Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="e.g. Frodo" />
          </label>
          <label>Game code
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="ABCDE" />
          </label>
          {net.error && <p className="error">{net.error}</p>}
          <div className="start-actions">
            <button className="primary" disabled={!ready} onClick={() => onJoin(code, name)}>Connect</button>
            <button className="ghost" onClick={onCancel}>Back</button>
          </div>
          <p className="muted">You'll connect directly to the host — no server involved. Ask the host for the 5-letter game code.</p>
          <ArtLoader />
        </div>
      </main>
    </div>
  );
}

const roleLabel = (cat: Catalog, role: string) =>
  role === SAURON_ROLE ? 'Sauron' : (cat.heroes[role]?.name ?? role);

/** In-game panel: shows the game code, seated players, and role controls. */
export function NetPanel({ net, state, cat, roster, onClaim, onKick }: {
  net: Net; state: GameState; cat: Catalog; roster: Roster | null;
  onClaim: (role: string, release: boolean) => void;
  onKick: (playerId: string) => void;
}) {
  if (net.role === 'off') return null;
  const roles = allRoles(state);
  const me = net.playerId;
  return (
    <section className="panel net-panel">
      <h3>
        Online · <span className="net-role">{net.role}</span>
        {net.gameId && <> · code <code className="net-code">{net.gameId}</code></>}
        <span className={`net-dot ${net.connected ? 'ok' : 'bad'}`} title={net.connected ? 'connected' : 'disconnected'} />
      </h3>

      {net.role === 'host' && (
        <div className="net-players">
          <strong>{net.peers.length + 1} connected</strong>
          <ul>
            <li>You (host)</li>
            {net.peers.map((p) => (
              <li key={p.playerId}>
                {p.name}
                <button className="ghost tiny" title="Remove player" onClick={() => onKick(p.playerId)}>kick</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="net-roles">
        {roles.map((role) => {
          const c = roster?.[role];
          const owned = c?.kind === 'human';
          const mine = owned && c.playerId === me;
          const who = !c || c.kind === 'open' ? 'AI / open' : c.kind === 'ai' ? 'AI' : c.name;
          return (
            <div key={role} className="net-role-row">
              <span className="net-role-name">{roleLabel(cat, role)}</span>
              <span className="net-role-who">{who}</span>
              {mine
                ? <button className="ghost tiny" onClick={() => onClaim(role, true)}>release</button>
                : (!owned && <button className="ghost tiny" onClick={() => onClaim(role, false)}>claim</button>)}
            </div>
          );
        })}
      </div>

      <button className="ghost tiny" onClick={net.leave}>Leave game</button>
    </section>
  );
}
