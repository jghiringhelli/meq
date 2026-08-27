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
import EncounterPanel from './play/EncounterPanel';
import RevealTray from './play/RevealTray';
import LogPane from './play/LogPane';
import NewGameSetup from './play/NewGameSetup';
import SauronPanel from './play/SauronPanel';
import MissionPanel from './play/MissionPanel';
import TurnCycle from './play/TurnCycle';
import { JoinScreen, NetPanel } from './play/NetPanel';
import ArtLoader from './play/ArtLoader';
import AboutTutorial from './play/AboutTutorial';
import { advanceHeroSide, missionAware, mulberry32 } from './engine/heroAI';
import { useGameSession } from './net/session';
import { emptyRoster, type Roster } from './net/roles';
import { applyRemoteAction, claimRole as hostClaimRole, dropPlayer } from './net/host';
import {
  saveGame, loadSavedGame, recordCompletedGame, exportProblemReport,
  loadHistory, clearSavedGame, type HistoryEntry,
} from './play/persistence';

export default function App() {
  const catalog = useMemo<Catalog | null>(() => {
    try { return loadCatalog(); } catch (e) { console.error(e); return null; }
  }, []);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [state, setState] = useState<GameState | null>(null);
  const [setup, setSetup] = useState(false);
  const [pendingHost, setPendingHost] = useState(false);
  const [joining, setJoining] = useState(false);
  const [resumable, setResumable] = useState(() => loadSavedGame());
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const heroRng = useRef(mulberry32(0));

  // ---- Multiplayer session (host-authoritative). Off by default (solo play). ----
  const [roster, setRoster] = useState<Roster | null>(null);
  const rosterRef = useRef<Roster | null>(null);
  rosterRef.current = roster;
  const stateRef = useRef<GameState | null>(null);
  stateRef.current = state;
  const netRef = useRef<ReturnType<typeof useGameSession> | null>(null);

  const net = useGameSession({
    onState: (s) => setState(s),
    onRoster: (r) => setRoster(r),
    onRemoteAction: (playerId, action) => {
      if (!catalog) return;
      setState((s) => (s ? applyRemoteAction(s, rosterRef.current, catalog, playerId, action) : s));
    },
    onJoin: () => {
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
    onLeave: (playerId) => setRoster((r) => dropPlayer(r, playerId)),
    onKicked: () => { window.alert('The host removed you from the game.'); setState(null); },
  });
  netRef.current = net;

  // Host: push authoritative state / roster to clients whenever they change.
  useEffect(() => {
    if (net.role === 'host' && state) net.broadcastState(state);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  useEffect(() => {
    if (net.role === 'host' && roster) net.broadcastRoster(roster);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster]);

  // When a human plays Sauron, the heroes are AI-driven: whenever control is on
  // the heroes' side, run their turns autonomously until it returns to Sauron.
  useEffect(() => {
    if (!catalog || !state || state.winner) return;
    if (net.role === 'client') return;
    if (state.humanSide !== 'Sauron' || state.activeSide !== 'Hero') return;
    // Pause the AI hero driver ONLY for the decisions a human Sauron must make;
    // every other pending (hero choices, combat, encounters) is resolved inside
    // advanceHeroSide, so it must be allowed to run to reach/resume them.
    if (state.pendingCombatOrPeril || state.pendingShadowReaction) return;
    const next = advanceHeroSide(state, catalog, missionAware, heroRng.current);
    setState(next);
  }, [catalog, state]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (!catalog) return <div className="app"><p className="error">Catalog failed to load.</p></div>;
  if (joining) {
    return <JoinScreen net={net} onJoin={joinGame} onCancel={() => { leaveNet(); setJoining(false); }} />;
  }
  if (setup) {
    return <NewGameSetup cat={catalog} onStart={(ids, side) => start(ids, side)} onCancel={() => { setPendingHost(false); setSetup(false); }} />;
  }
  if (!state) {
    return (
      <div className="app">
        <header className="app-header"><h1>Middle-earth Quest</h1>
          <span className="subtitle">unofficial fan port · M1</span></header>
        <main className="app-main">
          <p>{Object.keys(catalog.heroes).length} heroes · {Object.keys(catalog.locations).length} locations · {Object.keys(catalog.combatCards).length} combat cards loaded.</p>
          <div className="start-actions">
            <button className="primary" onClick={requestNewGame}>New game</button>
            <button className="secondary" onClick={() => { setPendingHost(true); setSetup(true); }}>Host online game</button>
            <button className="secondary" onClick={() => setJoining(true)}>Join online game</button>
            {resumable && (
              <>
                <button className="secondary" onClick={resume}>
                  Resume game (round {resumable.state.round})
                </button>
                <button className="ghost" onClick={deleteGame}>
                  Delete saved game
                </button>
              </>
            )}
          </div>
          <ArtLoader />
          <AboutTutorial />
          {history.length > 0 && (
            <section className="history">
              <h2>Recent games</h2>
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
        </main>
      </div>
    );
  }

  const cat = catalog;
  const activeHero = state.heroes[state.activeHeroIndex];
  const inHeroActions = state.phase === 'HeroActions' && !state.pendingCombat && !state.pendingChoice && !state.pendingReveal;

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
  const doMove = (to: string) => dispatch({ t: 'move', heroId: activeHero.id, to });
  const doRest = () => dispatch({ t: 'rest', heroId: activeHero.id });
  const doRestTrain = () => dispatch({ t: 'rest', heroId: activeHero.id, beravorTrain: true });
  const doCombatOrPeril = (choice: 'combat' | 'peril') => dispatch({ t: 'combatOrPeril', choice });
  const doShadowReaction = (cardId: string | null) => dispatch({ t: 'shadowReaction', cardId });
  const doEngage = (m: MonsterId) => dispatch({ t: 'engage', heroId: activeHero.id, monsterId: m });
  const doEndTurn = () => dispatch({ t: 'endHeroActions' });
  const doChoice = (optId: string) => dispatch({ t: 'choice', optionId: optId });
  const doExplore = () => dispatch({ t: 'explore', heroId: activeHero.id });
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

  const moves = inHeroActions && activeHero.status === 'active' ? legalMoves(cat, activeHero) : [];
  const engageable = inHeroActions ? engageableMonsters(state, activeHero.id) : [];
  const ambush = inHeroActions && engageable.length > 0;
  const exploreHere = inHeroActions && !ambush && canExplore(state, cat, activeHero.id);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Middle-earth Quest</h1>
        <span className="subtitle">round {state.round}
          {state.winner ? ` · WINNER: ${state.winner}` : ''}</span>
        <PhaseTrack phase={state.phase} />
        <div style={{ flex: 1 }} />
        {!state.winner && state.phase !== 'HeroActions' && !state.pendingChoice && !state.pendingCombat
          && !state.pendingReveal
          && !(state.humanSide === 'Sauron' && state.activeSide === 'Sauron') && (
          <button className="primary" onClick={doAdvance}>Advance phase ▶</button>
        )}
        <button className="ghost" title="Download the full game state + log to report a bug"
          onClick={() => exportProblemReport(seed, state)}>Report a problem</button>
        <button className="ghost" title="Delete the current game and return to the menu"
          onClick={deleteGame}>Delete game</button>
      </header>

      <CounterBar state={state} cat={cat} />
      <DeckBar state={state} cat={cat} />
      <RefTabs state={state} cat={cat} />
      <PlotRow state={state} cat={cat} />

      <main className="app-main play-layout">
        <Board
          state={state} cat={cat}
          moveTargets={ambush ? [] : moves.map((m) => m.to)}
          onMove={inHeroActions && !ambush ? doMove : undefined}
        />
        <aside className="side">
          {state.humanSide !== 'Sauron' && <MissionPanel state={state} cat={cat} />}
          <NetPanel net={net} state={state} cat={cat} roster={roster} onClaim={handleClaim} onKick={net.kick} />
          <TurnCycle state={state} cat={cat} />
          <HeroPanel
            state={state} cat={cat} active={inHeroActions}
            engageable={engageable} canExplore={exploreHere} ambush={ambush}
            onRest={doRest} onRestTrain={doRestTrain} onEngage={doEngage} onEndTurn={doEndTurn} onExplore={doExplore}
            econ={econ}
          />
          <LogPane state={state} />
        </aside>
      </main>

      {state.pendingCombat && (
        <CombatBoard state={state} cat={cat}
          onChoose={state.pendingChoice ? doChoice : undefined} />
      )}

      {state.humanSide === 'Sauron' && state.activeSide === 'Sauron'
        && !state.winner && !state.pendingCombat && !state.pendingChoice && (
        <SauronPanel state={state} cat={cat} onApply={(next) => setState(next)} />
      )}

      {state.pendingChoice && !state.pendingCombat && (
        <ChoiceModal choice={state.pendingChoice} onChoose={doChoice} />
      )}

      {state.pendingEncounter && !state.pendingCombat && !state.pendingChoice && (
        <EncounterPanel state={state} cat={cat} onResolve={doResolveEncounter} onChoose={doChooseEncounter} onReveal={doRevealEncounter} />
      )}

      {state.pendingReveal && !state.pendingCombat && !state.pendingChoice && !state.pendingEncounter && (
        <RevealTray state={state} cat={cat} onDismiss={doDismissReveal} />
      )}

      {state.pendingCombatOrPeril && !state.pendingCombat && state.humanSide === 'Sauron' && (
        <div className="banner combat-or-peril">
          <span>Combat or Peril at <b>{cat.locations[state.pendingCombatOrPeril.loc]?.name ?? state.pendingCombatOrPeril.loc}</b> — Sauron chooses:</span>
          <button onClick={() => doCombatOrPeril('combat')}>Force combat</button>
          <button onClick={() => doCombatOrPeril('peril')}>Draw Peril</button>
        </div>
      )}

      {state.pendingShadowReaction && state.humanSide === 'Sauron' && (
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

      {state.winner && (
        <div className="banner">Game over — {state.winner} wins: {state.winReason}</div>
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
