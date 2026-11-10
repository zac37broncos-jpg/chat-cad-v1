import { createRoot } from 'react-dom/client';
import { prepareAutosave } from './ui/autosave';
import './ui/styles.css';

// The autosave lives in IndexedDB (no size limit), which can only be read asynchronously,
// so it is read before the app module (which creates the document store) is loaded.
void prepareAutosave()
  .then(() => import('./ui/App'))
  .then(({ App }) => createRoot(document.getElementById('root')!).render(<App />));
