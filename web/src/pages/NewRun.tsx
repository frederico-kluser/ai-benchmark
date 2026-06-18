import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ModelSelector } from '../components/ModelSelector';
import { Toggle } from '../components/Toggle';
import { TechniqueSelector } from '../components/TechniqueSelector';
import { ManualVariantsEditor } from '../components/ManualVariantsEditor';
import { useHelp } from '../help';
import {
  createRun,
  createSession,
  fetchLgpd,
  fetchModels,
  getStoredKey,
  type ManualVariant,
  type OpenRouterModel,
  type RunConfig,
  type RunMode,
} from '../api';
import { AREA_LIVRE, filterModels, isAllowed, type LgpdData } from '../lgpd';

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

// Os 3 objetivos, agora apresentados como cartões escolhíveis no passo 1.
const MODE_META: { id: RunMode; icon: string; label: string; tagline: string; detail: string }[] = [
  {
    id: 'compare',
    icon: '⚖️',
    label: 'Comparar modelos',
    tagline: 'Vários modelos, o mesmo desafio',
    detail: 'Descubra qual LLM responde melhor ao seu caso. Todos respondem às mesmas perguntas e o juiz monta o ranking.',
  },
  {
    id: 'variation',
    icon: '🧬',
    label: 'Testar prompts',
    tagline: 'Um modelo, vários system prompts',
    detail: 'Mantém o modelo fixo e compara várias versões do prompt para achar a que funciona melhor.',
  },
  {
    id: 'training',
    icon: '📈',
    label: 'Treinar prompt',
    tagline: 'Auto-melhoria iterativa',
    detail: 'A cada rodada a melhor versão do prompt evolui sozinha, convergindo para o melhor prompt possível.',
  },
];

// Os 5 passos do assistente (mesma sequência para todos os modos).
const STEPS = [
  { id: 'mode', label: 'Objetivo' },
  { id: 'theme', label: 'Tema' },
  { id: 'players', label: 'Participantes' },
  { id: 'eval', label: 'Avaliação' },
  { id: 'review', label: 'Revisar' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

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

function scrollToTop() {
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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

// Diagrama do fluxo Gerador → (Competidores/Variações) → Juiz para o modo atual.
function Pipeline({ mode, iterations }: { mode: RunMode; iterations: number }) {
  const pipeline = pipelineFor(mode);
  return (
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
  );
}

// Trilha de progresso clicável no topo do assistente.
function StepProgress({
  current,
  firstInvalid,
  onJump,
}: {
  current: number;
  firstInvalid: number;
  onJump: (i: number) => void;
}) {
  return (
    <ol className="wizard-steps">
      {STEPS.map((s, i) => {
        const state = i === current ? 'current' : i < current ? 'done' : 'todo';
        const reachable = i <= current || i <= firstInvalid;
        return (
          <Fragment key={s.id}>
            <li className={`wizard-step ${state}`}>
              <button type="button" className="wizard-step-btn" disabled={!reachable} onClick={() => onJump(i)}>
                <span className="wizard-step-num">{i < current ? '✓' : i + 1}</span>
                <span className="wizard-step-label">{s.label}</span>
              </button>
            </li>
            {i < STEPS.length - 1 && <span className="wizard-step-line" aria-hidden />}
          </Fragment>
        );
      })}
    </ol>
  );
}

// Cabeçalho padrão de cada passo: rótulo "Passo N de 5", título e texto explicativo.
function StepIntro({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <div className="wizard-intro">
      <div className="wizard-kicker">Passo {step} de {STEPS.length}</div>
      <h2 className="wizard-title">{title}</h2>
      <p className="wizard-lead">{children}</p>
    </div>
  );
}

export function NewRun() {
  const navigate = useNavigate();
  const help = useHelp();
  const [mode, setMode] = useState<RunMode>('compare');
  const [stepIdx, setStepIdx] = useState(0);
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

  // Conformidade LGPD (passo Tema). 'livre' = sem filtro (default, não quebra os
  // modelos pré-selecionados). Consultivo: filtra o catálogo, não força roteamento.
  const [complianceArea, setComplianceArea] = useState<string>(AREA_LIVRE);
  const [includeRessalvas, setIncludeRessalvas] = useState(true);
  const [lgpd, setLgpd] = useState<LgpdData | null>(null);
  const [prunedNotice, setPrunedNotice] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSingle = mode === 'variation' || mode === 'training';
  const modeMeta = MODE_META.find((m) => m.id === mode)!;

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

  // Carrega a base de conhecimento LGPD (servida por GET /v1/benchmark/lgpd).
  useEffect(() => {
    let active = true;
    fetchLgpd()
      .then((d) => active && setLgpd(d))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Catálogo filtrado pelo propósito/área (passo Tema). Em 'livre' (ou enquanto a
  // base não carregou) devolve o catálogo inteiro. Usado em todos os seletores.
  const filteredModels = useMemo(() => {
    if (!lgpd || complianceArea === AREA_LIVRE) return models;
    return filterModels(models, complianceArea, includeRessalvas, lgpd).allowed;
  }, [models, lgpd, complianceArea, includeRessalvas]);

  // Espelho das seleções p/ a poda ler o estado mais recente sem re-rodar a cada
  // clique de seleção (só quando área/rigor/base mudam).
  const selRef = useRef({ competitors, contestantModel, datagen, judge });
  selRef.current = { competitors, contestantModel, datagen, judge };

  // Ao mudar área/rigor, remove das seleções (inclusive os defaults) os modelos
  // que deixaram de ser permitidos e avisa quais saíram.
  useEffect(() => {
    if (!lgpd || complianceArea === AREA_LIVRE) {
      setPrunedNotice(null);
      return;
    }
    const removed = new Set<string>();
    const keep = (ids: string[]) =>
      ids.filter((id) => {
        if (isAllowed(id, complianceArea, includeRessalvas, lgpd)) return true;
        removed.add(id);
        return false;
      });
    const { competitors: c, contestantModel: cm, datagen: dg, judge: jg } = selRef.current;
    const nc = keep(c);
    const ncm = keep(cm);
    const ndg = keep(dg);
    const njg = keep(jg);
    if (nc.length !== c.length) setCompetitors(nc);
    if (ncm.length !== cm.length) setContestantModel(ncm);
    if (ndg.length !== dg.length) setDatagen(ndg);
    if (njg.length !== jg.length) setJudge(njg);
    const areaLabel = lgpd.areas.find((a) => a.id === complianceArea)?.label ?? complianceArea;
    setPrunedNotice(
      removed.size
        ? `Removidos por não atenderem "${areaLabel}": ${[...removed].join(', ')}.`
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complianceArea, includeRessalvas, lgpd]);

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

  // --- Validação por passo: o assistente só avança quando o passo está completo. ---
  function validateStep(id: StepId): string | null {
    switch (id) {
      case 'mode':
        return null;
      case 'theme':
        return theme.trim() ? null : 'Descreva o tema do benchmark para continuar.';
      case 'players':
        if (mode === 'compare')
          return competitors.length >= 2 ? null : 'Selecione pelo menos 2 modelos competidores.';
        if (contestantModel.length !== 1) return 'Selecione 1 modelo sob teste.';
        if (variantCount < 2)
          return optimize
            ? 'Selecione ao menos 2 técnicas (ou 1 técnica + prompt base).'
            : 'Forneça ao menos 2 variantes manuais (ou 1 variante + prompt base).';
        return null;
      case 'eval':
        if (datagen.length !== 1) return 'Selecione 1 modelo gerador.';
        if (judge.length !== 1) return 'Selecione 1 modelo juiz.';
        return null;
      case 'review':
        return null;
      default:
        return null;
    }
  }

  function firstInvalid(): number {
    for (let i = 0; i < STEPS.length; i++) {
      if (validateStep(STEPS[i].id)) return i;
    }
    return STEPS.length;
  }

  function goTo(target: number) {
    let dest = Math.max(0, Math.min(STEPS.length - 1, target));
    if (dest > stepIdx) {
      // Avançando: barra no primeiro passo incompleto e mostra o que falta.
      const fi = firstInvalid();
      if (fi < dest) {
        dest = fi;
        setError(validateStep(STEPS[fi].id));
      } else {
        setError(null);
      }
    } else {
      setError(null);
    }
    setStepIdx(dest);
    scrollToTop();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Enter fora do último passo apenas avança o assistente (não dispara a run).
    if (STEPS[stepIdx].id !== 'review') {
      goTo(stepIdx + 1);
      return;
    }

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
      ...(isLivre ? {} : { compliance: { area: complianceArea, includeRessalvas } }),
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
  const stepId = STEPS[stepIdx].id;
  const fi = firstInvalid();
  const isLivre = complianceArea === AREA_LIVRE;
  const areaMeta = lgpd && !isLivre ? lgpd.areas.find((a) => a.id === complianceArea) : undefined;
  const areaLabel = isLivre ? 'Livre — todos os modelos' : (areaMeta?.label ?? complianceArea);

  return (
    <form className="screen wizard" onSubmit={submit}>
      <header className="wizard-head">
        <h1 className="page-title">Nova Run</h1>
        <p className="page-sub">
          Monte seu benchmark em {STEPS.length} passos. Cada etapa explica o que faz — no fim, é só disparar os robôs.
        </p>
      </header>

      <StepProgress current={stepIdx} firstInvalid={fi} onJump={goTo} />

      <div className="wizard-panel" key={stepId}>
        {/* ---------------------------------------------------------- passo 1: objetivo */}
        {stepId === 'mode' && (
          <>
            <StepIntro step={1} title="O que você quer descobrir?">
              Escolha o tipo de experimento. Dá para trocar a qualquer momento — cada opção mostra abaixo como funciona.
            </StepIntro>
            <div className="mode-card-grid">
              {MODE_META.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={`mode-card ${mode === m.id ? 'selected' : ''}`}
                  onClick={() => setMode(m.id)}
                >
                  <span className="mode-card-icon">{m.icon}</span>
                  <span className="mode-card-title">{m.label}</span>
                  <span className="mode-card-tag">{m.tagline}</span>
                  <span className="mode-card-detail">{m.detail}</span>
                </button>
              ))}
            </div>
            <div className="wizard-pipeline-wrap">
              <div className="wizard-sub">Como roda o modo “{modeMeta.label}”</div>
              <Pipeline mode={mode} iterations={iterations} />
              <button type="button" className="link-toggle" onClick={() => help.open(mode)}>
                Ver tutorial completo deste modo
              </button>
            </div>
          </>
        )}

        {/* ---------------------------------------------------------- passo 2: tema */}
        {stepId === 'theme' && (
          <>
            <StepIntro step={2} title="Sobre o que é o benchmark?">
              Descreva o assunto ou cenário. Um modelo <strong>gerador</strong> vai criar várias perguntas realistas sobre
              esse tema — são elas que os participantes respondem. Quanto mais específico, melhores as perguntas.
            </StepIntro>
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
                rows={5}
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
              <p className="field-hint">
                <strong>Etapas</strong> = quantas perguntas diferentes o gerador cria. <strong>Max tokens</strong> limita o
                tamanho de cada resposta.
                {mode === 'training' && <> <strong>Iterações</strong> = quantas rodadas de evolução do prompt.</>}
              </p>
            </div>

            {/* Propósito / Conformidade LGPD: filtra (consultivo) o catálogo dos próximos passos. */}
            <div className="card proposito-card">
              <div className="field-head">
                <label className="field-label">Propósito / Conformidade LGPD</label>
                {!isLivre && (
                  <span className="proposito-count">
                    {modelsLoading ? '—' : `${filteredModels.length} de ${models.length} modelos permitidos`}
                  </span>
                )}
              </div>
              <p className="field-hint" style={{ marginTop: 0 }}>
                Restringe os modelos disponíveis nos próximos passos conforme a área de uso e a LGPD.
                É <strong>consultivo</strong> — orienta a escolha, mas não altera o roteamento de providers do OpenRouter.
              </p>

              <div className="proposito-grid">
                <button
                  type="button"
                  className={`proposito-chip ${isLivre ? 'selected' : ''}`}
                  onClick={() => setComplianceArea(AREA_LIVRE)}
                >
                  <span className="proposito-chip-label">🔓 Livre</span>
                  <span className="proposito-chip-sub">permitir todos os modelos</span>
                </button>
                {lgpd?.areas.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`proposito-chip ${complianceArea === a.id ? 'selected' : ''}`}
                    onClick={() => setComplianceArea(a.id)}
                  >
                    <span className="proposito-chip-label">{a.label}</span>
                  </button>
                ))}
              </div>

              {areaMeta && (
                <>
                  <p className="proposito-desc">{areaMeta.descricao}</p>
                  <Toggle
                    checked={includeRessalvas}
                    onChange={setIncludeRessalvas}
                    label="Incluir modelos “permitido com ressalvas”"
                    hint={
                      includeRessalvas
                        ? 'Ligado: inclui modelos permitidos sob condições (ZDR, DPA, SCCs, BAA, comunicação ao BACEN…).'
                        : 'Desligado (rigor máximo): apenas modelos plenamente permitidos para a área.'
                    }
                  />
                  {lgpd && <div className="proposito-aviso">⚠️ {lgpd.aviso}</div>}
                </>
              )}

              {prunedNotice && <div className="proposito-pruned">{prunedNotice}</div>}
            </div>
          </>
        )}

        {/* ---------------------------------------------------------- passo 3: participantes */}
        {stepId === 'players' && (
          <>
            {mode === 'compare' ? (
              <>
                <StepIntro step={3} title="Quais modelos vão competir?">
                  Escolha 2 ou mais modelos. Todos respondem às mesmas perguntas e disputam o ranking — o juiz decide quem
                  foi melhor, sem saber qual modelo é qual.
                </StepIntro>
                <ModelSelector
                  multi
                  title="Competidores"
                  hint="2 ou mais modelos — respondem ao cenário e disputam o ranking."
                  value={competitors}
                  onChange={setCompetitors}
                  excludeIds={[...datagen, ...judge]}
                  models={filteredModels}
                  loading={modelsLoading}
                />
              </>
            ) : (
              <>
                <StepIntro
                  step={3}
                  title={mode === 'training' ? 'Qual modelo vamos treinar?' : 'Qual modelo e quais prompts testar?'}
                >
                  {mode === 'training' ? (
                    <>
                      Escolha 1 modelo. A cada iteração, a melhor versão do system prompt evolui para a próxima rodada —
                      convergindo para o melhor prompt possível.
                    </>
                  ) : (
                    <>
                      Escolha 1 modelo. Ele responde com várias versões do system prompt; o objetivo é achar a melhor. Gere
                      as variações automaticamente a partir de técnicas, ou escreva as suas.
                    </>
                  )}
                </StepIntro>
                <ModelSelector
                  multi={false}
                  title="Modelo sob teste"
                  hint="Exatamente 1 — a LLM cujo system prompt você quer otimizar."
                  value={contestantModel}
                  onChange={setContestantModel}
                  excludeIds={[...datagen, ...judge]}
                  models={filteredModels}
                  loading={modelsLoading}
                />

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
                </div>

                {optimize ? (
                  <TechniqueSelector value={techniques} onChange={setTechniques} />
                ) : (
                  <ManualVariantsEditor value={manualVariants} onChange={setManualVariants} />
                )}
              </>
            )}
          </>
        )}

        {/* ---------------------------------------------------------- passo 4: avaliação */}
        {stepId === 'eval' && (
          <>
            <StepIntro step={4} title="Quem cria as perguntas e quem julga?">
              Dois modelos de apoio: o <strong>gerador</strong> inventa os cenários do benchmark e o <strong>juiz</strong>{' '}
              compara as respostas às cegas, apontando a melhor. Eles não competem
              {isSingle ? ' — e o juiz nunca é o modelo sob teste, para evitar viés.' : '.'}
            </StepIntro>

            <ModelSelector
              multi={false}
              title="Gerador de cenários"
              hint="Exatamente 1 modelo — inventa as perguntas do benchmark."
              value={datagen}
              onChange={setDatagen}
              excludeIds={[...(mode === 'compare' ? competitors : contestantModel), ...judge]}
              models={filteredModels}
              loading={modelsLoading}
            />

            <ModelSelector
              multi={false}
              title="Juiz"
              hint="Exatamente 1 modelo — ranqueia às cegas e avalia a aceitabilidade."
              value={judge}
              onChange={setJudge}
              excludeIds={[...(mode === 'compare' ? competitors : contestantModel), ...datagen]}
              models={filteredModels}
              loading={modelsLoading}
            />

            <div className="roles-note">
              {mode === 'compare'
                ? 'Gerador e juiz usam um único modelo cada. Um mesmo modelo não pode ocupar dois papéis — os já escolhidos somem das outras listas.'
                : 'O juiz não pode ser o modelo sob teste (evita viés de auto-preferência). Gerador e juiz são modelos à parte.'}
            </div>

            {isSingle && (
              <div className="card field-card" style={{ marginTop: 16 }}>
                <Toggle
                  checked={twoPassJudge}
                  onChange={setTwoPassJudge}
                  label="Juiz em 2 ordens (anti-viés de posição)"
                  hint="Avalia cada etapa em duas ordens embaralhadas e tira a média — recomendado quando as variações são parecidas. Dobra o custo do juiz."
                />
              </div>
            )}

            <div className="card steppers-card">
              {advancedOpen && (
                <div className="steppers-grid">
                  <Stepper label="Concorrência" value={concurrency} onStep={(d) => step('concurrency', concurrency, setConcurrency, d)} />
                  <Stepper label="Timeout (ms)" value={timeoutMs} onStep={(d) => step('timeoutMs', timeoutMs, setTimeoutMs, d)} />
                </div>
              )}
              <button type="button" className="link-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
                {advancedOpen ? 'Ocultar ajustes avançados' : 'Ajustes avançados (concorrência, timeout)'}
                <span className={`caret ${advancedOpen ? 'open' : ''}`}>▶</span>
              </button>
              {advancedOpen && (
                <p className="field-hint">
                  <strong>Concorrência</strong> = quantas chamadas em paralelo. <strong>Timeout</strong> = tempo máximo por
                  resposta antes de desistir.
                </p>
              )}
            </div>
          </>
        )}

        {/* ---------------------------------------------------------- passo 5: revisão */}
        {stepId === 'review' && (
          <>
            <StepIntro step={5} title="Confira e dispare os robôs">
              Revise o resumo abaixo. Quando estiver tudo certo, é só disparar — você vai acompanhar cada modelo respondendo
              ao vivo na próxima tela.
            </StepIntro>

            <div className="review-grid">
              <div className="card review-card">
                <div className="kicker" style={{ display: 'block', marginBottom: 14 }}>Resumo da run</div>
                <div className="summary-rows">
                  <div className="summary-row">
                    <span className="k">Modo</span>
                    <span className="v">{modeMeta.label}</span>
                  </div>
                  <div className="summary-row">
                    <span className="k">Propósito (LGPD)</span>
                    <span className="v">
                      {areaLabel}
                      {!isLivre && !includeRessalvas ? ' · rigor máximo' : ''}
                    </span>
                  </div>
                  <div className="summary-row">
                    <span className="k">{isSingle ? 'Variantes de prompt' : 'Competidores'}</span>
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
                    <span className="k">Gerador</span>
                    <span className="v v-mono">{datagen[0] ?? '—'}</span>
                  </div>
                  <div className="summary-row">
                    <span className="k">Juiz</span>
                    <span className="v v-mono">{judge[0] ?? '—'}</span>
                  </div>
                  <div className="summary-row">
                    <span className="k">Chamadas de modelo</span>
                    <span className="v">{estimate.calls}</span>
                  </div>
                </div>
                <div className="summary-divider" />
                <div className="review-theme-label">Tema</div>
                <p className="review-theme">{theme.trim() || '—'}</p>
              </div>

              <div className="card review-card review-cost-card">
                <div className="est-label">Custo estimado</div>
                <div className="est-cost">
                  {modelsLoading ? '—' : `${fmtUsd(estimate.low)} – ${fmtUsd(estimate.high)}`}
                </div>
                <div className="est-note">
                  Estima a inferência do benchmark pelo teto de tokens. A geração/análise de variações (otimização) não está
                  inclusa.
                </div>
                {keyConnected ? (
                  <div className="aside-key-ok">✓ chave conectada</div>
                ) : (
                  <p className="field-hint" style={{ marginTop: 12 }}>
                    Conecte sua chave da OpenRouter em <strong>Configurações</strong> antes de disparar.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="wizard-foot">
        {error && <div className="wizard-error">{error}</div>}
        <div className="wizard-nav">
          {stepIdx > 0 ? (
            <button type="button" className="btn-secondary" onClick={() => goTo(stepIdx - 1)}>
              ← Voltar
            </button>
          ) : (
            <span />
          )}
          {stepId !== 'review' ? (
            <button type="button" className="btn-primary" onClick={() => goTo(stepIdx + 1)}>
              Continuar →
            </button>
          ) : (
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Disparando…' : mode === 'training' ? '🚀 Disparar o treino' : '🚀 Disparar os robôs'}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
