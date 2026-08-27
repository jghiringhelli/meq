import { useState } from 'react';

type Props = {
  label: string;
  ready: boolean;
  tasks: string[];
  onProceed: () => void;
};

/** Prominent, context-aware "do the obvious next step" button. It glows when the
 *  active player has nothing worthwhile left to do; when advancing would skip
 *  still-available actions it raises a Yes/No warning listing them, letting the
 *  player end anyway or go back. It only ever triggers the existing advance /
 *  end-turn action — it never changes the rules. */
export default function SmartNext({ label, ready, tasks, onProceed }: Props) {
  const [confirm, setConfirm] = useState(false);

  const click = () => {
    if (tasks.length > 0) setConfirm(true);
    else onProceed();
  };
  const proceed = () => { setConfirm(false); onProceed(); };

  return (
    <>
      <button
        className={`smart-next${ready ? ' ready' : ' has-tasks'}`}
        onClick={click}
        title={ready ? 'Nothing left to do — continue' : `${tasks.length} thing(s) you could still do`}
      >
        {label}
        {!ready && <span className="smart-next__badge">{tasks.length}</span>}
      </button>

      {confirm && (
        <div className="smart-confirm-overlay" onClick={() => setConfirm(false)}>
          <div className="smart-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Advance anyway?</h3>
            <p>You could still:</p>
            <ul>
              {tasks.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
            <div className="smart-confirm__actions">
              <button className="ghost" onClick={() => setConfirm(false)}>No — go back</button>
              <button className="primary" onClick={proceed}>Yes — end anyway</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
