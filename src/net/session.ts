// Peer-to-peer multiplayer transport (WebRTC via PeerJS). Host-authoritative:
// the host holds the one true GameState, applies every action (its own and
// remote), and broadcasts the resulting state to all clients. Clients never
// mutate state locally — they send Actions to the host and render whatever
// state the host pushes back.
//
// This module is transport-only. The host's game logic (applyAction, AI,
// persistence) lives in App via the callbacks passed to useGameSession, so the
// engine stays completely unaware of the network.
import { useCallback, useEffect, useRef, useState } from 'react';
import Peer, { type DataConnection } from 'peerjs';
import type { GameState } from '../engine/types';
import type { Action } from '../engine/actions';
import type { Roster, RoleId } from './roles';
import { getLocalPlayerId } from './identity';

/** Game ids are short + human-shareable; we prefix to avoid PeerJS id clashes. */
const ID_PREFIX = 'meq-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
export function newGameCode(len = 5): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
const toPeerId = (code: string) => ID_PREFIX + code.trim().toUpperCase();

/**
 * Signalling-broker options. Defaults to the public PeerJS cloud broker (great
 * for zero-infra static hosting). A local broker can be selected for tests or
 * self-hosting via a `globalThis.__MEQ_PEER__` override or VITE_PEER_* env vars.
 * Only WebRTC signalling metadata reaches the broker — never game state.
 */
function peerOptions(): import('peerjs').PeerOptions | undefined {
  const g = (globalThis as { __MEQ_PEER__?: { host?: string; port?: number; path?: string; secure?: boolean } }).__MEQ_PEER__;
  if (g?.host) return { host: g.host, port: g.port ?? 9000, path: g.path ?? '/', secure: !!g.secure };
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  if (env.VITE_PEER_HOST) {
    return { host: env.VITE_PEER_HOST, port: Number(env.VITE_PEER_PORT) || 9000, path: env.VITE_PEER_PATH ?? '/', secure: env.VITE_PEER_SECURE === 'true' };
  }
  return undefined; // PeerJS default cloud broker
}

export type NetRole = 'off' | 'host' | 'client';

export interface PeerInfo { playerId: string; name: string }

/** Wire protocol. */
export type Msg =
  | { type: 'hello'; name: string; playerId: string }
  | { type: 'state'; state: GameState }
  | { type: 'roster'; roster: Roster }
  | { type: 'action'; action: Action }
  | { type: 'claim'; role: RoleId }
  | { type: 'release'; role: RoleId }
  | { type: 'kicked' };

export interface SessionCallbacks {
  /** Host: a client (or the host UI) submitted an action. Apply + rebroadcast. */
  onRemoteAction?: (playerId: string, action: Action) => void;
  /** Client: the host pushed a new authoritative state. */
  onState?: (state: GameState) => void;
  /** Client: the host pushed the seated-players roster. */
  onRoster?: (roster: Roster) => void;
  /** Host: a client asked to (un)claim a role. */
  onClaim?: (playerId: string, name: string, role: RoleId, release: boolean) => void;
  /** Host: a player connected — `playerId` is their STABLE persistent id (see
   *  net/identity.ts), so a reconnecting player is recognized as the same
   *  person even though PeerJS gave their new connection a different network
   *  peer id underneath. */
  onJoin?: (playerId: string, name: string) => void;
  /** Host: a player disconnected (network-level) — `playerId` is their stable
   *  persistent id. Does NOT necessarily mean they're gone for good; App.tsx
   *  pairs this with a grace-period timer before fully releasing their role(s). */
  onLeave?: (playerId: string) => void;
  /** Client: the host kicked us. */
  onKicked?: () => void;
}

export interface Net {
  role: NetRole;
  gameId: string | null;
  playerId: string;
  connected: boolean;
  error: string | null;
  peers: PeerInfo[];
  createHost: () => Promise<string>;
  join: (code: string, name: string) => Promise<void>;
  leave: () => void;
  /** Client → host: submit an action. On host this is a no-op (host applies directly). */
  sendAction: (action: Action) => void;
  /** Client → host: (un)claim a role. */
  claimRole: (role: RoleId, release?: boolean) => void;
  /** Host → clients: push the authoritative state. */
  broadcastState: (state: GameState) => void;
  /** Host → clients: push the roster. */
  broadcastRoster: (roster: Roster) => void;
  /** Host: disconnect a player. */
  kick: (playerId: string) => void;
}

/**
 * React hook owning the PeerJS session. `cbs` may change every render; we read
 * it through a ref so connection handlers always see the latest callbacks.
 */
export function useGameSession(cbs: SessionCallbacks): Net {
  const [role, setRole] = useState<NetRole>('off');
  const [gameId, setGameId] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);

  const peerRef = useRef<Peer | null>(null);
  const connsRef = useRef<Map<string, DataConnection>>(new Map()); // host: network peer-id → conn
  // Host: stable persistent playerId (see net/identity.ts) ↔ current live
  // network peer-id. A reconnecting client gets a NEW network peer-id every
  // time (PeerJS assigns it randomly), but sends its unchanging persistent id
  // in `hello` — this map is how we recognize "the same person is back" and
  // route messages to whichever connection they currently hold.
  const personaToConnRef = useRef<Map<string, string>>(new Map());  // persistent id → network peer-id
  const connToPersonaRef = useRef<Map<string, string>>(new Map());  // network peer-id → persistent id
  const hostConnRef = useRef<DataConnection | null>(null);          // client: conn to host
  const cbsRef = useRef(cbs);
  cbsRef.current = cbs;

  const send = (conn: DataConnection, msg: Msg) => { try { conn.send(msg); } catch { /* dropped */ } };

  const broadcast = useCallback((msg: Msg) => {
    for (const conn of connsRef.current.values()) send(conn, msg);
  }, []);

  const createHost = useCallback(async (): Promise<string> => {
    const code = newGameCode();
    const peer = new Peer(toPeerId(code), peerOptions());
    peerRef.current = peer;
    return new Promise<string>((resolve, reject) => {
      peer.on('open', () => {
        setRole('host');
        setGameId(code);
        setPlayerId('host');
        setConnected(true);
        resolve(code);
      });
      peer.on('error', (e) => { setError(String(e)); reject(e); });
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          connsRef.current.set(conn.peer, conn);
        });
        conn.on('data', (raw) => {
          const msg = raw as Msg;
          if (msg.type === 'hello') {
            personaToConnRef.current.set(msg.playerId, conn.peer);
            connToPersonaRef.current.set(conn.peer, msg.playerId);
            setPeers((p) => [...p.filter((x) => x.playerId !== msg.playerId), { playerId: msg.playerId, name: msg.name }]);
            cbsRef.current.onJoin?.(msg.playerId, msg.name);
          } else if (msg.type === 'action') {
            const pid = connToPersonaRef.current.get(conn.peer) ?? conn.peer;
            cbsRef.current.onRemoteAction?.(pid, msg.action);
          } else if (msg.type === 'claim' || msg.type === 'release') {
            const pid = connToPersonaRef.current.get(conn.peer) ?? conn.peer;
            const name = peersNameOf(pid);
            cbsRef.current.onClaim?.(pid, name, msg.role, msg.type === 'release');
          }
        });
        conn.on('close', () => {
          connsRef.current.delete(conn.peer);
          const pid = connToPersonaRef.current.get(conn.peer);
          connToPersonaRef.current.delete(conn.peer);
          if (pid) {
            // Only clear the persona→conn pointer if it still points at THIS
            // (now-closed) connection — a fast reconnect may already have
            // registered a newer one via a fresh 'hello'.
            if (personaToConnRef.current.get(pid) === conn.peer) personaToConnRef.current.delete(pid);
            setPeers((p) => p.filter((x) => x.playerId !== pid));
            cbsRef.current.onLeave?.(pid);
          }
        });
      });
    });
  }, []);

  const peersNameOf = (pid: string): string => {
    for (const info of peersRef.current) if (info.playerId === pid) return info.name;
    return pid;
  };
  const peersRef = useRef<PeerInfo[]>([]);
  peersRef.current = peers;

  const join = useCallback(async (code: string, name: string): Promise<void> => {
    const myId = getLocalPlayerId();
    setPlayerId(myId); // stable identity, known immediately — no round trip needed
    const peer = new Peer(undefined as unknown as string, peerOptions());
    peerRef.current = peer;
    return new Promise<void>((resolve, reject) => {
      peer.on('open', () => {
        const conn = peer.connect(toPeerId(code), { reliable: true });
        hostConnRef.current = conn;
        conn.on('open', () => {
          setRole('client');
          setGameId(code);
          setConnected(true);
          send(conn, { type: 'hello', name, playerId: myId });
          resolve();
        });
        conn.on('data', (raw) => {
          const msg = raw as Msg;
          if (msg.type === 'state') cbsRef.current.onState?.(msg.state);
          else if (msg.type === 'roster') cbsRef.current.onRoster?.(msg.roster);
          else if (msg.type === 'kicked') { cbsRef.current.onKicked?.(); leave(); }
        });
        conn.on('close', () => { setConnected(false); setError('Disconnected from host.'); });
      });
      peer.on('error', (e) => { setError(String(e)); reject(e); });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = useCallback(() => {
    connsRef.current.forEach((c) => c.close());
    connsRef.current.clear();
    personaToConnRef.current.clear();
    connToPersonaRef.current.clear();
    hostConnRef.current?.close();
    hostConnRef.current = null;
    peerRef.current?.destroy();
    peerRef.current = null;
    setRole('off'); setGameId(null); setConnected(false); setPeers([]);
  }, []);

  const sendAction = useCallback((action: Action) => {
    const conn = hostConnRef.current;
    if (conn) send(conn, { type: 'action', action });
  }, []);

  const claimRole = useCallback((role: RoleId, release = false) => {
    const conn = hostConnRef.current;
    if (conn) send(conn, { type: release ? 'release' : 'claim', role });
  }, []);

  const broadcastState = useCallback((state: GameState) => {
    broadcast({ type: 'state', state });
  }, [broadcast]);

  const broadcastRoster = useCallback((roster: Roster) => {
    broadcast({ type: 'roster', roster });
  }, [broadcast]);

  const kick = useCallback((pid: string) => {
    const connId = personaToConnRef.current.get(pid);
    const conn = connId ? connsRef.current.get(connId) : undefined;
    if (conn) { send(conn, { type: 'kicked' }); conn.close(); connsRef.current.delete(conn.peer); }
    if (connId) { personaToConnRef.current.delete(pid); connToPersonaRef.current.delete(connId); }
    setPeers((p) => p.filter((x) => x.playerId !== pid));
    cbsRef.current.onLeave?.(pid);
  }, []);

  useEffect(() => () => { peerRef.current?.destroy(); }, []);

  return {
    role, gameId, playerId, connected, error, peers,
    createHost, join, leave, sendAction, claimRole, broadcastState, broadcastRoster, kick,
  };
}
