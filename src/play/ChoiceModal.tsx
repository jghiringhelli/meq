import type { Catalog, Choice } from '../engine/types';
import { combatCardArt } from '../data/art';

interface Props {
  cat: Catalog;
  choice: Choice;
  onChoose: (optionId: string) => void;
}

/** A lightweight modal for a non-combat pending choice (e.g. a quest reward's
 *  "A or B" pick, or a Training pick). Options tied to a specific card
 *  (`cardId` set, e.g. training) render its full art/stats/ability so the
 *  player can actually see what they're choosing, not just its name. Combat
 *  choices are rendered inside the CombatBoard overlay instead. */
export default function ChoiceModal({ cat, choice, onChoose }: Props) {
  return (
    <div className="choice-overlay">
      <div className="choice-modal">
        <p className="prompt">{choice.prompt}</p>
        <div className="choice-options">
          {choice.options.map((o, i) => {
            const card = o.cardId ? cat.combatCards[o.cardId] : undefined;
            if (!card) {
              return (
                <button key={`${o.id}-${i}`} className="choice-btn" onClick={() => onChoose(o.id)}>
                  {o.label}
                </button>
              );
            }
            const img = combatCardArt(card);
            return (
              <button key={`${o.id}-${i}`} className="choice-btn choice-btn-card" onClick={() => onChoose(o.id)}
                title={card.ability || undefined}>
                {img && <img className="choice-card-art" src={img} alt="" />}
                <span className="choice-card-name">{card.name}</span>
                <span className="choice-card-nums">
                  ⚔{card.attack} · 🛡{card.defense} · {card.type}{card.strengthCost ? ` · ✊${card.strengthCost}` : ''}
                </span>
                {card.ability && <span className="choice-card-ab">{card.ability}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
