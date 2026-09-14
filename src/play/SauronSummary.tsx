import { useMemo, useState } from 'react';
import type { GameState, LogEvent } from '../engine/types';

// Derive a faithful recap of what Sauron did, from the structured log:
//  - `setup`: the one-time game-setup actions (minions activated, starting plot,
//    influence, hands drawn) — actor 'Sauron', type 'setup'.
//  - `lastTurn`: the most recent contiguous block of Sauron-side actions (his last
//    full turn: story/plot/event/action steps).
// Both are public information; Sauron's hidden hand is never listed here.
function deriveSummary(log: LogEvent[]): { setup: LogEvent[]; lastTurn: LogEvent[]; round: number } {
  const setup = log.filter((e) => e.type === 'setup' && e.actor === 'Sauron');
  let end = -1;
  for (let i = 0; i < log.length; i++) {
    if (log[i].side === 'Sauron' && log[i].type !== 'setup') end = i;
  }
  let lastTurn: LogEvent[] = [];
  let round = 0;
  if (end >= 0) {
    let start = end;
    while (start > 0 && log[start - 1].side === 'Sauron' && log[start - 1].type !== 'setup') start--;
    lastTurn = log.slice(start, end + 1);
    round = log[end].round ?? 0;
  }
  return { setup, lastTurn, round };
}

function Line({ e }: { e: LogEvent }) {
  const phase = e.type === 'phase';
  return (
    <div className={`ss-line${phase ? ' ss-phase' : ''}`}>
      {e.detail}
    </div>
  );
}

export default function SauronSummary({ state }: { state: GameState }) {
  const { setup, lastTurn, round } = useMemo(() => deriveSummary(state.log), [state.log]);
  // Show the one-time setup recap expanded by default at the very start of the
  // game (before Sauron has taken a turn) so the player sees what the Eye set up;
  // once Sauron has played, it collapses to keep the panel compact.
  const [showSetup, setShowSetup] = useState(lastTurn.length === 0);

  if (setup.length === 0 && lastTurn.length === 0) return null;

  return (
    <div className="sauron-summary">
      <div className="ss-title">
        <span>🛡 Sauron</span>
        {setup.length > 0 && (
          <button className="ss-toggle" onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? 'Hide setup' : 'Show setup'}
          </button>
        )}
      </div>
      {showSetup && setup.length > 0 && (
        <div className="ss-block ss-setup">
          <div className="ss-sub">Initial setup</div>
          {setup.map((e, i) => <Line key={`s${i}`} e={e} />)}
        </div>
      )}
      {lastTurn.length > 0 ? (
        <div className="ss-block">
          <div className="ss-sub">Sauron's last turn{round ? ` · round ${round}` : ''}</div>
          {lastTurn.map((e, i) => <Line key={`t${i}`} e={e} />)}
        </div>
      ) : (
        <div className="ss-block ss-empty">Sauron has not taken a turn yet.</div>
      )}
    </div>
  );
}
