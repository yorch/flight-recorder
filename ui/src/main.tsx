import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KeyHelp } from './components/KeyHelp.tsx';
import { Rail, rosterOf } from './components/Rail.tsx';
import { isEditable, neighbour, resolveKey } from './lib/keys.ts';
import { currentParams, nav, type Route, replaceQuery, useRoute } from './lib/router.ts';
import { runsSnapshot } from './lib/runsStore.ts';
import { RUN_TABS, withTab } from './lib/tabs.ts';
import { NewRun } from './pages/NewRun.tsx';
import { RunDetailPage } from './pages/RunDetail.tsx';
import { RunsList } from './pages/RunsList.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/pages.css';

/** First visible search field in the canvas (tables in hidden tab panels are skipped). */
function focusSearch() {
  const fields = document.querySelectorAll<HTMLInputElement>('#canvas input[type="search"], #canvas #f-title');
  const el = [...fields].find((f) => f.offsetParent !== null || f.getClientRects().length > 0) ?? fields[0];
  el?.focus();
}

function useShortcuts(route: Route, onHelp: () => void) {
  const pending = useRef<string | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const { action, pending: next } = resolveKey(
        { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, editable: isEditable(e.target) },
        pending.current,
      );
      pending.current = next;
      if (!action) return;
      const r = routeRef.current;
      if (action.kind === 'go') nav(action.to);
      else if (action.kind === 'search') focusSearch();
      else if (action.kind === 'help') onHelp();
      else if (action.kind === 'tab') {
        const tab = RUN_TABS[action.index];
        if (r.name !== 'run' || !tab) return;
        replaceQuery(withTab(currentParams(), tab));
      } else if (action.kind === 'step') {
        const { live, recent } = rosterOf(runsSnapshot().runs);
        const id = neighbour(
          [...live, ...recent].map((x) => x.run_id),
          r.name === 'run' ? r.id : null,
          action.delta,
        );
        if (id) nav(`/run/${id}`);
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onHelp]);
}

function App() {
  const route = useRoute();
  const [help, setHelp] = useState(false);
  const openHelp = useRef(() => setHelp(true)).current;
  useShortcuts(route, openHelp);
  return (
    <div className="console">
      <button
        type="button"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('canvas')?.focus();
        }}
      >
        Skip to workspace
      </button>
      <Rail route={route} onHelp={openHelp} />
      <main id="canvas" className="canvas" tabIndex={-1}>
        {route.name === 'list' && <RunsList />}
        {route.name === 'new' && <NewRun />}
        {route.name === 'run' && <RunDetailPage key={route.id} id={route.id} />}
      </main>
      <KeyHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
