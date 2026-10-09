import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { initFirebase } from './lib/firebase';
import { startAuthListener } from './lib/data';
import { applyTheme } from './lib/prefs';
import App from './App';
import './styles.css';

applyTheme();

const root = createRoot(document.getElementById('root')!);

initFirebase()
  .then(() => {
    startAuthListener();
    root.render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    );
  })
  .catch((e: unknown) => {
    console.error(e);
    root.render(<p style={{ padding: 24 }}>Could not start: {String((e as Error)?.message ?? e)}</p>);
  });
