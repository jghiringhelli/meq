import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { InspectProvider } from './play/CardInspector';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InspectProvider>
      <App />
    </InspectProvider>
  </StrictMode>,
);
