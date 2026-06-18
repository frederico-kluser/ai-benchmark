import React, { useEffect, useState } from 'react';
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
import './styles.css';

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);

  const isDark = theme === 'dark';

  return (
    <ThemeContext.Provider value={theme}>
      <div className="app">
        <nav className="nav">
          <div className="nav-inner">
            <div className="brand" onClick={() => navigate('/new')}>
              <span className="brand-badge">B</span>
              Benchmark Arena
            </div>
            <div className="nav-actions">
              <NavLink to="/new" className="nav-link">Nova Run</NavLink>
              <NavLink to="/runs" className="nav-link">Histórico</NavLink>
              <NavLink to="/settings" className="nav-link">Configurações</NavLink>
              <span className="nav-divider" />
              <button
                className="icon-btn"
                onClick={() => setHelpOpen(true)}
                title="Como funciona"
                aria-label="Como funciona"
              >
                ?
              </button>
              <button
                className="icon-btn"
                onClick={() => setTheme(isDark ? 'light' : 'dark')}
                title={isDark ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}
                aria-label={isDark ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}
              >
                {isDark ? <SunIcon /> : <MoonIcon />}
              </button>
            </div>
          </div>
        </nav>
        <main className="main">{children}</main>
        {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      </div>
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
