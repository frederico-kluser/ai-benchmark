import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SavedPrompt } from '../api';
import { deletePrompt, listPrompts, updatePrompt } from '../api';
import { diffLines } from '../diff';

// Biblioteca de prompts salvos (store 'prompts' do IndexedDB): lista, busca,
// renomeia, exclui e compara as versões dos prompts promovidos nos treinos e
// variações. "Usar como base" semeia o rascunho da Nova Run no localStorage
// (chave 'arena:prompt-draft' — o NewRun lê e remove a chave ao abrir).

const DRAFT_KEY = 'arena:prompt-draft';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Origin = SavedPrompt['origin'];

function originLabel(origin: Origin): string {
  if (origin?.kind === 'training') return 'treino';
  if (origin?.kind === 'variation') return 'variação';
  return 'manual';
}

function originBadgeClass(origin: Origin): string {
  if (origin?.kind === 'training') return 'b-warn';
  if (origin?.kind === 'variation') return 'b-blue';
  return 'b-neutral';
}

/** Técnica/iteração de proveniência, quando registradas no save. */
function originDetail(origin: Origin): string {
  if (!origin) return '';
  const parts: string[] = [];
  if (origin.techniqueId) parts.push(origin.techniqueId);
  if (origin.iteration !== undefined) parts.push(`iteração ${origin.iteration}`);
  return parts.join(' · ');
}

/** Link para a sessão de treino ou run que originou o prompt, quando houver. */
function originLink(origin: Origin): { to: string; label: string } | null {
  if (!origin) return null;
  if (origin.sessionId) return { to: `/training/${origin.sessionId}`, label: 'ver treino' };
  if (origin.runId) return { to: `/runs/${origin.runId}`, label: 'ver run' };
  return null;
}

interface PromptItemProps {
  prompt: SavedPrompt;
  onUpdated: (p: SavedPrompt) => void;
  onDeleted: (id: string) => void;
}

function PromptItem({ prompt: p, onUpdated, onDeleted }: PromptItemProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(p.name);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [selVersion, setSelVersion] = useState(p.version);

  // Versões ordenadas; por construção do promptStore a corrente é a última.
  const versions = useMemo(() => [...p.history].sort((a, b) => a.version - b.version), [p.history]);
  const selIdx = versions.findIndex((v) => v.version === selVersion);
  const sel = selIdx >= 0 ? versions[selIdx] : versions[versions.length - 1];
  const prev = selIdx > 0 ? versions[selIdx - 1] : undefined;
  const diff = useMemo(
    () => (sel && prev ? diffLines(prev.text, sel.text) : []),
    [sel, prev],
  );

  const link = originLink(p.origin);
  const detail = originDetail(p.origin);

  async function saveRename() {
    const name = draftName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const updated = await updatePrompt(p.id, { name });
      if (updated) onUpdated(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function cancelRename() {
    setDraftName(p.name);
    setEditing(false);
  }

  async function confirmDelete() {
    await deletePrompt(p.id);
    onDeleted(p.id);
  }

  function useAsBase() {
    // Contrato com o NewRun: ele lê e remove a chave ao montar o assistente.
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: p.text, name: p.name }));
    navigate('/new');
  }

  return (
    <div className="stage-card">
      {/* Head é div (não button) porque carrega link e botões de ação dentro —
          os cliques interativos fazem stopPropagation para não expandir. */}
      <div className="stage-head" onClick={() => setOpen((v) => !v)}>
        <span className="stage-head-left">
          <span className={`stage-caret ${open ? 'open' : ''}`}>▶</span>
          {editing ? (
            <span
              style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                className="input"
                style={{ maxWidth: 320, padding: '7px 11px', fontSize: 13 }}
                value={draftName}
                autoFocus
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRename();
                  if (e.key === 'Escape') cancelRename();
                }}
              />
              <button
                type="button"
                className="export-btn"
                disabled={saving || !draftName.trim()}
                onClick={() => void saveRename()}
              >
                Salvar
              </button>
              <button type="button" className="export-btn" onClick={cancelRename}>
                Cancelar
              </button>
            </span>
          ) : (
            <span style={{ minWidth: 0 }}>
              <span className="stage-snippet" style={{ display: 'block' }}>{p.name}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {`v${p.version} · `}
                {link ? (
                  <Link to={link.to} onClick={(e) => e.stopPropagation()}>
                    {originLabel(p.origin)}
                  </Link>
                ) : (
                  originLabel(p.origin)
                )}
                {` · atualizado em ${formatDate(p.updatedAt)}`}
              </span>
            </span>
          )}
        </span>
        <span className="stage-head-right" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="export-btn" onClick={useAsBase}>
            Usar como base
          </button>
          {!editing && (
            <button
              type="button"
              className="export-btn"
              onClick={() => {
                setDraftName(p.name);
                setEditing(true);
              }}
            >
              Renomear
            </button>
          )}
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="export-btn"
                style={{ color: 'var(--err)' }}
                onClick={() => void confirmDelete()}
              >
                Confirmar exclusão?
              </button>
              <button type="button" className="export-btn" onClick={() => setConfirmingDelete(false)}>
                Cancelar
              </button>
            </>
          ) : (
            <button type="button" className="export-btn" onClick={() => setConfirmingDelete(true)}>
              Excluir
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="stage-body">
          <div className="stage-block">
            <div className="label-mini">
              Origem: <span className={`stage-badge ${originBadgeClass(p.origin)}`}>{originLabel(p.origin)}</span>
              {detail && (
                <span className="muted" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                  {detail}
                </span>
              )}
              {link && (
                <Link to={link.to} className="session-link" style={{ marginLeft: 8, marginTop: 0 }}>
                  {link.label}
                </Link>
              )}
            </div>
          </div>

          <div className="stage-block">
            <div className="label-mini">{`Prompt atual (v${p.version})`}</div>
            <pre className="context-pre" style={{ maxHeight: 360 }}>{p.text}</pre>
          </div>

          <div className="stage-block">
            <div className="label-mini" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              Versão
              <select
                className="input"
                style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}
                value={sel?.version ?? p.version}
                onChange={(e) => setSelVersion(Number(e.target.value))}
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {`v${v.version} — ${formatDate(v.savedAt)}${v.version === p.version ? ' (atual)' : ''}`}
                  </option>
                ))}
              </select>
              {prev && sel && (
                <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {`diff de v${sel.version} vs. v${prev.version}`}
                </span>
              )}
            </div>
            {prev && sel ? (
              <pre className="context-pre studio-diff" style={{ maxHeight: 360 }}>
                {diff.map((l, i) => (
                  <div key={i} className={`diff-line diff-${l.type}`}>
                    <span className="diff-gutter">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                    {l.text || ' '}
                  </div>
                ))}
              </pre>
            ) : (
              <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                Primeira versão — não há versão anterior para comparar.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PromptsPage() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    listPrompts()
      .then((list) => {
        if (active) setPrompts(list);
      })
      .catch(() => undefined) // promptStore já degrada p/ [] sem IndexedDB
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prompts;
    return prompts.filter(
      (p) => p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q),
    );
  }, [prompts, query]);

  function handleUpdated(updated: SavedPrompt) {
    setPrompts((list) => list.map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleDeleted(id: string) {
    setPrompts((list) => list.filter((p) => p.id !== id));
  }

  return (
    <div className="screen">
      <h1 className="page-title">Prompts</h1>
      <p className="page-sub">
        Biblioteca de prompts salvos dos treinos e variações, com histórico de versões.
      </p>

      <div className="hist-toolbar">
        <input
          className="input input-pill search-input"
          placeholder="Buscar por nome ou conteúdo…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="inline-status">
          <span className="spinner" /> Carregando prompts…
        </div>
      ) : prompts.length === 0 ? (
        <div className="table-card">
          <div className="table-empty">
            Nenhum prompt salvo ainda — salve o campeão de um treino ou variação
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="table-card">
          <div className="table-empty">Nenhum prompt corresponde à busca.</div>
        </div>
      ) : (
        visible.map((p) => (
          <PromptItem key={p.id} prompt={p} onUpdated={handleUpdated} onDeleted={handleDeleted} />
        ))
      )}
    </div>
  );
}
