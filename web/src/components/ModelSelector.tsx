import { useEffect, useMemo, useRef, useState } from 'react';
import type { OpenRouterModel } from '../api';
import { fetchModels } from '../api';

interface Props {
  multi?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  title: string;
  hint?: string;
  excludeIds?: string[];
  /** Optional shared catalog (avoids each selector refetching). Self-fetches when omitted. */
  models?: OpenRouterModel[];
  loading?: boolean;
  /** Compacto: sem card próprio, para embutir numa linha de outro bloco. Default true. */
  inline?: boolean;
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

/** Nome curto do modelo: o que vem depois da última '/' do id. */
function shortName(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
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
  inline = true,
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

  // Ao abrir, o foco vai direto para a busca.
  useEffect(() => {
    if (open) inputRef.current?.focus();
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

  const addLabel = loading ? 'carregando…' : !multi && value.length > 0 ? 'trocar' : '+ adicionar';

  return (
    <div className={inline ? 'picker' : 'picker card'} ref={wrapperRef}>
      <span className="picker-label" title={hint}>
        {title}
      </span>

      <div className="picker-chips">
        {selected.map(({ id, model }) => (
          <span
            key={id}
            className="picker-chip"
            title={model ? `${id} — ${priceLabel(model)}` : loading ? `${id} — carregando…` : `${id} — fora do catálogo`}
          >
            {shortName(id)}
            <button type="button" className="picker-chip-x" aria-label={`Remover ${id}`} onClick={() => remove(id)}>
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="picker-wrap">
        <button
          type="button"
          className="picker-add"
          disabled={loading}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((v) => !v)}
        >
          {addLabel}
        </button>

        {open && (
          <div className="picker-pop">
            <input
              ref={inputRef}
              type="text"
              className="picker-search"
              placeholder="Buscar modelo…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length > 0) {
                  e.preventDefault();
                  select(filtered[0].id);
                }
              }}
            />
            <ul className="picker-list" role="listbox">
              {error && <li className="picker-empty">{error}</li>}
              {!error && filtered.length === 0 && <li className="picker-empty">Nenhum modelo encontrado</li>}
              {filtered.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="picker-opt"
                    // mousedown so para nao perder o foco da busca antes do click
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(m.id)}
                  >
                    <span className="picker-opt-id">{m.id}</span>
                    <span className="picker-opt-name">{m.name}</span>
                    <span className="picker-opt-price">{priceLabel(m)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
