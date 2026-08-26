import type { Catalog, GameState } from '../engine/types';

interface Props { state: GameState; cat: Catalog; }

export default function MissionPanel({ state, cat }: Props) {
  const hm = state.secretHeroMission ? cat.heroMissions[state.secretHeroMission] : undefined;
  const activeHero = state.activeSide === 'Hero' ? state.heroes[state.activeHeroIndex] : undefined;
  const aq = activeHero?.quests;
  const activeStart = aq?.startingQuestId ? cat.quests[aq.startingQuestId] : undefined;
  const activeAdv = aq?.advancedQuestId ? cat.quests[aq.advancedQuestId] : undefined;
  return (
    <div className="mission-panel">
      {activeHero && activeStart && (
        <div className={`active-quest-card${aq?.startingDone ? ' quest-done' : ''}`}>
          <div className="active-quest-head">
            <span className="q-icon" aria-hidden>◈</span>
            <span className="q-title">{cat.heroes[activeHero.id]?.name ?? activeHero.id}’s mission</span>
          </div>
          <strong className="q-name">{activeStart.name} {aq?.startingDone ? '✓' : ''}</strong>
          <p className="q-task"><em>Task:</em> {activeStart.task}</p>
          {activeStart.reward && <p className="q-reward"><em>Reward:</em> {activeStart.reward}</p>}
          {activeAdv && aq?.advancedUnlocked && (
            <div className="active-quest-adv">
              <strong className="q-name">Advanced: {activeAdv.name} {aq?.advancedDone ? '✓' : ''}</strong>
              <p className="q-task"><em>Task:</em> {activeAdv.task}</p>
            </div>
          )}
        </div>
      )}
      <h3>Your secret mission</h3>
      {hm ? (
        <div className="mission-card">
          <strong>{hm.name}</strong>
          <p>{hm.text}</p>
        </div>
      ) : <p className="muted">No mission drawn.</p>}
      <h3>Quests</h3>
      <ul className="quest-list">
        {state.heroes.map((h) => {
          const q = h.quests ?? { startingDone: false, advancedDone: false };
          return (
            <li key={h.id}>
              <span className="q-hero">{cat.heroes[h.id]?.name ?? h.id}</span>
              <span className={`q-step${q.startingDone ? ' done' : ''}`}>Starting {q.startingDone ? '✓' : '○'}</span>
              <span className={`q-step${q.advancedDone ? ' done' : ''}`}>Advanced {q.advancedDone ? '✓' : '○'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
