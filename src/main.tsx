import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary, { installGlobalCrashHandlers } from './ErrorBoundary';
import { InspectProvider } from './play/CardInspector';
import './styles.css';

installGlobalCrashHandlers();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <InspectProvider>
        <App />
      </InspectProvider>
    </ErrorBoundary>
  </StrictMode>,
);
