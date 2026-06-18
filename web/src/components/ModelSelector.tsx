import { useEffect, useMemo, useRef, useState } from 'react';
import type { OpenRouterModel } from '../api';
import { fetchModels } from '../api';

interface Props {
  multi?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  title: string;
  hint: string;
  excludeIds?: string[];
  /** Optional shared catalog (avoids each selector refetching). Self-fetches when omitted. */
  models?: OpenRouterModel[];
  loading?: boolean;
}

function formatPricePerMTok(usdPerToken: number): string {
  const perM = usdPerToken * 1_000_000;
  if (perM === 0) return '$0';
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  return `$${perM.toFixed(2)}`;
}

function priceLabel(model: OpenRouterModel): string {
  return `in ${formatPricePerMTok(model.pricing.prompt)} / out ${formatPricePerMTok(model.pricing.completion)} /1M`;
}

// -------- fuzzy search --------
// Score baseado em: subsequence match, prefixos, palavras-chave, e bonus de proximidade.
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  if (h === n) return 1000;
  if (h.startsWith(n)) return 700 + Math.max(0, 50 - (h.length - n.length));
  if (h.includes(n)) return 500;

  // Subsequence: cada caractere de n precisa aparecer em h em ordem.
  let hi = 0;
  let score = 0;
  let consecutive = 0;
  let prevChar = '';
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === c) {
        found = hi;
        break;
      }
      hi++;
    }
    if (found === -1) return 0;

    const before = found > 0 ? h[found - 1] : '';
    const isBoundary = found === 0 || /[\/\-_.: ]/.test(before);
    if (isBoundary) score += 8;

    if (prevChar && h[found - 1] === prevChar && found > 0) {
      consecutive += 1;
      score += 4 + consecutive * 2;
    } else {
      consecutive = 0;
    }

    score += 2;
    prevChar = c;
    hi = found + 1;
  }

  score -= Math.floor(h.length / 20);
  return score;
}

function multiTokenScore(haystack: string, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const t of tokens) {
    const s = fuzzyScore(haystack, t);
    if (s <= 0) return 0; // todos os tokens precisam matchear
    total += s;
  }
  return total;
}

export function ModelSelector({
  multi = true,
  value,
  onChange,
  title,
  hint,
  excludeIds = [],
  models: sharedModels,
  loading: sharedLoading,
}: Props) {
  const selfManaged = sharedModels === undefined;
  const [selfModels, setSelfModels] = useState<OpenRouterModel[]>([]);
  const [selfLoading, setSelfLoading] = useState(selfManaged);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const models = sharedModels ?? selfModels;
  const loading = selfManaged ? selfLoading : !!sharedLoading;

  useEffect(() => {
    if (!selfManaged) return;
    let active = true;
    fetchModels()
      .then((data) => active && setSelfModels(data))
      .catch((err) => active && setError(err.message))
      .finally(() => active && setSelfLoading(false));
    return () => {
      active = false;
    };
  }, [selfManaged]);

  // Fechar ao clicar/tocar fora ou pressionar Escape
  useEffect(() => {
    if (!open) return;
    function handlePointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (wrapperRef.current && target && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Mantém TODOS os ids selecionados, mesmo os que ainda nao estao no catalogo
  // carregado (ex.: defaults pre-preenchidos) — senao o chip some da tela.
  const selected = useMemo(
    () => value.map((id) => ({ id, model: models.find((m) => m.id === id) })),
    [value, models],
  );

  const filtered = useMemo(() => {
    const excluded = new Set([...excludeIds, ...value]);
    const available = models.filter((m) => !excluded.has(m.id));

    const q = query.trim();
    if (!q) return available.slice(0, 50);

    return available
      .map((m) => {
        const idScore = multiTokenScore(m.id, q);
        const nameScore = multiTokenScore(m.name, q);
        const score = idScore * 1.5 + nameScore;
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.m);
  }, [query, models, excludeIds, value]);

  function select(id: string) {
    if (multi) {
      if (!value.includes(id)) onChange([...value, id]);
    } else {
      onChange([id]);
      setOpen(false);
      inputRef.current?.blur();
    }
    setQuery('');
  }

  function remove(id: string) {
    onChange(value.filter((v) => v !== id));
  }

  const placeholder = loading
    ? 'Carregando modelos…'
    : !multi && value.length > 0
      ? 'Trocar modelo (apenas 1 permitido)…'
      : !multi
        ? 'Escolher 1 modelo…'
        : 'Buscar modelo (ex.: "claude sonnet", "gpt 5 mini")';

  return (
    <section className="card selector-card" ref={wrapperRef}>
      <div className="selector-title">{title}</div>
      <div className="selector-hint">{hint}</div>

      <div className="selector-chips">
        {selected.map(({ id, model }) => (
          <div key={id} className="model-chip">
            <span className="model-chip-text">
              <span className="model-chip-id">{id}</span>
              <span className="model-chip-price">
                {model ? priceLabel(model) : loading ? 'carregando…' : 'fora do catálogo'}
              </span>
            </span>
            <button type="button" className="model-chip-x" aria-label={`Remover ${id}`} onClick={() => remove(id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="selector-search">
        <input
          ref={inputRef}
          type="text"
          className="input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          disabled={loading}
        />
        {open && (
          <ul className="selector-pop">
            {filtered.length === 0 && <li className="selector-empty">Nenhum modelo encontrado</li>}
            {filtered.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="selector-opt"
                  onMouseDown={(e) => {
                    // mousedown para nao perder foco antes do click
                    e.preventDefault();
                    select(m.id);
                  }}
                >
                  <span className="selector-opt-text">
                    <span className="selector-opt-id">{m.id}</span>
                    <span className="selector-opt-name">{m.name}</span>
                  </span>
                  <span className="selector-opt-price">{priceLabel(m)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <div className="selector-hint" style={{ color: 'var(--err)', marginTop: 10, marginBottom: 0 }}>{error}</div>}
    </section>
  );
}
