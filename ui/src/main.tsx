import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useRoute } from './lib/router.ts';
import { NewRun } from './pages/NewRun.tsx';
import { RunDetailPage } from './pages/RunDetail.tsx';
import { RunsList } from './pages/RunsList.tsx';
import './app.css';

function App() {
  const route = useRoute();
  return (
    <main>
      <header className="topbar">
        <a href="#/" className="brand">
          browser-agent
        </a>
        <nav>
          <a href="#/">runs</a>
          <a href="#/new">new run</a>
        </nav>
      </header>
      {route.name === 'list' && <RunsList />}
      {route.name === 'new' && <NewRun />}
      {route.name === 'run' && <RunDetailPage key={route.id} id={route.id} />}
    </main>
  );
}

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
