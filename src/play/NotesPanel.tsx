import { useEffect, useRef, useState } from 'react';
import { loadNotes, saveNotes } from './persistence';

/**
 * A private scratchpad, one per game (seed) per browser — never networked,
 * never part of GameState, so it's purely local and can't leak to (or be
 * seen by) other players. Useful for jotting down things worth remembering
 * (a plan, a suspicion about Sauron's hand, a rules question to check later)
 * without cluttering the shared, public game log.
 */
export default function NotesPanel({ seed }: { seed: number }) {
  const [text, setText] = useState(() => loadNotes(seed));
  const [open, setOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reload notes if we switch games (new seed) while mounted.
  useEffect(() => { setText(loadNotes(seed)); }, [seed]);

  const onChange = (v: string) => {
    setText(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNotes(seed, v), 300);
  };

  return (
    <div className="notes-panel">
      <div className="notes-title" onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}>
        📝 My notes {open ? '▾' : '▸'}
        {!open && text.trim() && <span className="notes-badge" title="you have saved notes">•</span>}
      </div>
      {open && (
        <>
          <textarea
            className="notes-body"
            placeholder="Private — only visible to you, never sent to other players. Jot down plans, suspicions, questions to check later…"
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="notes-sub">saved locally · only visible in this browser</div>
        </>
      )}
    </div>
  );
}
