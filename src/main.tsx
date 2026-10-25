import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary, { installGlobalCrashHandlers } from './ErrorBoundary';
import { InspectProvider } from './play/CardInspector';
import { restoreArt } from './data/artStore';
import './styles.css';

installGlobalCrashHandlers();

// Re-install the player's cached art before the first render so the map never flashes blank.
void restoreArt().finally(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <InspectProvider>
        <App />
      </InspectProvider>
    </ErrorBoundary>
  </StrictMode>,
));
