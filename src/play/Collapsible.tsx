import type { ReactNode } from 'react';

/**
 * A section that defaults to a minimal icon+label "chip" (with a live one-line
 * summary as its hover tooltip) and expands to its full content on click. Used
 * to let reference/log panels stay out of the way most of the time — the
 * player only opens the ones they need to check right now — while the map
 * gets the rest of the screen. Each section's open/closed state is owned by
 * the parent (via `open`/`onToggle`) so a single "collapse/expand all" action
 * can coexist with per-section overrides.
 */
export default function Collapsible({
  id, icon, label, summary, open, onToggle, children, dir = 'row',
}: {
  id: string;
  icon: string;
  label: string;
  /** Short live status shown in the chip's hover tooltip while collapsed. */
  summary?: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
  /** 'row' for the horizontal top bars, 'col' for the vertical side rail. */
  dir?: 'row' | 'col';
}) {
  if (!open) {
    return (
      <button
        className={`rail-chip rail-chip--${dir}`}
        title={`${label}${summary ? ` — ${summary}` : ''}\n(click to expand)`}
        onClick={() => onToggle(id)}
      >
        <span className="rail-chip-icon">{icon}</span>
        <span className="rail-chip-label">{label}</span>
        {summary && <span className="rail-chip-summary">{summary}</span>}
      </button>
    );
  }
  return (
    <div className={`rail-open rail-open--${dir}`}>
      <div className="rail-open-head">
        <span className="rail-open-title">{icon} {label}</span>
        <button className="rail-open-collapse" title="Collapse" onClick={() => onToggle(id)}>−</button>
      </div>
      {children}
    </div>
  );
}
