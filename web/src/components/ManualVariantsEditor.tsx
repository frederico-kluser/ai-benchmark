import type { ManualVariant } from '../api';

interface Props {
  value: ManualVariant[];
  onChange: (v: ManualVariant[]) => void;
}

export function ManualVariantsEditor({ value, onChange }: Props) {
  function update(i: number, patch: Partial<ManualVariant>) {
    onChange(value.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }
  function add() {
    onChange([...value, { label: `Variante ${value.length + 1}`, systemPrompt: '' }]);
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  return (
    <div className="card field-card">
      <div className="field-label" style={{ marginBottom: 4 }}>Variantes manuais</div>
      <div className="selector-hint">Forneça 2 ou mais system prompts — rodam como estão, sem reescrita por LLM.</div>
      {value.map((v, i) => (
        <div key={i} className="manual-variant">
          <div className="manual-variant-head">
            <input
              className="input"
              type="text"
              value={v.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder={`Variante ${i + 1}`}
            />
            <button type="button" className="btn-secondary" onClick={() => remove(i)}>
              Remover
            </button>
          </div>
          <textarea
            className="textarea"
            rows={4}
            value={v.systemPrompt}
            onChange={(e) => update(i, { systemPrompt: e.target.value })}
            placeholder="System prompt desta variante…"
          />
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={add}>
        + Adicionar variante
      </button>
    </div>
  );
}
