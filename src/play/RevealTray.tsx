import type { Catalog, GameState, CardId } from '../engine/types';
import { eventArt, perilArt } from '../data/art';

interface Props {
  state: GameState;
  cat: Catalog;
  onDismiss: () => void;
}

// Look up a drawn card's display fields from whichever deck raised the reveal.
function cardInfo(cat: Catalog, deck: 'events' | 'perils', id: CardId): { name: string; text: string; art: string } {
  if (deck === 'events') {
    const e = cat.events.find((x) => x.id === id);
    return { name: e?.name ?? id, text: e?.text ?? '', art: eventArt(id) };
  }
  const p = cat.perils[id];
  return { name: p?.name ?? id, text: p?.effect ?? '', art: perilArt(id) };
}

// A fixed, semi-transparent tray that surfaces a draw-and-reveal (Event Step /
// Peril): every drawn card is shown with the resolved one highlighted so the
// player can read it, then confirm with OK. The backdrop passes pointer events
// through so the map behind stays pannable; only the tray is interactive.
export default function RevealTray({ state, cat, onDismiss }: Props) {
  const pr = state.pendingReveal;
  if (!pr) return null;
  return (
    <div className="enc-tray-backdrop">
      <div className="enc-tray">
        <h2>{pr.title}</h2>
        {pr.note && <p className="enc-tray-hint">{pr.note}</p>}
        {pr.resultNote && <p className="enc-tray-result"><strong>Result:</strong> {pr.resultNote}</p>}
        <div className="enc-tray-cards">
          {pr.drawn.map((id, i) => {
            const info = cardInfo(cat, pr.deck, id);
            const isChosen = id === pr.chosen;
            const cls = `enc-tray-card${isChosen ? ' applies chosen' : ' dim'}`;
            return (
              <div key={`${id}:${i}`} className={cls}>
                {info.art && <img className="enc-tray-art" src={info.art} alt="" />}
                <div className="enc-tray-body">
                  <div className="enc-tray-name">{info.name}</div>
                  <div className="enc-tray-text">{info.text || <em>No mechanical effect.</em>}</div>
                  {isChosen && <span className="enc-tray-badge">resolves</span>}
                </div>
              </div>
            );
          })}
        </div>
        <button className="primary enc-tray-ok" onClick={onDismiss}>OK</button>
      </div>
    </div>
  );
}
