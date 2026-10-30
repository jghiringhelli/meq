import { useState } from 'react';
import type { Catalog, GameState } from '../engine/types';

interface Step { label: string; tip: string; current?: boolean }
interface Block { phase: string[]; title: string; side: 'sauron' | 'hero'; steps: Step[] }

// Always-visible "where are we" guide (bottom-right): the round as a column of
// phases, each with its steps and a tooltip; the live phase is lit up. Phase
// granularity follows the engine's phases, so it never claims a finer step than
// the game actually tracks.
function buildBlocks(state: GameState): Block[] {
  const first = state.story.turn <= 1;
  const hero = state.heroes[state.activeHeroIndex];
  const moved = !!(hero?.hasMovedThisTurn || (hero?.travelStepsThisTurn ?? 0) > 0);
  const enc = !!hero?.encounterStepDone;
  return [
    {
      phase: ['SauronRefresh'], title: 'Rally & Story', side: 'sauron',
      steps: [
        { label: 'Hero Rally', tip: 'Influence at each active hero’s location is discarded (unless a Shadow Stronghold).' },
        { label: first ? 'Story (skipped T1)' : 'Story', tip: first ? 'The first turn skips the Story Step: no marker advances.' : 'The hero marker climbs 2 and each active plot advances its Sauron marker.' },
      ],
    },
    {
      phase: ['SauronEvents'], title: 'Plot & Event', side: 'sauron',
      steps: [
        { label: first ? 'Plot (skipped T1)' : 'Plot', tip: 'Sauron plays at most one Plot card (not on the first turn).' },
        { label: 'Event', tip: 'An Event card is drawn and resolved (3 drawn if one side is dominant).' },
      ],
    },
    {
      phase: ['SauronMinions'], title: 'Sauron Actions', side: 'sauron',
      steps: [
        { label: 'Influence · Draw · Command', tip: 'Spend the Eye’s actions: place influence, draw Shadow/Plot cards, command minions and monsters.' },
        { label: 'Shadow cards', tip: 'Shadow cards may be played in response during the round.' },
      ],
    },
    {
      phase: ['HeroRefresh'], title: 'Hero Refresh', side: 'hero',
      steps: [
        { label: 'Draw', tip: 'The active hero draws cards equal to his fortitude (the starting hand covers turn 1).' },
        { label: 'Shadow window', tip: 'Sauron may play one Shadow card at the start of the hero turn.' },
      ],
    },
    {
      phase: ['HeroActions'], title: 'Hero Actions', side: 'hero',
      steps: [
        { label: 'Rest', tip: 'Optional: recover life. Rest must happen before Travel.', current: !moved && !enc },
        { label: 'Travel', tip: 'Move along paths; foes and peril may interrupt.', current: moved && !enc },
        { label: 'Encounter', tip: 'Explore the location (final step of the turn).', current: enc },
      ],
    },
  ];
}

export default function PhaseTracker({ state, cat }: { state: GameState; cat: Catalog }) {
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerHeight >= 900);
  if (state.phase === 'GameOver') return null;
  const blocks = buildBlocks(state);
  const hero = state.heroes[state.activeHeroIndex];
  const heroName = hero ? cat.heroes[hero.id]?.name ?? hero.id : '';
  const who = state.activeSide === 'Sauron' ? 'Sauron' : heroName;

  return (
    <aside className={`phase-tracker ${open ? '' : 'collapsed'}`} data-testid="phase-tracker" aria-label="Turn tracker">
      <button className="pt-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={open ? 'Hide the turn tracker' : 'Show the turn tracker'}>
        <span>📖 Turn {state.story.turn}/{state.story.length} · {who}</span>
        <span className="pt-caret">{open ? '▾' : '▴'}</span>
      </button>
      {open && (
        <div className="pt-body">
          {blocks.map((b) => {
            const active = b.phase.includes(state.phase);
            return (
              <div key={b.title} className={`pt-block pt-${b.side} ${active ? 'active' : ''}`}>
                <div className="pt-title">{b.side === 'sauron' ? '👁' : '🛡'} {b.title}</div>
                <ul>
                  {b.steps.map((st) => (
                    <li key={st.label} title={st.tip}
                      className={active && (st.current ?? true) ? 'current' : ''}>{st.label}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
