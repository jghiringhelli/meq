import type { Choice } from '../engine/types';

interface Props {
  choice: Choice;
  onChoose: (optionId: string) => void;
}

/** A lightweight modal for a non-combat pending choice (e.g. a quest reward's
 *  "A or B" pick). Combat choices are rendered inside the CombatBoard overlay. */
export default function ChoiceModal({ choice, onChoose }: Props) {
  return (
    <div className="choice-overlay">
      <div className="choice-modal">
        <p className="prompt">{choice.prompt}</p>
        <div className="choice-options">
          {choice.options.map((o) => (
            <button key={o.id} className="choice-btn" onClick={() => onChoose(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
