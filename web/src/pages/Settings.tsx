import { KeySetup } from '../components/KeySetup';

export function SettingsPage() {
  return (
    <div className="screen">
      <h1 className="page-title">Configurações</h1>
      <p className="page-sub">Gerencie a chave usada para falar com a OpenRouter.</p>
      <KeySetup />
    </div>
  );
}
