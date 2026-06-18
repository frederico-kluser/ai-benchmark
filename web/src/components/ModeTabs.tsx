import type { RunMode } from '../api';

const MODES: { id: RunMode; label: string }[] = [
  { id: 'compare', label: 'Comparar' },
  { id: 'variation', label: 'Variação' },
  { id: 'training', label: 'Treino' },
];

export function ModeTabs({ value, onChange }: { value: RunMode; onChange: (m: RunMode) => void }) {
  return (
    <div className="tabs" style={{ marginBottom: 10 }}>
      {MODES.map((m) => (
        <button
          type="button"
          key={m.id}
          className={`tab ${value === m.id ? 'active' : ''}`}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
