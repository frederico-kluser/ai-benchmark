import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { NewRun } from './pages/NewRun';
import { RunView } from './pages/RunView';
import { RunsList } from './pages/RunsList';
import { KeyGate } from './components/KeySetup';
import { SettingsPage } from './pages/Settings';
import './styles.css';

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="layout">
      <header className="topbar">
        <Link to="/" className="brand">Benchmark Arena</Link>
        <nav>
          <Link to="/new">Nova Run</Link>
          <Link to="/runs">Histórico</Link>
          <Link to="/settings">Configurações</Link>
        </nav>
      </header>
      <main>{children}</main>
    </div>
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
        </Routes>
      </Layout>
    </BrowserRouter>
  </React.StrictMode>,
);
