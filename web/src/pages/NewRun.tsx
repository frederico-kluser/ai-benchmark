import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ModelSelector } from '../components/ModelSelector';
import { createRun } from '../api';

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <form className="page newrun" onSubmit={submit}>
      <h1>Nova Run</h1>

      <label className="field">
        <span>Tema</span>
        <textarea
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          placeholder="Ex.: Atendimento de clinica de exames laboratoriais com FAQs e politicas de agendamento"
          rows={3}
        />
      </label>

      <div className="row2">
        <label className="field">
          <span>Etapas</span>
          <input
            type="number"
            min={1}
            max={50}
            value={stages}
            onChange={(e) => setStages(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Concorrência</span>
          <input
            type="number"
            min={1}
            max={32}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Timeout (ms)</span>
          <input
            type="number"
            min={1000}
            max={300000}
            step={1000}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Max output tokens</span>
          <input
            type="number"
            min={50}
            max={16000}
            step={50}
            value={maxOutputTokens}
            onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
          />
        </label>
      </div>

      <ModelSelector
        label="Competidores — 2 ou mais modelos"
        multi
        value={competitors}
        onChange={setCompetitors}
        excludeIds={[...datagen, ...judge]}
      />

      <ModelSelector
        label="Gerador de cenários — exatamente 1 modelo"
        multi={false}
        value={datagen}
        onChange={setDatagen}
        excludeIds={[...competitors, ...judge]}
      />

      <ModelSelector
        label="Juiz — exatamente 1 modelo"
        multi={false}
        value={judge}
        onChange={setJudge}
        excludeIds={[...competitors, ...datagen]}
      />

      <p className="muted small">
        Gerador e juiz usam <strong>um único modelo cada</strong>. Um mesmo modelo não pode
        ocupar dois papéis (competidor, gerador ou juiz).
      </p>

      {error && <div className="error-banner">{error}</div>}

      <button type="submit" disabled={submitting} className="primary">
        {submitting ? 'Iniciando…' : 'Iniciar benchmark'}
      </button>
    </form>
  );
}
