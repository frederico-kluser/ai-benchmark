import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink, useNavigate, Navigate } from 'react-router-dom';
import { NewRun } from './pages/NewRun';
import { RunView } from './pages/RunView';
import { RunsList } from './pages/RunsList';
import { TrainingView } from './pages/TrainingView';
import { KeyGate } from './components/KeySetup';
import { SettingsPage } from './pages/Settings';
import { HelpModal } from './components/HelpModal';
import { ThemeContext, type Theme, getStoredTheme, persistTheme, applyTheme } from './theme';
import { HelpContext, markFirstOpen, type HelpTutorial } from './help';
import { ProcessingContext, useProcessingState } from './processing';
import { BrainBackground } from './components/BrainBackground';
import './styles.css';

function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const theme: Theme = 'dark';
  const [help, setHelp] = useState<HelpTutorial | null>(null);
  const processing = useProcessingState();

  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);

  useEffect(() => {
    markFirstOpen();
  }, []);

  const helpApi = useMemo(() => ({ open: (t: HelpTutorial) => setHelp(t) }), []);

  return (
    <ThemeContext.Provider value={theme}>
      <HelpContext.Provider value={helpApi}>
        <ProcessingContext.Provider value={processing}>
          <div className="app">
            <BrainBackground isThinking={processing.isProcessing} />
            <nav className="nav">
              <div className="nav-inner">
                <div className="brand" onClick={() => navigate('/new')}>
                  <span className="brand-badge">P</span>
                  Prompt Builder
                </div>
                <div className="nav-actions">
                  <NavLink to="/new" className="nav-link">Nova Run</NavLink>
                  <NavLink to="/runs" className="nav-link">Histórico</NavLink>
                  <NavLink to="/settings" className="nav-link">Configurações</NavLink>
                  <span className="nav-divider" />
                  <button
                    className="icon-btn"
                    onClick={() => setHelp('compare')}
                    title="Como funciona"
                    aria-label="Como funciona"
                  >
                    ?
                  </button>
                </div>
              </div>
            </nav>
            <main className="main">{children}</main>
            {help && <HelpModal tutorial={help} onClose={() => setHelp(null)} />}
          </div>
        </ProcessingContext.Provider>
      </HelpContext.Provider>
    </ThemeContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/new" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/new" element={<KeyGate><NewRun /></KeyGate>} />
          <Route path="/runs" element={<RunsList />} />
          <Route path="/runs/:id" element={<RunView />} />
          <Route path="/training/:sessionId" element={<TrainingView />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </React.StrictMode>,
);
