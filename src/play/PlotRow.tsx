import type { Catalog, GameState, StoryMarkerColor } from '../engine/types';
import { plotArt } from '../data/art';
import { useInspect } from './CardInspector';

const MARKER_COLOR: Record<StoryMarkerColor, string> = {
  yellow: '#d9b32b', red: '#b23b3b', black: '#5a5a66',
};

export default function PlotRow({ state, cat }: { state: GameState; cat: Catalog }) {
  const activePlots = state.sauron.activePlots ?? [];
  const events = state.sauron.activeEvents;
  const inspect = useInspect();
  return (
    <div className="plot-row">
      <span className="plot-title">Sauron's Plots</span>
      {activePlots.length === 0 && <span className="plot-empty">no active plots</span>}
      {activePlots.map((pm) => {
        const p = cat.plots.find((x) => x.id === pm.eventId);
        if (!p) return null;
        const marker = (p.marker ?? 'red') as StoryMarkerColor;
        const img = plotArt(p.image);
        return (
          <div
            key={pm.eventId}
            className="plot-card"
            onClick={() => inspect({
              title: p.name, img,
              subtitle: `${marker} +${p.advance ?? 1} · counter: discard ${p.favorToCounter ?? 0} favor`,
              lines: [
                p.affectsText ? `Affects: ${p.affectsText}` : '',
                p.condition ? `Requires: ${p.condition}` : '',
              ].filter(Boolean),
              text: p.effect ?? '',
            })}
            title={`${p.name}\nAffects: ${p.affectsText ?? '-'}\n${p.condition ? 'Requires: ' + p.condition + '\n' : ''}${p.effect ?? ''}\nCounter: discard ${p.favorToCounter ?? 0} favor`}
          >
            {img && <img className="plot-art" src={img} alt={p.name} />}
            <span className="plot-name">{p.name}</span>
            <span className="plot-meta">
              <span className="plot-marker" style={{ background: MARKER_COLOR[marker] }}>
                {marker[0].toUpperCase()}+{p.advance ?? 1}
              </span>
              <span className="plot-counter" title="favor to counter">&#9873;{p.favorToCounter ?? 0}</span>
            </span>
          </div>
        );
      })}
      {events.length > 0 && (
        <>
          <span className="plot-title plot-title--events">Events &mdash; turn {state.story.turn}</span>
          {events.map((pm) => {
            const ev = cat.events.find((e) => e.id === pm.eventId);
            return (
              <div key={'ev-' + pm.eventId} className="plot-card plot-card--event"
                onClick={() => inspect({ title: ev?.name ?? pm.eventId, subtitle: `Event · turn ${state.story.turn}`, text: ev?.text ?? '' })}
                title={ev?.text ?? ''}>
                <span className="plot-name">{ev?.name ?? pm.eventId}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
