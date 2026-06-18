import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ModelSelector } from '../components/ModelSelector';
import { ModeTabs } from '../components/ModeTabs';
import { Toggle } from '../components/Toggle';
import { TechniqueSelector } from '../components/TechniqueSelector';
import { ManualVariantsEditor } from '../components/ManualVariantsEditor';
import {
  createRun,
  createSession,
  fetchModels,
  getStoredKey,
  type ManualVariant,
  type OpenRouterModel,
  type RunConfig,
  type RunMode,
} from '../api';

// Defaults da run (ajustáveis na própria tela antes de iniciar).
const DEFAULT_COMPETITORS = [
  'openai/gpt-5-mini',
  'openai/gpt-5-nano',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
];
const DEFAULT_CONTESTANT = 'openai/gpt-5-mini';
const DEFAULT_DATAGEN = 'deepseek/deepseek-v4-pro';
const DEFAULT_JUDGE = 'moonshotai/kimi-k2.6';
const DEFAULT_TECHNIQUES = ['persona', 'cot', 'constraints', 'format'];
const DEFAULT_THEME =
  'Assistente virtual de uma clínica de diagnósticos que orienta os pacientes no preparo para exames médicos e laboratoriais. ' +
  'Responde a dúvidas específicas conforme cada tipo de exame — por exemplo: tempo de jejum necessário (ex.: 8 horas para glicemia em jejum), ' +
  'se deve suspender ou manter medicamentos de uso contínuo, ingestão de água permitida, restrições alimentares e de bebidas, preparo intestinal, ' +
  'coleta e armazenamento de amostras, documentos e pedido médico necessários, horários de coleta e como reagendar. ' +
  'As respostas devem ser claras, objetivas e seguras, sempre baseadas nas instruções do exame solicitado, ' +
  'orientando o paciente a confirmar com a clínica ou com seu médico quando a dúvida envolver decisão clínica individual.';
const DEFAULT_MAX_OUTPUT_TOKENS = 500;

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

const MODE_DESC: Record<RunMode, string> = {
  compare: 'Vários modelos competem no mesmo benchmark — descubra qual responde melhor.',
  variation: 'Um modelo, várias variações de system prompt competindo — descubra o melhor prompt.',
  training: 'Um modelo: a cada iteração a melhor variação evolui (auto-melhoria do prompt).',
};

function pipelineFor(mode: RunMode) {
  if (mode === 'compare') {
    return [
      { num: '1', title: 'Gerador', desc: 'cria os cenários' },
      { num: '2', title: 'Competidores', desc: 'respondem em paralelo' },
      { num: '3', title: 'Juiz', desc: 'ranqueia às cegas' },
    ];
  }
  return [
    { num: '1', title: 'Gerador', desc: 'cria as perguntas' },
    {
      num: '2',
      title: 'Variações',
      desc: mode === 'training' ? '1 modelo, evoluídas por iteração' : '1 modelo, vários prompts',
    },
    { num: '3', title: 'Juiz', desc: 'ranqueia às cegas' },
  ];
}

const RANGES = {
  stages: [1, 50, 1],
  maxOutputTokens: [50, 16000, 50],
  concurrency: [1, 32, 1],
  timeoutMs: [1000, 300000, 1000],
  iterations: [2, 10, 1],
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
  const [mode, setMode] = useState<RunMode>('compare');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [stages, setStages] = useState(5);
  const [concurrency, setConcurrency] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(DEFAULT_MAX_OUTPUT_TOKENS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [datagen, setDatagen] = useState<string[]>([DEFAULT_DATAGEN]);
  const [judge, setJudge] = useState<string[]>([DEFAULT_JUDGE]);

  // compare
  const [competitors, setCompetitors] = useState<string[]>(DEFAULT_COMPETITORS);

  // variation / training
  const [contestantModel, setContestantModel] = useState<string[]>([DEFAULT_CONTESTANT]);
  const [basePrompt, setBasePrompt] = useState('');
  const [optimize, setOptimize] = useState(true);
  const [techniques, setTechniques] = useState<string[]>(DEFAULT_TECHNIQUES);
  const [manualVariants, setManualVariants] = useState<ManualVariant[]>([
    { label: 'Variante 1', systemPrompt: '' },
    { label: 'Variante 2', systemPrompt: '' },
  ]);
  const [iterations, setIterations] = useState(3);
  const [twoPassJudge, setTwoPassJudge] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSingle = mode === 'variation' || mode === 'training';

  // Catálogo compartilhado entre os seletores + estimativa de custo.
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

  // nº de variantes (modos de 1 LLM) ou de competidores (compare).
  const variantCount = useMemo(() => {
    if (!isSingle) return competitors.length;
    const base = basePrompt.trim() ? 1 : 0;
    if (optimize) return techniques.length + base;
    return manualVariants.filter((v) => v.systemPrompt.trim()).length + base;
  }, [isSingle, competitors, basePrompt, optimize, techniques, manualVariants]);

  const estimate = useMemo(() => {
    const ctxIn = 500;
    const n = variantCount;
    const contestantIds = isSingle
      ? contestantModel[0]
        ? new Array(n).fill(contestantModel[0])
        : []
      : competitors;
    let perStage = 0;
    for (const id of contestantIds) perStage += costOf(id, ctxIn, maxOutputTokens);
    if (datagen[0]) perStage += costOf(datagen[0], 300, 450);
    if (judge[0]) perStage += costOf(judge[0], ctxIn + n * maxOutputTokens, 350);
    const iters = mode === 'training' ? iterations : 1;
    const point = perStage * stages * iters;
    return {
      n,
      stages,
      iters,
      calls: stages * (n + 2) * iters,
      low: point * 0.45,
      high: point,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isSingle, competitors, contestantModel, variantCount, datagen, judge, stages, maxOutputTokens, iterations, priceById]);

  function step(key: keyof typeof RANGES, current: number, setter: (v: number) => void, dir: 1 | -1) {
    const [min, max, by] = RANGES[key];
    setter(Math.max(min, Math.min(max, current + dir * by)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!theme.trim()) return setError('Defina um tema.');
    if (datagen.length !== 1) return setError('Selecione 1 modelo para gerador.');
    if (judge.length !== 1) return setError('Selecione 1 modelo para juiz.');

    if (mode === 'compare') {
      if (competitors.length < 2) return setError('Selecione pelo menos 2 competidores.');
    } else {
      if (contestantModel.length !== 1) return setError('Selecione 1 modelo sob teste.');
      if (variantCount < 2) {
        return setError(
          optimize
            ? 'Selecione ao menos 2 técnicas (ou 1 técnica + prompt base).'
            : 'Forneça ao menos 2 variantes manuais (ou 1 variante + prompt base).',
        );
      }
    }

    const common = {
      theme: theme.trim(),
      stages,
      datagenModelId: datagen[0],
      judgeModelId: judge[0],
      concurrency,
      timeoutMs,
      maxOutputTokens,
    };

    let config: RunConfig;
    if (mode === 'compare') {
      config = { mode, ...common, competitorModelIds: competitors };
    } else {
      config = {
        mode,
        ...common,
        contestantModelId: contestantModel[0],
        basePrompt: basePrompt.trim() || undefined,
        promptOptimization: optimize,
        techniqueIds: optimize ? techniques : undefined,
        manualVariants: optimize ? undefined : manualVariants.filter((v) => v.systemPrompt.trim()),
        judgePasses: twoPassJudge ? 2 : 1,
        ...(mode === 'training' ? { iterations } : {}),
      };
    }

    setSubmitting(true);
    try {
      if (mode === 'training') {
        const sessionId = await createSession(config);
        navigate(`/training/${sessionId}`);
      } else {
        const runId = await createRun(config);
        navigate(`/runs/${runId}`);
      }
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const keyConnected = !!getStoredKey();
  const pipeline = pipelineFor(mode);

  return (
    <form className="screen" onSubmit={submit}>
      <h1 className="page-title">Nova Run</h1>
      <p className="page-sub">
        Defina um tema, escolha o modo e dispare o benchmark. Tudo vem pré‑preenchido — ajuste o que quiser.
      </p>

      <ModeTabs value={mode} onChange={setMode} />
      <p className="mode-desc">{MODE_DESC[mode]}</p>

      <div className="pipeline">
        {pipeline.map((p, i) => (
          <Fragment key={p.num}>
            <div className="pipeline-step">
              <span className="pipeline-num">{p.num}</span>
              <span className="pipeline-text">
                <span className="pipeline-title">{p.title}</span>
                <span className="pipeline-desc">{p.desc}</span>
              </span>
            </div>
            {i < pipeline.length - 1 && <span className="pipeline-arrow">→</span>}
          </Fragment>
        ))}
        {mode === 'training' && <span className="pipeline-arrow">↻ {iterations}×</span>}
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
            {mode === 'training' && (
              <div className="steppers-grid" style={{ marginTop: 14 }}>
                <Stepper label="Iterações" value={iterations} onStep={(d) => step('iterations', iterations, setIterations, d)} />
              </div>
            )}
            {advancedOpen && (
              <div className="steppers-grid" style={{ marginTop: 14 }}>
                <Stepper label="Concorrência" value={concurrency} onStep={(d) => step('concurrency', concurrency, setConcurrency, d)} />
                <Stepper label="Timeout (ms)" value={timeoutMs} onStep={(d) => step('timeoutMs', timeoutMs, setTimeoutMs, d)} />
              </div>
            )}
            <button type="button" className="link-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen ? 'Ocultar ajustes avançados' : 'Ajustes avançados (concorrência, timeout)'}
              <span className={`caret ${advancedOpen ? 'open' : ''}`}>▶</span>
            </button>
          </div>

          <div className="roles-label">Papéis dos modelos</div>

          {mode === 'compare' ? (
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
          ) : (
            <ModelSelector
              multi={false}
              title="Modelo sob teste"
              hint="Exatamente 1 — a LLM cujo system prompt você quer otimizar."
              value={contestantModel}
              onChange={setContestantModel}
              excludeIds={[...datagen, ...judge]}
              models={models}
              loading={modelsLoading}
            />
          )}

          <ModelSelector
            multi={false}
            title="Gerador de cenários"
            hint="Exatamente 1 modelo — inventa as perguntas do benchmark."
            value={datagen}
            onChange={setDatagen}
            excludeIds={[...(mode === 'compare' ? competitors : contestantModel), ...judge]}
            models={models}
            loading={modelsLoading}
          />

          <ModelSelector
            multi={false}
            title="Juiz"
            hint="Exatamente 1 modelo — ranqueia às cegas e avalia a aceitabilidade."
            value={judge}
            onChange={setJudge}
            excludeIds={[...(mode === 'compare' ? competitors : contestantModel), ...datagen]}
            models={models}
            loading={modelsLoading}
          />

          <div className="roles-note">
            {mode === 'compare'
              ? 'Gerador e juiz usam um único modelo cada. Um mesmo modelo não pode ocupar dois papéis — os já escolhidos somem das outras listas.'
              : 'O juiz não pode ser o modelo sob teste (evita viés de auto-preferência). Gerador e juiz são modelos à parte.'}
          </div>

          {isSingle && (
            <>
              <div className="roles-label">Variações de prompt</div>
              <div className="card field-card">
                <label className="field-label" htmlFor="basePrompt">Prompt base (opcional)</label>
                <textarea
                  id="basePrompt"
                  className="textarea"
                  style={{ marginTop: 10 }}
                  value={basePrompt}
                  onChange={(e) => setBasePrompt(e.target.value)}
                  placeholder="System prompt de partida. Deixe vazio para que as variações partam do zero a partir do tema."
                  rows={4}
                />
                <Toggle
                  checked={optimize}
                  onChange={setOptimize}
                  label="Otimização de prompt (gerar variações automaticamente)"
                  hint={
                    optimize
                      ? 'Ligado: uma LLM gera as variações aplicando as técnicas selecionadas (o prompt base, quando houver, roda como controle).'
                      : 'Desligado: nenhuma reescrita por LLM — rodam o prompt base (se houver) e as variações que você escrever.'
                  }
                />
                <Toggle
                  checked={twoPassJudge}
                  onChange={setTwoPassJudge}
                  label="Juiz em 2 ordens (anti-viés de posição)"
                  hint="Avalia cada etapa em duas ordens embaralhadas e tira a média — recomendado quando as variações são parecidas. Dobra o custo do juiz."
                />
              </div>

              {optimize ? (
                <TechniqueSelector value={techniques} onChange={setTechniques} />
              ) : (
                <ManualVariantsEditor value={manualVariants} onChange={setManualVariants} />
              )}
            </>
          )}
        </div>

        <aside className="card newrun-aside">
          <div className="kicker" style={{ display: 'block', marginBottom: 16 }}>Resumo da run</div>
          <div className="summary-rows">
            <div className="summary-row">
              <span className="k">{isSingle ? 'Variantes' : 'Competidores'}</span>
              <span className="v">{estimate.n}</span>
            </div>
            <div className="summary-row">
              <span className="k">Etapas</span>
              <span className="v">{estimate.stages}</span>
            </div>
            {mode === 'training' && (
              <div className="summary-row">
                <span className="k">Iterações</span>
                <span className="v">{estimate.iters}</span>
              </div>
            )}
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
          <div className="est-note">
            Estima a inferência do benchmark pelo teto de tokens. Geração de variações/análise (otimização) não está inclusa.
          </div>

          {error && <div className="aside-error">{error}</div>}

          <button type="submit" className="btn-primary btn-block" disabled={submitting} style={{ marginTop: 18 }}>
            {submitting ? 'Iniciando…' : mode === 'training' ? 'Iniciar treino' : 'Iniciar benchmark'}
          </button>
          {keyConnected && <div className="aside-key-ok">✓ chave conectada</div>}
        </aside>
      </div>
    </form>
  );
}
