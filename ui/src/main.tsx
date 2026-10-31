import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useRoute } from './lib/router.ts';
import { NewRun } from './pages/NewRun.tsx';
import { RunDetailPage } from './pages/RunDetail.tsx';
import { RunsList } from './pages/RunsList.tsx';
import './styles/tokens.css';
import './styles/app.css';
import './styles/data.css';

function App() {
  const route = useRoute();
  return (
    <>
      <button
        type="button"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('workspace')?.focus();
        }}
      >
        Skip to workspace
      </button>
      <main id="workspace" tabIndex={-1}>
        <header className="topbar">
          <a href="#/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              B
            </span>{' '}
            Browser Agent <span className="workspace-label">Testing workspace</span>
          </a>
          <nav aria-label="Main navigation">
            <a href="#/" aria-current={route.name === 'list' ? 'page' : undefined}>
              Runs
            </a>
            <a href="#/new" aria-current={route.name === 'new' ? 'page' : undefined}>
              New run
            </a>
          </nav>
        </header>
        {route.name === 'list' && <RunsList />}
        {route.name === 'new' && <NewRun />}
        {route.name === 'run' && <RunDetailPage key={route.id} id={route.id} />}
      </main>
    </>
  );
}

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
