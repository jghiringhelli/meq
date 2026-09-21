import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadCatalog } from './data/loadAssets';
import type { Catalog, GameState, HeroId, MonsterId, Side } from './engine/types';
import {
  newGame, legalMoves, engageableMonsters, canExplore,
  favorHere, charactersHere, plotHere, canCleanse, canDarkPath, canCompleteQuest, otherHeroesHere,
  canDiscardPlot, plotCounterCost,
  canSurvey,
} from './engine/game';
import { applyAction, type Action } from './engine/actions';
import Board from './play/Board';
import CounterBar from './play/CounterBar';
import PlotRow from './play/PlotRow';
import DeckBar from './play/DeckBar';
import RefTabs from './play/RefTabs';
import HeroPanel from './play/HeroPanel';
import CombatBoard from './play/CombatBoard';
import ChoiceModal from './play/ChoiceModal';
import CombatSummaryModal from './play/CombatSummaryModal';
import EncounterPanel from './play/EncounterPanel';
import RevealTray from './play/RevealTray';
import LogPane from './play/LogPane';
import NotesPanel from './play/NotesPanel';
import NewGameSetup from './play/NewGameSetup';
import SauronPanel from './play/SauronPanel';
import SauronSummary from './play/SauronSummary';
import MissionPanel from './play/MissionPanel';
import TurnCycle from './play/TurnCycle';
import { JoinScreen, NetPanel } from './play/NetPanel';
import ArtLoader from './play/ArtLoader';
import AboutTutorial from './play/AboutTutorial';
import SmartNext from './play/SmartNext';
import Collapsible from './play/Collapsible';
import TravelModal from './play/TravelModal';
import { useInspect } from './play/CardInspector';
import ReportBugModal from './play/ReportBugModal';
import { getUserArt, heroArt } from './data/art';
import { pendingHeroTasks } from './engine/turnTasks';
import { advanceHeroSide, missionAware, mulberry32 } from './engine/heroAI';
import { useGameSession } from './net/session';
import { emptyRoster, rolesOf, SAURON_ROLE, markDisconnected, markReconnected, type Roster } from './net/roles';
import { applyRemoteAction, claimRole as hostClaimRole, dropPlayer } from './net/host';
import {
  saveGame, loadSavedGame, recordCompletedGame,
  loadHistory, clearSavedGame, type HistoryEntry,
} from './play/persistence';

export default function App() {
  const catalog = useMemo<Catalog | null>(() => {
    try { return loadCatalog(); } catch (e) { console.error(e); return null; }
  }, []);
  const [reportOpen, setReportOpen] = useState(false);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [state, setState] = useState<GameState | null>(null);
  const [setup, setSetup] = useState(false);
  const [pendingHost, setPendingHost] = useState(false);
  const [joining, setJoining] = useState(false);
  const [resumable, setResumable] = useState(() => loadSavedGame());
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [artMatched, setArtMatched] = useState(() => (getUserArt() ? 1 : 0));
  const [travelTo, setTravelTo] = useState<string | null>(null);
  const [focusMap, setFocusMap] = useState(() => {
    try { return localStorage.getItem('meq-focus-map') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('meq-focus-map', focusMap ? '1' : '0'); } catch { /* ignore */ }
  }, [focusMap]);
  // Per-section open/closed override for the reference/log rail (Collapsible):
  // when a section has no explicit entry here, it falls back to `!focusMap`
  // (collapsed by default in focus mode, expanded otherwise), so the global
  // toggle acts as a bulk collapse/expand while each chip stays individually
  // clickable to peek at just that one thing.
  const [panelOpen, setPanelOpen] = useState<Record<string, boolean>>({});
  const isPanelOpen = (key: string) => panelOpen[key] ?? !focusMap;
  const togglePanel = (key: string) => setPanelOpen((m) => ({ ...m, [key]: !isPanelOpen(key) }));
  const toggleFocusMap = () => { setFocusMap((v) => !v); setPanelOpen({}); };
  const heroRng = useRef(mulberry32(0));

  // ---- Multiplayer session (host-authoritative). Off by default (solo play). ----
  const [roster, setRoster] = useState<Roster | null>(null);
  const rosterRef = useRef<Roster | null>(null);
  rosterRef.current = roster;
  const stateRef = useRef<GameState | null>(null);
  stateRef.current = state;
  const netRef = useRef<ReturnType<typeof useGameSession> | null>(null);
  // A dropped connection doesn't instantly evict a player — give them a grace
  // window to reconnect (tab refresh, wifi hiccup) and resume their role(s)
  // automatically via their stable persistent id (see net/identity.ts),
  // instead of being treated as a stranger who has to re-claim their seat.
  const RECONNECT_GRACE_MS = 3 * 60 * 1000;
  const dropTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const net = useGameSession({
    onState: (s) => setState(s),
    onRoster: (r) => setRoster(r),
    onRemoteAction: (playerId, action) => {
      if (!catalog) return;
      setState((s) => (s ? applyRemoteAction(s, rosterRef.current, catalog, playerId, action) : s));
    },
    onJoin: (playerId) => {
      // Cancel any pending grace-period eviction — this persistent id is back.
      const pending = dropTimersRef.current.get(playerId);
      if (pending) { clearTimeout(pending); dropTimersRef.current.delete(playerId); }
      setRoster((r) => (r ? markReconnected(r, playerId) : r));
      const n = netRef.current; const s = stateRef.current; const r = rosterRef.current;
      if (n && s) n.broadcastState(s);
      if (n && r) n.broadcastRoster(r);
    },
    onClaim: (playerId, name, role, release) => {
      setRoster((r) => {
        const s = stateRef.current; if (!s) return r;
        return hostClaimRole(r, s, playerId, name, role, release);
      });
    },
    onLeave: (playerId) => {
      // Reserve their role(s) — don't hand them to AI/open yet — and only
      // fully release after the grace window if they never come back.
      setRoster((r) => (r ? markDisconnected(r, playerId) : r));
      const timer = setTimeout(() => {
        setRoster((r) => (r ? dropPlayer(r, playerId) : r));
        dropTimersRef.current.delete(playerId);
      }, RECONNECT_GRACE_MS);
      dropTimersRef.current.set(playerId, timer);
    },
    onKicked: () => { window.alert('The host removed you from the game.'); setState(null); },
  });
  netRef.current = net;

  // Host: push authoritative state / roster to clients whenever they change.
  useEffect(() => {
    if (net.role === 'host' && state) net.broadcastState(state);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  // Dev/test hook: expose the live GameState so e2e validation can read the full
  // engine state (and run the same invariant checks as the headless validator)
  // after every UI action. Never enabled in production builds.
  useEffect(() => {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env ?? {};
    if (env.DEV) (window as unknown as { __MEQ_STATE__?: GameState | null }).__MEQ_STATE__ = state;
  }, [state]);
  useEffect(() => {
    if (net.role === 'host' && roster) net.broadcastRoster(roster);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster]);

  // Drive whichever hero roles are AI-controlled: in solo play (no roster)
  // that means the WHOLE hero side, only when a human plays Sauron (the
  // classic solo-vs-AI toggle). Online (host, with a roster) it's per-hero —
  // a role stays AI-driven only while nobody has claimed it (open/ai), or its
  // claimant is disconnected; a connected human owner always acts for
  // themselves via the normal dispatch path, so the AI can never race ahead
  // of them and "steal" their turn.
  const isAiHero = useCallback((heroId: HeroId): boolean => {
    if (net.role !== 'host') return state?.humanSide === 'Sauron';
    if (!roster) return true; // freshly hosted, nobody has claimed anything yet
    const c = roster[heroId];
    return !c || c.kind !== 'human' || c.connected === false;
  }, [net.role, roster, state?.humanSide]);

  useEffect(() => {
    if (!catalog || !state || state.winner) return;
    if (net.role === 'client') return;
    if (state.activeSide !== 'Hero') return;
    // Solo mode keeps the original all-or-nothing gate (no roster to consult).
    if (net.role !== 'host' && state.humanSide !== 'Sauron') return;
    // Online: only bother running the driver if some hero role actually needs
    // the AI right now — otherwise every hero present is human-controlled and
    // this is a no-op loop that would just spin every render.
    if (net.role === 'host' && !state.heroes.some((h) => isAiHero(h.id))) return;
    // Pause the AI hero driver ONLY for the decisions a human Sauron must make;
    // every other pending (hero choices, combat, encounters) is resolved inside
    // advanceHeroSide, so it must be allowed to run to reach/resume them.
    if (state.pendingCombatOrPeril || state.pendingShadowReaction || state.pendingTree) return;
    const next = advanceHeroSide(state, catalog, missionAware, heroRng.current, isAiHero);
    setState(next);
  }, [catalog, state, net.role, isAiHero]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the in-progress game on every change; archive it when it ends.
  useEffect(() => {
    if (!state) return;
    if (net.role === 'client') return;
    if (state.winner) {
      recordCompletedGame(seed, state);
      setHistory(loadHistory());
    } else {
      saveGame(seed, state);
    }
  }, [state, seed]);

  const start = useCallback((heroIds?: HeroId[], humanSide: Side = 'Hero') => {
    if (!catalog) return;
    const fresh = Math.floor(Math.random() * 1e9);
    clearSavedGame();
    setResumable(null);
    setSeed(fresh);
    heroRng.current = mulberry32(fresh ^ 0x9e3779b9);
    const s = newGame(catalog, fresh, heroIds, humanSide);
    setState(s);
    setSetup(false);
    if (pendingHost) {
      setPendingHost(false);
      net.createHost().then(() => setRoster(emptyRoster(s))).catch(() => {});
    }
  }, [catalog, pendingHost, net]);

  const joinGame = useCallback(async (code: string, name: string) => {
    try { await net.join(code, name); setJoining(false); }
    catch { /* error surfaced via net.error */ }
  }, [net]);

  const leaveNet = useCallback(() => {
    net.leave();
    setRoster(null);
    if (net.role === 'client') setState(null);
  }, [net]);

  // "New game": if a game is saved, confirm before discarding it.
  const requestNewGame = useCallback(() => {
    if (resumable && !window.confirm(
      `A saved game is in progress (round ${resumable.state.round}). Delete it and start a new game?`)) {
      return;
    }
    setSetup(true);
  }, [resumable]);

  // Explicitly delete the current/saved game and return to the start screen.
  const deleteGame = useCallback(() => {
    if (!window.confirm('Delete the current game? This cannot be undone.')) return;
    clearSavedGame();
    setResumable(null);
    setState(null);
    setSetup(false);
  }, []);

  // Leave the board for the main menu WITHOUT deleting anything — the game
  // is still autosaved, so the landing screen offers a "Resume" button.
  const backToMenu = useCallback(() => {
    setState(null);
    setSetup(false);
  }, []);

  const resume = useCallback(() => {
    if (resumable) { setSeed(resumable.seed); setState(resumable.state); }
  }, [resumable]);

  const handleClaim = useCallback((role: string, release: boolean) => {
    if (net.role === 'client') { net.claimRole(role, release); return; }
    setRoster((r) => {
      const s = stateRef.current; if (!s) return r;
      return hostClaimRole(r, s, 'host', 'Host', role, release);
    });
  }, [net]);

  const inspect = useInspect();

  // Which side(s) THIS browser's viewer is entitled to see secrets for. Solo /
  // local hotseat play (net off) has no other human on the network to keep
  // secrets from, so it falls back to the game-wide `humanSide` toggle as
  // before. Online, it's derived from the roster: whichever role(s) this
  // exact peer has actually claimed — never the shared `state.humanSide`
  // flag, which reflects only whatever the host picked once at setup and is
  // otherwise meaningless once several distinct humans are connected.
  // NOTE: this hook must run on EVERY render (even before a game exists /
  // `state` is null) to keep hook order stable — it's computed here, above
  // the early `if (!state) return …` below, rather than after it.
  const viewerSide: Side | 'both' | 'none' = useMemo(() => {
    if (!state) return 'none';
    if (net.role === 'off') return state.humanSide ?? 'Hero';
    if (!roster) return 'none';
    const mine = rolesOf(roster, net.playerId);
    const hasSauron = mine.includes(SAURON_ROLE);
    const hasHero = mine.some((r) => r !== SAURON_ROLE);
    return hasSauron && hasHero ? 'both' : hasSauron ? 'Sauron' : hasHero ? 'Hero' : 'none';
  }, [net.role, net.playerId, roster, state]);

  if (!catalog) return <div className="app"><p className="error">Catalog failed to load.</p></div>;
  if (joining) {
    return <JoinScreen net={net} onJoin={joinGame} onCancel={() => { leaveNet(); setJoining(false); }} />;
  }
  if (setup) {
    return <NewGameSetup cat={catalog} onStart={(ids, side) => start(ids, side)} onCancel={() => { setPendingHost(false); setSetup(false); }} />;
  }
  if (!state) {
    return (
      <div className="app start-screen">
        <div className="start-hero">
          <svg className="start-hero__art" viewBox="0 0 600 140" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
            <defs>
              <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2a2013" />
                <stop offset="100%" stopColor="#1a1710" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="600" height="140" fill="url(#skyGrad)" />
            <path d="M0,140 L0,95 L60,50 L110,95 L150,60 L210,100 L260,40 L320,100 L370,70 L420,105 L470,55 L520,100 L560,80 L600,100 L600,140 Z" fill="#241d13" />
            <path d="M280,100 L300,15 L306,15 L310,30 L316,15 L320,15 L340,100 Z" fill="#181209" />
            <rect x="303" y="34" width="4" height="10" fill="#3a2f1e" />
            <circle cx="303" cy="26" r="10" fill="none" stroke="#c9a24b" strokeWidth="1.2" opacity="0.55" />
          </svg>
          <div className="start-hero__content">
            <h1>Middle-earth Quest</h1>
            <span className="subtitle">unofficial fan port — solo, hotseat &amp; online</span>
          </div>
        </div>
        <p className="fan-disclaimer">
          Unofficial, non-commercial fan project — not affiliated with, endorsed by, or
          sponsored by Fantasy Flight Games, Asmodee, or the Tolkien Estate / Middle-earth
          Enterprises. Ships no official artwork; you may optionally load your own copy of
          the VASSAL module's images below, kept in your browser only.
        </p>
        <main className="app-main start-main">
          <section className="start-card start-card--play">
            <h2 className="start-card__title">1. Start playing</h2>
            <div className="start-actions">
              <button className="primary start-cta" onClick={requestNewGame}>🎲 New game</button>
              <button className="secondary start-cta" onClick={() => { setPendingHost(true); setSetup(true); }}>🌐 Host online game</button>
              <button className="secondary start-cta" onClick={() => setJoining(true)}>🔗 Join online game</button>
              {resumable && (
                <>
                  <button className="secondary start-cta" onClick={resume}>
                    ▶ Resume game (round {resumable.state.round})
                  </button>
                  <button className="ghost" onClick={deleteGame}>🗑 Delete saved game</button>
                </>
              )}
            </div>
          </section>

          <section className="start-card start-card--art">
            <h2 className="start-card__title">2. Load the art <span className="start-card__badge">optional</span></h2>
            <p className="start-card__hint">
              The game plays fine with plain text/placeholder cards. If you own the community
              VASSAL module for this game, load it below to see the real scans instead — nothing
              is ever uploaded, and the images stay only in this browser tab.
            </p>
            <ArtLoader onLoaded={(matched) => setArtMatched(matched)} />
            {artMatched > 0 && catalog && (
              <div className="art-preview">
                <p className="art-preview__label">Preview — your loaded art:</p>
                <div className="art-preview__strip">
                  {Object.keys(catalog.heroes).slice(0, 6).map((id) => {
                    const src = heroArt(id).sheet || heroArt(id).figure || heroArt(id).portrait;
                    if (!src) return null;
                    return <img key={id} src={src} alt={catalog.heroes[id].name} className="art-preview__thumb" />;
                  })}
                </div>
              </div>
            )}
          </section>

          {history.length > 0 && (
            <section className="start-card history">
              <h2 className="start-card__title">Recent games</h2>
              <ul>
                {history.slice(0, 8).map((h, i) => (
                  <li key={i}>
                    <span className={`badge ${h.winner === 'Hero' ? 'hero' : 'sauron'}`}>
                      {h.winner ?? 'unfinished'}
                    </span>
                    seed {h.seed} · round {h.round} · {h.winReason ?? ''}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="start-card start-card--learn">
            <h2 className="start-card__title">Learn to play</h2>
            <AboutTutorial />
          </section>
        </main>
      </div>
    );
  }

  const cat = catalog;
  const activeHero = state.heroes[state.activeHeroIndex];
  const inHeroActions = state.phase === 'HeroActions' && !state.pendingCombat &&
    !state.pendingChoice && !state.pendingReveal && !state.pendingTree;

  const seesHeroMission = viewerSide === 'Hero' || viewerSide === 'both';
  // Do I actually control Sauron on THIS browser? Solo/off falls back to the
  // game-wide toggle (viewerSide already does that); online it's the roster
  // claim. Used to gate Sauron's decision UI (SauronPanel, the Combat-or-Peril
  // and Shadow-reaction banners) so a hero-only client's screen is never
  // blocked by a modal for a decision that isn't theirs to make — dispatch was
  // already correctly role-checked server-side, but the UI wasn't.
  const iControlSauron = viewerSide === 'Sauron' || viewerSide === 'both';
  // Do I control the specific hero a pending tree-decision affects? Per-hero
  // (not the coarse viewerSide) since online multiplayer can split hero roles
  // across different people.
  const iControlHero = (heroId: string): boolean => {
    if (net.role === 'off') return state.humanSide === 'Hero';
    if (!roster) return false;
    return rolesOf(roster, net.playerId).includes(heroId);
  };

  // Single mutation seam. Every player intent becomes a serializable Action so
  // it can also be sent over the wire (multiplayer). In a networked client the
  // action is forwarded to the host; otherwise it is applied locally.
  const dispatch = (action: Action) => {
    if (net.role === 'client') { net.sendAction(action); return; }
    setState((s) => {
      if (!s) return s;
      try { return applyAction(s, cat, action); }
      catch (e) { console.warn('Illegal action ignored:', action, e); return s; }
    });
  };

  const doAdvance = () => dispatch({ t: 'advance' });
  // Node click opens the interactive Travel window; the actual move is
  // dispatched once the player confirms which card(s) to spend.
  const doMove = (to: string) => setTravelTo(to);
  const doTravel = (cards: string[]) => { dispatch({ t: 'move', heroId: activeHero.id, to: travelTo!, cards }); setTravelTo(null); };
  const doRest = () => dispatch({ t: 'rest', heroId: activeHero.id });
  const doRestTrain = () => dispatch({ t: 'rest', heroId: activeHero.id, beravorTrain: true });
  const doCombatOrPeril = (choice: 'combat' | 'peril') => dispatch({ t: 'combatOrPeril', choice });
  const doShadowReaction = (cardId: string | null) => dispatch({ t: 'shadowReaction', cardId });
  const doTreeDecision = (optionIndex: number) => dispatch({ t: 'treeDecision', optionIndex });
  const doEngage = (m: MonsterId) => dispatch({ t: 'engage', heroId: activeHero.id, monsterId: m });
  const doEndTurn = () => dispatch({ t: 'endHeroActions' });
  const doChoice = (optId: string) => dispatch({ t: 'choice', optionId: optId });
  const doExplore = () => dispatch({ t: 'explore', heroId: activeHero.id });
  const doDismissCombatSummary = () => dispatch({ t: 'dismissCombatSummary' });
  const doResolveEncounter = () => dispatch({ t: 'resolveEncounter' });
  const doChooseEncounter = (i: number) => dispatch({ t: 'chooseEncounter', index: i });
  const doRevealEncounter = (cardId?: string) => dispatch({ t: 'revealEncounter', cardId });
  const doDismissReveal = () => dispatch({ t: 'dismissReveal' });

  const doDarkPath = () => dispatch({ t: 'darkPath', heroId: activeHero.id });
  const doRetrieveFavor = () => dispatch({ t: 'retrieveFavor', heroId: activeHero.id });
  const doConsult = (c: string, choice: 'favor' | 'ability') => dispatch({ t: 'consult', heroId: activeHero.id, character: c, choice });
  const doQuest = () => dispatch({ t: 'completeQuest', heroId: activeHero.id });
  const doDiscardPlot = () => dispatch({ t: 'discardPlot', heroId: activeHero.id });
  const doCleanse = () => dispatch({ t: 'cleanse', heroId: activeHero.id });
  const doTradeFavor = (to: string) => dispatch({ t: 'tradeFavor', heroId: activeHero.id, toId: to, n: 1 });
  const doSurvey = () => dispatch({ t: 'survey', heroId: activeHero.id });

  const canQuestHere = inHeroActions && canCompleteQuest(state, cat, activeHero.id);
  const econ = {
    favorHere: inHeroActions ? favorHere(state, activeHero.id) : 0,
    characters: inHeroActions ? charactersHere(state, activeHero.id) : [],
    plotHere: inHeroActions ? plotHere(state, cat, activeHero.id) : false,
    canDiscardPlot: inHeroActions ? canDiscardPlot(state, cat, activeHero.id) : false,
    plotCost: inHeroActions ? plotCounterCost(state, cat, activeHero.id) : undefined,
    canCleanse: inHeroActions ? canCleanse(state, cat, activeHero.id) : false,
    canDarkPath: inHeroActions ? canDarkPath(state, activeHero.id) : false,
    canQuest: !!canQuestHere,
    tradeTargets: inHeroActions ? otherHeroesHere(state, activeHero.id).map((h) => h.id) : [],
    canSurvey: inHeroActions ? canSurvey(state, cat, activeHero.id) : false,
    onSurvey: doSurvey,
    onDarkPath: doDarkPath, onRetrieveFavor: doRetrieveFavor, onConsult: doConsult,
    onQuest: doQuest, onDiscardPlot: doDiscardPlot, onCleanse: doCleanse, onTradeFavor: doTradeFavor,
  };

  // Once the hero has taken his turn-ending action (Explore, Rest, etc.),
  // actionsRemaining drops to 0 and Travel is no longer legal — the engine
  // already throws on heroMove in this state, but the board must also stop
  // offering (highlighting) moves so the player isn't shown a dead end.
  const moves = inHeroActions && activeHero.status === 'active' && activeHero.actionsRemaining > 0
    ? legalMoves(cat, activeHero) : [];
  const engageable = inHeroActions ? engageableMonsters(state, activeHero.id) : [];
  const ambush = inHeroActions && engageable.length > 0;
  const exploreHere = inHeroActions && !ambush && canExplore(state, cat, activeHero.id);
  // A card effect (e.g. "A Path Through the Mountains") sometimes asks the hero
  // to choose an adjacent location as a free bonus move. Rather than a separate
  // text-button-only UI, resolve it via the SAME map-click interaction used for
  // regular travel: match each option's label back to a location id and, when
  // it's this human's decision, let the map highlight/click drive the choice
  // too (the text buttons below remain as an always-available fallback).
  const pendingMoveTree = state.pendingTree
    && state.pendingTree.actor === 'hero' && iControlHero(state.pendingTree.heroId)
    && /move to (an? )?adjacent location/i.test(state.pendingTree.prompt)
    ? state.pendingTree
    : null;
  const pendingMoveTargets: { loc: string; idx: number }[] = pendingMoveTree
    ? pendingMoveTree.options
        .map((o, idx) => {
          const loc = Object.keys(cat.locations).find((id) => cat.locations[id]?.name === o.label);
          return loc ? { loc, idx } : null;
        })
        .filter((x): x is { loc: string; idx: number } => !!x)
    : [];
  const doPendingMove = (to: string) => {
    const hit = pendingMoveTargets.find((x) => x.loc === to);
    if (hit) doTreeDecision(hit.idx);
  };

  // One-line live summaries shown on each collapsed rail chip's hover tooltip
  // (Collapsible), so the player can glance at the essentials without opening
  // the full panel.
  const trackSummary = `turn ${state.story.turn}/${state.story.length} · red ${state.story.sauron?.red ?? 0}/18 · infl ${state.sauron.influence}`;
  const decksSummary = `Shadow ${state.sauron.shadowDiscard?.length ?? 0} · Events ${state.sauron.eventDiscard?.length ?? 0}`;
  const plotsSummary = (state.sauron.activePlots ?? []).length
    ? (state.sauron.activePlots ?? []).map((pm) => cat.plots.find((p) => p.id === pm.eventId)?.name ?? pm.eventId).join(', ')
    : 'none active';
  const missionSummary = seesHeroMission && state.secretHeroMission
    ? cat.heroMissions[state.secretHeroMission]?.name ?? '???' : '???';
  const sauronLastSummary = (() => {
    for (let i = state.log.length - 1; i >= 0; i--) {
      const e = state.log[i];
      if (e.side === 'Sauron' && e.type !== 'setup') return e.detail?.slice(0, 60) ?? '';
    }
    return 'no turn yet';
  })();
  const netSummary = (() => {
    const roles = Object.values(roster ?? {});
    const humans = roles.filter((r) => r.kind === 'human').length;
    return `${humans}/${roles.length} seats claimed`;
  })();
  const turnCycleSummary = state.activeSide === 'Sauron' ? "Sauron's turn"
    : `${cat.heroes[activeHero.id]?.name ?? activeHero.id}'s turn`;
  const logSummary = state.log.length ? (state.log[state.log.length - 1].detail?.slice(0, 60) ?? '') : 'empty';

  // The "obvious next thing" for the active hero's turn, in the natural order a
  // player would work through their Explore actions: fight an ambush, retrieve
  // free favor, consult a waiting character (opens a favor/ability choice),
  // complete a satisfied quest, then explore — falling back to ending the turn
  // only once none of those remain. Optional-but-costly moves (breaking a plot,
  // cleansing corruption) are deliberately NOT auto-suggested here: they stay as
  // manual buttons and only appear in the "you could still…" warning before
  // ending the turn.
  const prettyName = (id: string) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const nextHeroStep = (): { label: string; run: () => void } | null => {
    if (!inHeroActions || activeHero.status !== 'active') return null;
    if (ambush && engageable.length) {
      const m = engageable[0];
      const name = cat.monsters[m]?.name ?? cat.minions[m]?.name ?? m;
      return { label: `Fight ${name} ▶`, run: () => doEngage(m) };
    }
    if (activeHero.actionsRemaining > 0) {
      if (econ.favorHere > 0) {
        return { label: `Retrieve ${econ.favorHere} favor ▶`, run: doRetrieveFavor };
      }
      if (econ.characters.length > 0) {
        const c = econ.characters[0];
        return {
          label: `Consult ${prettyName(c)} ▶`,
          run: () => inspect({
            title: prettyName(c), subtitle: 'Consult this character',
            text: 'Gain 2 favor, or recruit them as a permanent ally (they leave the board and travel with you).',
            actions: [
              { label: '✦✦ Gain 2 favor', onClick: () => doConsult(c, 'favor') },
              { label: '→ Recruit ability', onClick: () => doConsult(c, 'ability') },
            ],
          }),
        };
      }
      if (canQuestHere) return { label: 'Complete quest ▶', run: doQuest };
    }
    if (exploreHere) return { label: 'Explore ▶', run: doExplore };
    return null;
  };
  const heroStep = nextHeroStep();

  // Smart next-step button: only when the human runs the heroes (a human Sauron
  // is guided by the SauronPanel instead). It ends the hero turn or advances the
  // dark side's AI step, glowing when nothing is left and warning otherwise.
  const travelModalOpen = !!(travelTo && inHeroActions && !ambush);
  const anyPending = !!(state.pendingCombat || state.pendingChoice || state.pendingEncounter
    || state.pendingReveal || state.pendingTree || state.pendingCombatOrPeril || state.pendingShadowReaction
    || state.lastCombatSummary || travelModalOpen);
  const smartMode: 'endTurn' | 'advance' | null =
    state.winner || anyPending || iControlSauron ? null
      : inHeroActions ? 'endTurn'
        : state.phase !== 'HeroActions' ? 'advance' : null;
  const smartTasks = smartMode === 'endTurn' && !heroStep ? pendingHeroTasks(state, cat) : [];
  const smartLabel = smartMode === 'endTurn'
    ? (heroStep ? heroStep.label : 'End hero turn ▶')
    : (SMART_ADVANCE_LABELS[state.phase] ?? 'Continue ▶');
  const smartProceed = smartMode === 'endTurn' && heroStep ? heroStep.run : doEndTurn;
  const smartReady = smartMode === 'endTurn' ? (!!heroStep || smartTasks.length === 0) : true;

  return (
    <div className="app">
      <header className="app-header">
        {smartMode && (
          <SmartNext
            label={smartLabel}
            ready={smartReady}
            tasks={smartTasks}
            onProceed={smartMode === 'endTurn' ? smartProceed : doAdvance}
          />
        )}
        <h1>Middle-earth Quest</h1>
        <span className="subtitle">Turn {state.story.turn} · {PHASE_STEPS.find((s) => s.phases.includes(state.phase))?.label ?? state.phase}
          {state.winner ? ` · WINNER: ${state.winner}` : ''}</span>
        <PhaseTrack phase={state.phase} />
        <div style={{ flex: 1 }} />
        {!state.winner && state.phase !== 'HeroActions' && !state.pendingChoice && !state.pendingCombat
          && !state.pendingReveal && !state.pendingTree
          && !(iControlSauron && state.activeSide === 'Sauron') && (
          <button className="primary" onClick={doAdvance}>Advance phase ▶</button>
        )}
        <button className="ghost" title={focusMap ? 'Show the reference bars and side panels again' : 'Collapse the reference bars and side panels into a slim rail for a bigger map (each can still be opened individually)'}
          onClick={toggleFocusMap}>{focusMap ? '☰ Show panels' : '🗺 Focus map'}</button>
        <button className="ghost" title="Describe a bug and file a GitHub issue with a full technical snapshot"
          onClick={() => setReportOpen(true)}>Report a problem</button>
        <button className="ghost" title="Leave the board for the main menu (the game stays saved — use Resume to come back)"
          onClick={backToMenu}>☰ Main menu</button>
        <button className="ghost" title="Delete the current game and return to the menu"
          onClick={deleteGame}>Delete game</button>
      </header>

      <div className="top-rail">
        <Collapsible id="track" icon="📊" label="Track" summary={trackSummary} open={isPanelOpen('track')} onToggle={togglePanel}>
          <CounterBar state={state} cat={cat} revealHeroMission={seesHeroMission} />
        </Collapsible>
        <Collapsible id="decks" icon="🂠" label="Discards" summary={decksSummary} open={isPanelOpen('decks')} onToggle={togglePanel}>
          <DeckBar state={state} cat={cat} />
        </Collapsible>
        <Collapsible id="plots" icon="🚩" label="Plots" summary={plotsSummary} open={isPanelOpen('plots')} onToggle={togglePanel}>
          <PlotRow state={state} cat={cat} />
        </Collapsible>
      </div>
      <RefTabs state={state} cat={cat} />

      <main className="app-main play-layout">
        <Board
          state={state} cat={cat}
          moveTargets={pendingMoveTree ? pendingMoveTargets.map((x) => x.loc) : (ambush ? [] : moves.map((m) => m.to))}
          onMove={pendingMoveTree ? doPendingMove : (inHeroActions && !ambush ? doMove : undefined)}
          consultable={econ.characters} consultDisabled={!inHeroActions || activeHero.actionsRemaining <= 0 || ambush}
          onConsult={doConsult}
        />
        <aside className={`side${focusMap ? ' side-narrow' : ''}`}>
          <div className="side-rail">
            {seesHeroMission && (
              <Collapsible id="mission" icon="🎯" label="Mission" summary={missionSummary} open={isPanelOpen('mission')} onToggle={togglePanel}>
                <MissionPanel state={state} cat={cat} />
              </Collapsible>
            )}
            {seesHeroMission && (
              <Collapsible id="sauronSummary" icon="👁" label="Sauron recap" summary={sauronLastSummary} open={isPanelOpen('sauronSummary')} onToggle={togglePanel}>
                <SauronSummary state={state} />
              </Collapsible>
            )}
            {net.role !== 'off' && (
              <Collapsible id="net" icon="🌐" label="Online" summary={netSummary} open={isPanelOpen('net')} onToggle={togglePanel} dir="col">
                <NetPanel net={net} state={state} cat={cat} roster={roster} onClaim={handleClaim} onKick={net.kick} />
              </Collapsible>
            )}
            <Collapsible id="turncycle" icon="🔄" label="Turn order" summary={turnCycleSummary} open={isPanelOpen('turncycle')} onToggle={togglePanel} dir="col">
              <TurnCycle state={state} cat={cat} />
            </Collapsible>
          </div>
          <HeroPanel
            state={state} cat={cat} active={inHeroActions}
            engageable={engageable} canExplore={exploreHere} ambush={ambush}
            onRest={doRest} onRestTrain={doRestTrain} onEngage={doEngage} onEndTurn={doEndTurn} onExplore={doExplore}
            econ={econ}
          />
          <Collapsible id="log" icon="📜" label="Log" summary={logSummary} open={isPanelOpen('log')} onToggle={togglePanel}>
            <LogPane state={state} revealSide={viewerSide} />
          </Collapsible>
          <NotesPanel seed={seed} />
        </aside>
      </main>

      {state.pendingCombat && (
        <CombatBoard state={state} cat={cat}
          onChoose={state.pendingChoice ? doChoice : undefined} />
      )}

      {state.lastCombatSummary && !state.pendingCombat && (
        <CombatSummaryModal summary={state.lastCombatSummary} onContinue={doDismissCombatSummary} />
      )}

      {iControlSauron && net.role !== 'client' && state.activeSide === 'Sauron'
        && !state.winner && !state.pendingCombat && !state.pendingChoice && (
        <SauronPanel state={state} cat={cat} onApply={(next) => setState(next)} />
      )}

      {state.pendingChoice && !state.pendingCombat && !state.lastCombatSummary && (
        <ChoiceModal cat={cat} choice={state.pendingChoice} onChoose={doChoice} />
      )}

      {state.pendingEncounter && !state.pendingCombat && !state.pendingChoice && (
        <EncounterPanel state={state} cat={cat} onResolve={doResolveEncounter} onChoose={doChooseEncounter} onReveal={doRevealEncounter} />
      )}

      {state.pendingReveal && !state.pendingCombat && !state.pendingChoice && !state.pendingEncounter && (
        <RevealTray state={state} cat={cat} onDismiss={doDismissReveal} />
      )}

      {state.pendingCombatOrPeril && !state.pendingCombat && iControlSauron && (
        <div className="banner combat-or-peril">
          <span>Combat or Peril at <b>{cat.locations[state.pendingCombatOrPeril.loc]?.name ?? state.pendingCombatOrPeril.loc}</b> — Sauron chooses:</span>
          <button onClick={() => doCombatOrPeril('combat')}>Force combat</button>
          <button onClick={() => doCombatOrPeril('peril')}>Draw Peril</button>
        </div>
      )}

      {state.pendingShadowReaction && iControlSauron && (
        <div className="banner shadow-reaction">
          <span>
            Shadow reaction (<b>{state.pendingShadowReaction.window}</b>
            {state.pendingShadowReaction.heroId ? <> vs <b>{cat.heroes[state.pendingShadowReaction.heroId]?.name ?? state.pendingShadowReaction.heroId}</b></> : null})
            {' '}— Sauron may play one Shadow card:
          </span>
          {state.pendingShadowReaction.options.map((o) => (
            <button key={o.id} onClick={() => doShadowReaction(o.id)}>
              {cat.shadow[o.id]?.name ?? o.label} (pool {cat.shadow[o.id]?.poolRequirement ?? '?'})
            </button>
          ))}
          <button onClick={() => doShadowReaction(null)}>Pass</button>
        </div>
      )}

      {state.pendingTree
        && ((state.pendingTree.actor === 'sauron' && iControlSauron)
          || (state.pendingTree.actor === 'hero' && iControlHero(state.pendingTree.heroId))) && (
        pendingMoveTree && pendingMoveTargets.length > 0 ? (
          // A "choose an adjacent location" decision is resolved by clicking the
          // highlighted location on the map itself — a full blocking overlay
          // would cover the map and defeat that interaction, so this stays a
          // prominent, fixed (not buried at the bottom of the page) non-blocking
          // banner instead.
          <div className="tree-decision-float">
            <b>{state.pendingTree.source}</b> — {state.pendingTree.prompt} (or click the highlighted location on the map)
            {state.pendingTree.options.map((o, i) => (
              <button key={i} disabled={!o.enabled} onClick={() => doTreeDecision(i)}>
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          // Every other card/encounter effect-tree decision (e.g. Ill-met
          // Company's "lose 2 favor OR Sauron draws 2 Corruption") blocks the
          // whole screen until resolved — this used to be an easy-to-miss
          // banner at the very bottom of the page, letting play continue with
          // the choice never actually applied.
          <div className="tree-decision-overlay" role="dialog" aria-modal="true">
            <div className="tree-decision-panel">
              <h3>{state.pendingTree.source}</h3>
              <p>{state.pendingTree.prompt}</p>
              <div className="tree-decision-actions">
                {state.pendingTree.options.map((o, i) => (
                  <button key={i} disabled={!o.enabled} onClick={() => doTreeDecision(i)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      )}

      {travelTo && inHeroActions && !ambush && (
        <TravelModal
          cat={cat} hero={activeHero} to={travelTo}
          onConfirm={doTravel} onCancel={() => setTravelTo(null)}
        />
      )}

      {state.winner && (
        <div className="banner">Game over — {state.winner} wins: {state.winReason}</div>
      )}

      {reportOpen && (
        <ReportBugModal seed={seed} state={state} onClose={() => setReportOpen(false)} />
      )}
    </div>
  );
}

const PHASE_STEPS: { label: string; phases: string[] }[] = [
  { label: 'Hero Refresh', phases: ['HeroRefresh'] },
  { label: 'Hero Actions', phases: ['HeroActions'] },
  { label: 'Story', phases: ['SauronRefresh'] },
  { label: 'Plot / Event', phases: ['SauronEvents'] },
  { label: 'Action', phases: ['SauronMinions'] },
  { label: 'Advance', phases: ['StoryAdvance'] },
];

// Friendly caption for the smart button when it advances the (AI) dark side —
// it names the step the click is about to run.
const SMART_ADVANCE_LABELS: Record<string, string> = {
  HeroRefresh: 'Begin hero actions ▶',
  SauronRefresh: 'Sauron: story step ▶',
  SauronEvents: 'Sauron: plot & events ▶',
  SauronMinions: 'Sauron: dark actions ▶',
  StoryAdvance: 'Advance the story ▶',
};

function PhaseTrack({ phase }: { phase: string }) {
  return (
    <div className="phase-track">
      {PHASE_STEPS.map((s) => (
        <span key={s.label} className={`phase-step${s.phases.includes(phase) ? ' active' : ''}`}>
          {s.label}
        </span>
      ))}
    </div>
  );
}
