import { AppProvider, useApp } from './state/AppContext';
import { Dashboard } from './components/Dashboard';
import { Header } from './components/Header';
import { ImportView } from './components/ImportView';
import { Toasts } from './components/ui';
import { Workspace } from './components/Workspace';

function Shell() {
  const { view, session } = useApp();
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header />
      <div id="main" className="app__body">
        {view === 'dashboard' ? <Dashboard /> : view === 'import' ? <ImportView /> : session ? <Workspace /> : <Dashboard />}
      </div>
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
