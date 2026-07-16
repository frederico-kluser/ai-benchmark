import { useEffect, useState } from 'react';
import type { Technique } from '../api';
import { fetchTechniques } from '../api';

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
}

export function TechniqueSelector({ value, onChange }: Props) {
  const [techs, setTechs] = useState<Technique[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchTechniques()
      .then((t) => active && setTechs(t))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="card field-card">
      <div className="field-label" style={{ marginBottom: 4 }}>Técnicas de prompt</div>
      <div className="selector-hint">Selecione 2 ou mais — cada técnica vira uma variação do system prompt.</div>
      {loading && <div className="inline-status"><span className="spinner" />Carregando técnicas…</div>}
      {error && <div className="banner banner-error" style={{ margin: 0 }}>{error}</div>}
      <div className="technique-list">
        {techs.map((t) => {
          const sel = value.includes(t.id);
          return (
            <div
              key={t.id}
              className={`technique-item ${sel ? 'selected' : ''}`}
              onClick={() => toggle(t.id)}
            >
              <div className="technique-head">
                <input type="checkbox" checked={sel} readOnly />
                <span className="technique-name">{t.name}</span>
                {t.confidence && (
                  <span
                    className={`confidence-badge conf-${t.confidence}`}
                    title="Confiança da evidência (revisão sistemática de técnicas de prompt)"
                  >
                    {t.confidence}
                  </span>
                )}
              </div>
              <div className="technique-good">Bom: {t.good}</div>
              <div className="technique-bad">Cuidado: {t.bad}</div>
            </div>
          );
        })}
      </div>
      <div className="technique-count">
        {value.length} técnica(s) selecionada(s) → {value.length} variante(s) geradas.
      </div>
    </div>
  );
}
