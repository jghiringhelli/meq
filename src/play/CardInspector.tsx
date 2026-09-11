// M12 — click any card / token to inspect it: large VASSAL art + rules text.
// A tiny React context so any component can call `inspect(payload)` without
// threading callbacks through every panel.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export interface InspectPayload {
  title: string;
  img?: string;
  /** short key/value or tag lines shown under the title */
  lines?: string[];
  /** longer rules / ability prose */
  text?: string;
  subtitle?: string;
  /** Optional action buttons (e.g. "Consult: favor" / "→ ability"). Clicking
   *  one runs its handler then closes the inspector. */
  actions?: { label: string; onClick: () => void; disabled?: boolean }[];
}

type InspectFn = (payload: InspectPayload) => void;

const InspectContext = createContext<InspectFn>(() => {});

/** Call to open the card viewer for a given payload. */
export function useInspect(): InspectFn {
  return useContext(InspectContext);
}

export function InspectProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<InspectPayload | null>(null);
  const inspect = useCallback<InspectFn>((p) => setPayload(p), []);
  const close = useCallback(() => setPayload(null), []);
  return (
    <InspectContext.Provider value={inspect}>
      {children}
      {payload && (
        <div className="inspect-overlay" onClick={close} role="dialog" aria-modal="true">
          <div className="inspect-card" onClick={(e) => e.stopPropagation()}>
            <button className="inspect-close" onClick={close} aria-label="Close">✕</button>
            {payload.img && <img className="inspect-art" src={payload.img} alt={payload.title} />}
            <div className="inspect-body">
              <h3>{payload.title}</h3>
              {payload.subtitle && <div className="inspect-subtitle">{payload.subtitle}</div>}
              {payload.lines && payload.lines.length > 0 && (
                <ul className="inspect-lines">
                  {payload.lines.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
              {payload.text && <p className="inspect-text">{payload.text}</p>}
              {payload.actions && payload.actions.length > 0 && (
                <div className="inspect-actions">
                  {payload.actions.map((a, i) => (
                    <button key={i} disabled={a.disabled} onClick={() => { a.onClick(); close(); }}>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </InspectContext.Provider>
  );
}
