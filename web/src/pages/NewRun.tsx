import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ModelSelector } from '../components/ModelSelector';
import { createRun, fetchModels, getStoredKey, type OpenRouterModel } from '../api';

// Defaults da run (ajustáveis na própria tela antes de iniciar).
const DEFAULT_COMPETITORS = [
  'openai/gpt-5-mini',
  'openai/gpt-5-nano',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
];
const DEFAULT_DATAGEN = 'deepseek/deepseek-v4-pro';
const DEFAULT_JUDGE = 'moonshotai/kimi-k2.6';
const DEFAULT_THEME =
  'Assistente virtual de uma clínica de diagnósticos que orienta os pacientes no preparo para exames médicos e laboratoriais. ' +
  'Responde a dúvidas específicas conforme cada tipo de exame — por exemplo: tempo de jejum necessário (ex.: 8 horas para glicemia em jejum), ' +
  'se deve suspender ou manter medicamentos de uso contínuo, ingestão de água permitida, restrições alimentares e de bebidas, preparo intestinal, ' +
  'coleta e armazenamento de amostras, documentos e pedido médico necessários, horários de coleta e como reagendar. ' +
  'As respostas devem ser claras, objetivas e seguras, sempre baseadas nas instruções do exame solicitado, ' +
  'orientando o paciente a confirmar com a clínica ou com seu médico quando a dúvida envolver decisão clínica individual.';
const DEFAULT_MAX_OUTPUT_TOKENS = 500;

const PIPELINE = [
  { num: '1', title: 'Gerador', desc: 'cria os cenários' },
  { num: '2', title: 'Competidores', desc: 'respondem em paralelo' },
  { num: '3', title: 'Juiz', desc: 'ranqueia às cegas' },
];

const PRESETS: { label: string; theme: string }[] = [
  {
    label: 'E-commerce',
    theme:
      'Suporte de um e-commerce de eletrônicos: política de trocas, devoluções e garantia, com base no CDC e nas regras da loja.',
  },
  {
    label: 'Tutor',
    theme:
      'Tutor de matemática do ensino médio: explica o raciocínio passo a passo, sem entregar só a resposta final.',
  },
  {
    label: 'Triagem SaaS',
    theme:
      'Triagem automática de tickets de suporte de um SaaS: classifica a prioridade (P0–P3) e roteia para a fila certa.',
  },
];

const RANGES = {
  stages: [1, 50, 1],
  maxOutputTokens: [50, 16000, 50],
  concurrency: [1, 32, 1],
  timeoutMs: [1000, 300000, 1000],
} as const;

function fmtUsd(x: number): string {
  if (!x) return '$0.0000';
  if (x < 0.0001) return `$${x.toExponential(2)}`;
  return `$${x.toFixed(4)}`;
}

function Stepper({
  label,
  value,
  onStep,
}: {
  label: string;
  value: number;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <div className="stepper-field">
      <label>{label}</label>
      <div className="stepper">
        <button type="button" className="stepper-btn" aria-label={`Diminuir ${label}`} onClick={() => onStep(-1)}>
          −
        </button>
        <span className="stepper-val tnum">{value}</span>
        <button type="button" className="stepper-btn" aria-label={`Aumentar ${label}`} onClick={() => onStep(1)}>
          +
        </button>
      </div>
    </div>
  );
}

export function NewRun() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [stages, setStages] = useState(5);
  const [competitors, setCompetitors] = useState<string[]>(DEFAULT_COMPETITORS);
  const [datagen, setDatagen] = useState<string[]>([DEFAULT_DATAGEN]);
  const [judge, setJudge] = useState<string[]>([DEFAULT_JUDGE]);
  const [concurrency, setConcurrency] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(DEFAULT_MAX_OUTPUT_TOKENS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catálogo compartilhado entre os 3 seletores + estimativa de custo.
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetchModels()
      .then((data) => active && setModels(data))
      .catch(() => undefined)
      .finally(() => active && setModelsLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const priceById = useMemo(() => {
    const map = new Map<string, OpenRouterModel>();
    for (const m of models) map.set(m.id, m);
    return map;
  }, [models]);

  function costOf(modelId: string, tin: number, tout: number): number {
    const m = priceById.get(modelId);
    if (!m) return 0;
    return tin * m.pricing.prompt + tout * m.pricing.completion;
  }

  const estimate = useMemo(() => {
    const comps = competitors.length;
    const ctxIn = 500;
    let perStage = 0;
    for (const id of competitors) perStage += costOf(id, ctxIn, maxOutputTokens);
    if (datagen[0]) perStage += costOf(datagen[0], 300, 450);
    if (judge[0]) perStage += costOf(judge[0], ctxIn + comps * maxOutputTokens, 350);
    const point = perStage * stages;
    return {
      comps,
      stages,
      calls: stages * (comps + 2),
      low: point * 0.45,
      high: point,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitors, datagen, judge, stages, maxOutputTokens, priceById]);

  function step(
    key: keyof typeof RANGES,
    current: number,
    setter: (v: number) => void,
    dir: 1 | -1,
  ) {
    const [min, max, by] = RANGES[key];
    setter(Math.max(min, Math.min(max, current + dir * by)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!theme.trim()) return setError('Defina um tema.');
    if (competitors.length < 2) return setError('Selecione pelo menos 2 competidores.');
    if (datagen.length !== 1) return setError('Selecione 1 modelo para gerador.');
    if (judge.length !== 1) return setError('Selecione 1 modelo para juiz.');

    setSubmitting(true);
    try {
      const runId = await createRun({
        theme: theme.trim(),
        stages,
        competitorModelIds: competitors,
        datagenModelId: datagen[0],
        judgeModelId: judge[0],
        concurrency,
        timeoutMs,
        maxOutputTokens,
      });
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const keyConnected = !!getStoredKey();

  return (
    <form className="screen" onSubmit={submit}>
      <h1 className="page-title">Nova Run</h1>
      <p className="page-sub">
        Defina um tema, escolha os modelos e dispare o benchmark. Tudo vem pré‑preenchido —
        ajuste o que quiser.
      </p>

      <div className="pipeline">
        {PIPELINE.map((p, i) => (
          <Fragment key={p.num}>
            <div className="pipeline-step">
              <span className="pipeline-num">{p.num}</span>
              <span className="pipeline-text">
                <span className="pipeline-title">{p.title}</span>
                <span className="pipeline-desc">{p.desc}</span>
              </span>
            </div>
            {i < PIPELINE.length - 1 && <span className="pipeline-arrow">→</span>}
          </Fragment>
        ))}
      </div>

      <div className="newrun-grid">
        <div className="newrun-main">
          <div className="card field-card">
            <div className="field-head">
              <label className="field-label" htmlFor="theme">Tema</label>
              <div className="preset-row">
                <span className="preset-lead">Exemplos:</span>
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" className="chip-tag" onClick={() => setTheme(p.theme)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              id="theme"
              className="textarea"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="Ex.: Atendimento de clínica de exames laboratoriais com FAQs e políticas de agendamento"
              rows={3}
            />
          </div>

          <div className="card steppers-card">
            <div className="steppers-grid">
              <Stepper label="Etapas" value={stages} onStep={(d) => step('stages', stages, setStages, d)} />
              <Stepper
                label="Max tokens"
                value={maxOutputTokens}
                onStep={(d) => step('maxOutputTokens', maxOutputTokens, setMaxOutputTokens, d)}
              />
            </div>
            {advancedOpen && (
              <div className="steppers-grid" style={{ marginTop: 14 }}>
                <Stepper
                  label="Concorrência"
                  value={concurrency}
                  onStep={(d) => step('concurrency', concurrency, setConcurrency, d)}
                />
                <Stepper
                  label="Timeout (ms)"
                  value={timeoutMs}
                  onStep={(d) => step('timeoutMs', timeoutMs, setTimeoutMs, d)}
                />
              </div>
            )}
            <button type="button" className="link-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen ? 'Ocultar ajustes avançados' : 'Ajustes avançados (concorrência, timeout)'}
              <span className={`caret ${advancedOpen ? 'open' : ''}`}>▶</span>
            </button>
          </div>

          <div className="roles-label">Papéis dos modelos</div>

          <ModelSelector
            multi
            title="Competidores"
            hint="2 ou mais modelos — respondem ao cenário e disputam o ranking."
            value={competitors}
            onChange={setCompetitors}
            excludeIds={[...datagen, ...judge]}
            models={models}
            loading={modelsLoading}
          />

          <ModelSelector
            multi={false}
            title="Gerador de cenários"
            hint="Exatamente 1 modelo — inventa pergunta, contexto e teto de tokens."
            value={datagen}
            onChange={setDatagen}
            excludeIds={[...competitors, ...judge]}
            models={models}
            loading={modelsLoading}
          />

          <ModelSelector
            multi={false}
            title="Juiz"
            hint="Exatamente 1 modelo — ranqueia às cegas e avalia a aceitabilidade."
            value={judge}
            onChange={setJudge}
            excludeIds={[...competitors, ...datagen]}
            models={models}
            loading={modelsLoading}
          />

          <div className="roles-note">
            Gerador e juiz usam um único modelo cada. Um mesmo modelo não pode ocupar dois
            papéis — os já escolhidos somem das outras listas.
          </div>
        </div>

        <aside className="card newrun-aside">
          <div className="kicker" style={{ display: 'block', marginBottom: 16 }}>Resumo da run</div>
          <div className="summary-rows">
            <div className="summary-row">
              <span className="k">Competidores</span>
              <span className="v">{estimate.comps}</span>
            </div>
            <div className="summary-row">
              <span className="k">Etapas</span>
              <span className="v">{estimate.stages}</span>
            </div>
            <div className="summary-row">
              <span className="k">Chamadas de modelo</span>
              <span className="v">{estimate.calls}</span>
            </div>
          </div>
          <div className="summary-divider" />
          <div className="est-label">Custo estimado</div>
          <div className="est-cost">
            {modelsLoading ? '—' : `${fmtUsd(estimate.low)} – ${fmtUsd(estimate.high)}`}
          </div>
          <div className="est-note">Estimado pelo teto de tokens. O custo real costuma ficar abaixo disso.</div>

          {error && <div className="aside-error">{error}</div>}

          <button type="submit" className="btn-primary btn-block" disabled={submitting} style={{ marginTop: 18 }}>
            {submitting ? 'Iniciando…' : 'Iniciar benchmark'}
          </button>
          {keyConnected && <div className="aside-key-ok">✓ chave conectada</div>}
        </aside>
      </div>
    </form>
  );
}
