import { useMemo, useState } from 'react';
import type { GameState } from '../engine/types';
import { dumpLogJson } from '../engine/log';

// Group the many log event types into a few human-friendly filters.
const GROUPS: Record<string, (t: string) => boolean> = {
  All: () => true,
  Combat: (t) => t.startsWith('combat') || t === 'minion-ability',
  Sauron: (t) => t === 'sauron-ai' || t === 'phase',
  Hero: (t) => t.startsWith('hero') || t === 'move' || t === 'encounter' || t === 'peril',
};

function downloadLog(state: GameState, revealSide: 'Hero' | 'Sauron' | 'both' | 'none') {
  const blob = new Blob([dumpLogJson(state, true, revealSide)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meq-log-seed${state.seed}-turn${state.story?.turn ?? 0}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** `revealSide`: which side's secret mission this viewer is entitled to see in
 *  the downloaded JSON — pass the actual online role owner's side, or 'both'
 *  for solo play (no other human to keep it secret from). Defaults to 'both'
 *  for backward compatibility with solo/local callers. */
export default function LogPane({ state, revealSide = 'both' }: {
  state: GameState; revealSide?: 'Hero' | 'Sauron' | 'both' | 'none';
}) {
  const [filter, setFilter] = useState<string>('All');
  const filtered = useMemo(() => {
    const pred = GROUPS[filter] ?? GROUPS.All;
    return state.log.filter((e) => pred(e.type)).slice(-60).reverse();
  }, [state.log, filter]);
  return (
    <div className="log-pane">
      <div className="log-title">
        Log
        <span className="log-filters">
          {Object.keys(GROUPS).map((g) => (
            <button key={g} className={`log-filter${filter === g ? ' active' : ''}`}
              onClick={() => setFilter(g)}>{g}</button>
          ))}
          <button className="log-filter" title="Download full structured JSON log"
            onClick={() => downloadLog(state, revealSide)}>⭳ JSON</button>
        </span>
      </div>
      <div className="log-body">
        {filtered.map((e, i) => (
          <div key={i} className={`log-line log-${e.type}`}>
            <span className="log-actor">{e.actor}</span> {e.detail}
          </div>
        ))}
        {filtered.length === 0 && <div className="log-line log-empty">no matching entries</div>}
      </div>
    </div>
  );
}
