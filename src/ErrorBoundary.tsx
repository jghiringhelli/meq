import { Component, type ErrorInfo, type ReactNode } from 'react';
import ReportBugModal from './play/ReportBugModal';
import { loadSavedGame, recordCrash } from './play/persistence';

interface Props { children: ReactNode }
interface State { error: Error | null; componentStack?: string; reportOpen: boolean }

/**
 * Last line of defense for a public release: without this, any uncaught
 * render-time exception would leave players staring at a blank white page
 * with no idea what happened and no way to tell us. Instead we show a small
 * "something broke" screen and reuse the same Report-a-problem flow (download
 * a JSON snapshot + open a prefilled GitHub issue) — using whatever game was
 * last auto-saved, since the crashed React tree's own state is gone.
 *
 * This only catches errors thrown while React is rendering/committing. Errors
 * from event handlers, timers, or promise rejections are caught separately by
 * the window-level handlers installed in `installGlobalCrashHandlers()` below
 * and stashed via `recordCrash` so the NEXT manual "Report a problem" click
 * can still attach them, even though they don't crash the whole page.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reportOpen: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? undefined });
    recordCrash({ message: error.message, stack: error.stack, componentStack: info.componentStack ?? undefined });
  }

  render() {
    const { error, componentStack, reportOpen } = this.state;
    if (!error) return this.props.children;

    const saved = loadSavedGame();
    return (
      <div className="crash-screen">
        <h1>Something broke</h1>
        <p>
          Middle-earth Quest hit an unexpected error and can't continue safely from here.
          Your last auto-saved game is still on disk — reloading the page should get you back
          into it. Reporting this (with the details below) helps us fix it for everyone.
        </p>
        <p><code>{error.message}</code></p>
        <div className="crash-actions">
          <button className="primary" onClick={() => this.setState({ reportOpen: true })}>Report this problem</button>
          <button className="ghost" onClick={() => window.location.reload()}>Reload the page</button>
        </div>
        {reportOpen && (
          <ReportBugModal
            seed={saved?.seed ?? 0}
            state={saved?.state ?? null}
            crash={{ message: error.message, stack: error.stack, componentStack }}
            onClose={() => this.setState({ reportOpen: false })}
          />
        )}
      </div>
    );
  }
}

/**
 * Catches crashes ErrorBoundary structurally cannot: exceptions thrown from
 * event handlers / timers (`window.onerror`) and rejected promises nobody
 * awaited (`unhandledrejection`). These don't take down the whole React tree,
 * so we just remember the most recent one — the existing "Report a problem"
 * button picks it up automatically via `loadLastCrash()` next time it's used.
 */
export function installGlobalCrashHandlers(): void {
  window.addEventListener('error', (e) => {
    recordCrash({ message: e.message, stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    recordCrash({
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
