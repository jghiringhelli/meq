import type { Catalog, GameState, StoryMarkerColor } from '../engine/types';
import { questHowTo } from '../engine/quests';
import { plotArt } from '../data/art';
import { useInspect } from './CardInspector';

/** Everything public that is currently in play on the map, in one list: Sauron's
 *  plots, event missions, this turn's events and every hero's Starting/Advanced
 *  quest (with where it points and any "combat X instead of Encounter cards"
 *  substitution). Secret hero missions are never listed. Same for both sides. */
export function activeCount(state: GameState): number {
  const q = state.heroes.reduce((n, h) => n + (h.quests?.startingDone ? 0 : 1) + (h.quests?.advancedUnlocked && !h.quests.advancedDone ? 1 : 0), 0);
  return (state.sauron.activePlots ?? []).length + (state.sauron.activeEventPlots ?? []).length + q;
}

export default function ActivePanel({ state, cat }: { state: GameState; cat: Catalog }) {
  const inspect = useInspect();
  const locName = (id?: string) => (id ? cat.locations[id]?.name ?? id : '—');
  const plots = state.sauron.activePlots ?? [];
  const missions = state.sauron.activeEventPlots ?? [];
  const events = state.sauron.activeEvents ?? [];
  const markerLocs = (heroId: string) =>
    Object.entries(state.map.questAt ?? {}).filter(([, ids]) => ids.includes(heroId)).map(([l]) => locName(l));

  return (
    <div className="active-panel">
      <section>
        <h4>Sauron's plots ({plots.length}/3)</h4>
        {plots.length === 0 && <p className="muted">none</p>}
        {plots.map((pm, i) => {
          const p = cat.plots.find((x) => x.id === pm.eventId);
          if (!p) return null;
          const marker = (p.marker ?? 'red') as StoryMarkerColor;
          return (
            <details key={pm.eventId} className="active-item">
              <summary>
                <b>#{i + 1} {p.name}</b> — {marker} +{p.advance ?? 1}/turn · at <b>{locName(pm.location)}</b> · counter {p.favorToCounter ?? 0} favor
              </summary>
              <p>{p.effect}</p>
              {p.affectsText && <p className="muted">Affects: {p.affectsText}</p>}
              {plotArt(p.image) && <img src={plotArt(p.image)} alt={p.name} className="active-art"
                onClick={() => inspect({ title: p.name, img: plotArt(p.image), text: p.effect ?? '' })} />}
            </details>
          );
        })}
      </section>

      <section>
        <h4>Event missions ({missions.length})</h4>
        {missions.length === 0 && <p className="muted">none</p>}
        {missions.map((pm) => {
          const p = cat.plots.find((x) => x.id === pm.eventId);
          const ev = p ? undefined : cat.events.find((x) => x.id === pm.eventId);
          return (
            <details key={pm.eventId} className="active-item">
              <summary><b>{p?.name ?? ev?.name ?? pm.eventId}</b> — at <b>{locName(pm.location)}</b> (Explore there to {p ? 'discard' : 'resolve'})</summary>
              <p>{p?.effect ?? ev?.text ?? ''}</p>
            </details>
          );
        })}
      </section>

      {events.length > 0 && (
        <section>
          <h4>Events this turn</h4>
          {events.map((pm) => {
            const ev = cat.events.find((e) => e.id === pm.eventId);
            return (
              <details key={pm.eventId} className="active-item">
                <summary><b>{ev?.name ?? pm.eventId}</b></summary>
                <p>{ev?.text}</p>
              </details>
            );
          })}
        </section>
      )}

      <section>
        <h4>Hero quests</h4>
        {state.heroes.map((h) => {
          const q = h.quests;
          if (!q) return null;
          const start = q.startingQuestId ? cat.quests[q.startingQuestId] : undefined;
          const adv = q.advancedQuestId ? cat.quests[q.advancedQuestId] : undefined;
          const where = markerLocs(h.id);
          const subs = (q.combats ?? []).map((c) => `${locName(c.location)} → ${cat.monsters[c.monster]?.name ?? c.monster}`);
          return (
            <details key={h.id} className="active-item">
              <summary>
                <b>{cat.heroes[h.id]?.name ?? h.id}</b>
                {' — '}{q.startingDone ? 'Starting ✓' : start?.name ?? 'Starting'}
                {q.advancedUnlocked ? ` · ${q.advancedDone ? 'Advanced ✓' : adv?.name ?? 'Advanced'}` : ''}
                {where.length ? ` · @ ${where.join(', ')}` : ''}
              </summary>
              {start && (
                <div>
                  <p><b>{start.name}</b> {q.startingDone && '✓'} — <em>Task:</em> {start.task}</p>
                  {!q.startingDone && <p className="muted">{questHowTo(cat, start)}</p>}
                  {start.reward && <p className="muted"><em>Reward:</em> {start.reward}</p>}
                </div>
              )}
              {adv && q.advancedUnlocked && (
                <div>
                  <p><b>{adv.name}</b> {q.advancedDone && '✓'} — <em>Task:</em> {adv.task}</p>
                  {!q.advancedDone && <p className="muted">{questHowTo(cat, adv)}</p>}
                </div>
              )}
              {subs.length > 0 && <p className="muted">Encounter substitution: {subs.join('; ')}</p>}
            </details>
          );
        })}
      </section>
    </div>
  );
}
