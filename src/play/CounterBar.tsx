import type { Catalog, GameState } from '../engine/types';
import { STAGE_SIZE, SHADOW_FALLS, STORY_FINALE } from '../engine/types';
import { shadowPoolArt } from '../data/art';

// The physical MEQ story track: START (0) → 18 spaces, Finale at 18, The Shadow
// Falls at the midpoint (10), stage boundaries every 6 spaces. The green Hero
// marker climbs toward the Finale; the three Sauron markers (yellow/red/black)
// climb per his active plots. This draws the real track with marker tokens at
// their live positions instead of bare numbers.
function StoryTrackViz({ state }: { state: GameState }) {
  const hero = Math.min(state.story.heroMarker ?? 0, STORY_FINALE);
  const s = state.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const spaces = STORY_FINALE + 1; // 0..18 inclusive
  return (
    <div className="story-track" title="Story Track — Hero (green) vs Sauron (Y/R/K) toward the Finale">
      {Array.from({ length: spaces }, (_, i) => {
        const isFalls = i === SHADOW_FALLS;
        const isFinale = i === STORY_FINALE;
        const isStageEdge = i > 0 && i % STAGE_SIZE === 0;
        const cls = ['track-cell', isFalls ? 'falls' : '', isFinale ? 'finale' : '',
          isStageEdge && !isFalls && !isFinale ? 'stage-edge' : ''].filter(Boolean).join(' ');
        const markers: string[] = [];
        if (s.yellow === i) markers.push('y');
        if (s.red === i) markers.push('r');
        if (s.black === i) markers.push('k');
        return (
          <div key={i} className={cls}
            title={isFalls ? 'The Shadow Falls' : isFinale ? 'Finale' : `space ${i}`}>
            <span className="track-num">{isFinale ? '★' : i}</span>
            <div className="track-tokens">
              {hero === i && <span className="mk mk-hero" title="Hero marker">H</span>}
              {markers.map((m) => <span key={m} className={`mk mk-${m}`}>{m.toUpperCase()}</span>)}
            </div>
          </div>
        );
      })}
      {state.story.finale && <span className="track-finale-flag">FINALE</span>}
    </div>
  );
}

// The three Lidless Eye Action Tracks (rulebook pp.16–19). Each track has three
// spaces of degrading yield; a covered space (an Eye token) shows how much of
// this game's action economy Sauron has already spent. Tokens persist across his
// Action steps until the fourth resets the Eye.
const EYE_TRACKS: { key: 'influence' | 'draw' | 'command'; label: string; slots: number[] }[] = [
  { key: 'influence', label: 'Influence', slots: [6, 5, 4] },
  { key: 'draw', label: 'Draw', slots: [2, 2, 1] },
  { key: 'command', label: 'Command', slots: [3, 2, 1] },
];
function EyeTracksViz({ state }: { state: GameState }) {
  const eye = state.sauron.eye ?? { influence: 0, draw: 0, command: 0 };
  return (
    <div className="counter eye-tracks" title="Lidless Eye Action Tracks — a covered space (👁) is an action Sauron has taken; yields degrade 6/5/4, 2/2/1, 3/2/1 until the 4th token resets the Eye">
      <span className="label">Lidless Eye</span>
      {EYE_TRACKS.map(({ key, label, slots }) => (
        <span key={key} className="eye-track-row">
          <span className="eye-track-name">{label}</span>
          {slots.map((v, i) => (
            <span key={i} className={`eye-slot${i < eye[key] ? ' covered' : ''}`} title={`space ${v}${i < eye[key] ? ' — covered' : ''}`}>
              {i < eye[key] ? '👁' : v}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

export default function CounterBar({ state, cat }: { state: GameState; cat: Catalog }) {
  return (
    <>
      <StoryTrackViz state={state} />
      <div className="counter-bar" data-testid="hud">
      <div className="counter story">
        <span className="label">Story Track</span>
        <span className="value">turn {state.story.turn} / {state.story.length}</span>
        <span className="sub">dark progress {state.story.sauronProgress}</span>
      </div>
      <div className="counter markers">
        <span className="label">Story Markers</span>
        <span className="value" title="Hero marker toward the Finale">green {state.story.heroMarker ?? 0}</span>
        <span className="sub">
          <span style={{ color: '#e0c94a' }}>Y{state.story.sauron?.yellow ?? 0}</span>{' '}
          <span style={{ color: '#c0553b' }}>R{state.story.sauron?.red ?? 0}</span>{' '}
          <span style={{ color: '#888' }}>K{state.story.sauron?.black ?? 0}</span>
          {' '}/ {STORY_FINALE}
        </span>
      </div>
      <div className="counter sauron">
        <span className="label">Sauron</span>
        <span className="value">influence {state.sauron.influence}</span>
        <img className="shadow-pool-viz" src={shadowPoolArt(state.sauron.influence)}
          alt="" title={`Shadow Pool — ${Math.min(12, state.sauron.influence)} / 12 influence placed`} />
        <span className="sub" title="hidden from the heroes">mission: ???</span>
      </div>
      <EyeTracksViz state={state} />
      {state.secretHeroMission && cat.heroMissions[state.secretHeroMission] && (
        <div className="counter mission" title={cat.heroMissions[state.secretHeroMission].text}>
          <span className="label">Your Mission</span>
          <span className="value">{cat.heroMissions[state.secretHeroMission].name}</span>
          <span className="sub">{cat.heroMissions[state.secretHeroMission].text}</span>
        </div>
      )}
      {state.heroes.map((h) => (
        <div key={h.id} className={`counter hero ${state.heroes[state.activeHeroIndex].id === h.id ? 'active' : ''}`}>
          <span className="label">{cat.heroes[h.id].name}</span>
          <span className="value" title="life pool cards · damage">🂠 {h.deck.length} · 🩸 {h.damagePool.length}</span>
          <span className="sub">corruption {h.corruption} · favor {h.favor}</span>
        </div>
      ))}
      </div>
    </>
  );
}
