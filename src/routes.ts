import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listModels, validateKey } from './openrouter.js';
import { startRun } from './orchestrator.js';
import { startTraining } from './trainer.js';
import { generateContestants } from './variator.js';
import { listTechniques } from './techniques.js';
import { getLgpdData } from './lgpd.js';
import { listRuns, loadRun, listSessions, loadSession } from './storage.js';
import { subscribe, subscribeSession } from './events.js';
import type { CompetitorResponse, RunRecord } from './types.js';

const router = Router();

const baseFields = {
  theme: z.string().min(1),
  stages: z.number().int().min(1).max(50),
  datagenModelId: z.string().min(1),
  // Um ou mais juizes (rodam em paralelo). Aceita tambem o legado judgeModelId
  // (string) via preprocess do runConfigSchema.
  judgeModelIds: z.array(z.string().min(1)).min(1),
  concurrency: z.number().int().min(1).max(32).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  maxOutputTokens: z.number().int().min(50).max(16_000).optional(),
  promptOptimization: z.boolean().optional(),
  optimizerModelId: z.string().min(1).optional(),
  judgePasses: z.union([z.literal(1), z.literal(2)]).optional(),
  // Perfil de conformidade LGPD escolhido no assistente (CONSULTIVO: gravado
  // para transparência/rastreabilidade, não força roteamento). Ausente = "livre".
  compliance: z
    .object({ area: z.string().min(1), includeRessalvas: z.boolean() })
    .optional(),
  // Etapas fornecidas pelo usuario (JSON): pulam o datagen. Quando presentes,
  // `stages` e forcado ao tamanho desta lista (ver preprocess do runConfigSchema).
  customStages: z
    .array(
      z.object({
        question: z.string().min(1),
        productContext: z.string().min(1),
        rubric: z.string().optional(),
        // maxTokens omitido pelo usuario e preenchido no preprocess (herda maxOutputTokens).
        maxTokens: z.number().int().positive().max(16_000),
      }),
    )
    .min(1)
    .max(50)
    .optional(),
};

const manualVariantSchema = z.object({
  label: z.string().min(1),
  systemPrompt: z.string().min(1),
});

const singleModelFields = {
  contestantModelId: z.string().min(1),
  basePrompt: z.string().optional(),
  techniqueIds: z.array(z.string().min(1)).optional(),
  manualVariants: z.array(manualVariantSchema).optional(),
};

const compareObj = z.object({
  mode: z.literal('compare'),
  // >= 2 competidores, todos distintos
  competitorModelIds: z.array(z.string().min(1)).min(2),
  ...baseFields,
});
const variationObj = z.object({
  mode: z.literal('variation'),
  ...singleModelFields,
  ...baseFields,
});
const trainingObj = z.object({
  mode: z.literal('training'),
  ...singleModelFields,
  iterations: z.number().int().min(2).max(10),
  ...baseFields,
});

const runConfigSchema = z
  .preprocess(
    (val) => {
      if (!val || typeof val !== 'object') return val;
      const obj = { ...(val as Record<string, unknown>) };
      // compat: payloads antigos sem `mode` sao tratados como compare.
      if (obj.mode === undefined) obj.mode = 'compare';
      // compat: judgeModelId (string, legado) -> judgeModelIds (array).
      if (obj.judgeModelIds === undefined && typeof obj.judgeModelId === 'string') {
        obj.judgeModelIds = [obj.judgeModelId];
      }
      // Etapas manuais ditam a contagem: `stages` = nº de etapas fornecidas.
      // maxTokens ausente/invalido herda maxOutputTokens (ou 1000) — o competidor
      // faz Math.min(maxOutputTokens, stage.maxTokens) e undefined viraria NaN.
      if (Array.isArray(obj.customStages) && obj.customStages.length > 0) {
        obj.stages = obj.customStages.length;
        const fallback =
          typeof obj.maxOutputTokens === 'number' && obj.maxOutputTokens > 0
            ? obj.maxOutputTokens
            : 1000;
        obj.customStages = obj.customStages.map((s) => {
          if (s && typeof s === 'object') {
            const mt = (s as Record<string, unknown>).maxTokens;
            if (typeof mt !== 'number' || mt <= 0) {
              return { ...(s as Record<string, unknown>), maxTokens: fallback };
            }
          }
          return s;
        });
      }
      return obj;
    },
    z.discriminatedUnion('mode', [compareObj, variationObj, trainingObj]),
  )
  .superRefine((cfg, ctx) => {
    // Gerador e juiz PODEM repetir o mesmo modelo (repeticao permitida).
    if (cfg.mode === 'compare') {
      const dup = cfg.competitorModelIds.find(
        (id, i) => cfg.competitorModelIds.indexOf(id) !== i,
      );
      if (dup) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitorModelIds'],
          message: `Competidor repetido: "${dup}". Cada competidor deve ser unico.`,
        });
      }
      if (cfg.competitorModelIds.includes(cfg.datagenModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['datagenModelId'],
          message: 'O gerador de cenarios nao pode ser tambem um competidor.',
        });
      }
      const judgeAsCompetitor = cfg.judgeModelIds.find((id) =>
        cfg.competitorModelIds.includes(id),
      );
      if (judgeAsCompetitor) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgeModelIds'],
          message: `O juiz "${judgeAsCompetitor}" nao pode ser tambem um competidor.`,
        });
      }
    } else {
      // variation | training: anti vies de auto-preferencia do juiz
      if (cfg.judgeModelIds.includes(cfg.contestantModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgeModelIds'],
          message: 'Nenhum juiz pode ser o mesmo modelo sob teste (vies de auto-preferencia).',
        });
      }
      const optimize = cfg.promptOptimization !== false;
      const baseCount = cfg.basePrompt && cfg.basePrompt.trim() ? 1 : 0;
      if (optimize) {
        const techCount = cfg.techniqueIds?.length ?? 0;
        if (techCount + baseCount < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['techniqueIds'],
            message:
              'Selecione ao menos 2 tecnicas (ou 1 tecnica + prompt base) para ter contestants suficientes.',
          });
        }
      } else {
        const manualCount = (cfg.manualVariants ?? []).filter((v) => v.systemPrompt.trim()).length;
        if (manualCount + baseCount < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['manualVariants'],
            message:
              'Com otimizacao desligada, forneca ao menos 2 variantes (ou 1 variante + prompt base).',
          });
        }
      }
    }
  });

const HEADER_NAME = 'x-openrouter-key';

function extractKey(req: Request): string | null {
  const headerVal = req.headers[HEADER_NAME];
  if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  return null;
}

function requireKey(req: Request, res: Response, next: NextFunction) {
  const key = extractKey(req);
  if (!key) {
    res.status(401).json({ error: 'OpenRouter key ausente. Envie no header x-openrouter-key.' });
    return;
  }
  (req as Request & { apiKey: string }).apiKey = key;
  next();
}

router.post('/validate-key', async (req, res) => {
  const key = extractKey(req) ?? (req.body?.apiKey as string | undefined);
  if (!key) {
    res.status(400).json({ ok: false, error: 'Key ausente.' });
    return;
  }
  const result = await validateKey(key);
  res.status(result.ok ? 200 : 401).json(result);
});

router.get('/models', requireKey, async (req, res) => {
  try {
    const models = await listModels((req as Request & { apiKey: string }).apiKey);
    res.json({ data: models });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/runs', requireKey, async (req, res) => {
  const parsed = runConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Config invalida', details: parsed.error.flatten() });
    return;
  }
  const apiKey = (req as Request & { apiKey: string }).apiKey;

  // Pre-flight: valida a key ANTES de iniciar a run, pra falhar rapido com
  // mensagem clara em vez de quebrar la na etapa 1 do datagen.
  const keyCheck = await validateKey(apiKey);
  if (!keyCheck.ok) {
    res.status(401).json({ error: `Key OpenRouter invalida: ${keyCheck.error}` });
    return;
  }

  try {
    const cfg = parsed.data;

    if (cfg.mode === 'training') {
      res.status(400).json({ error: 'Modo treino usa POST /v1/benchmark/sessions.' });
      return;
    }

    if (cfg.mode === 'variation') {
      const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
      const promptOptimization = cfg.promptOptimization !== false;
      const { runId } = startRun(cfg, apiKey, {
        prepare: () =>
          generateContestants({
            apiKey,
            modelId: cfg.contestantModelId,
            theme: cfg.theme,
            basePrompt: cfg.basePrompt,
            originalPrompt: cfg.basePrompt,
            includeOriginal: Boolean(cfg.basePrompt && cfg.basePrompt.trim()),
            techniqueIds: cfg.techniqueIds,
            manualVariants: cfg.manualVariants,
            promptOptimization,
            optimizerModelId,
            timeoutMs: cfg.timeoutMs,
          }),
      });
      res.status(202).json({ runId });
      return;
    }

    // compare
    const { runId } = startRun(cfg, apiKey);
    res.status(202).json({ runId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Biblioteca curada de tecnicas de variacao (sem o meta-prompt). Nao exige key.
router.get('/techniques', (_req, res) => {
  res.json({ data: listTechniques() });
});

// Base de conhecimento LGPD (familias, areas, origem de providers/criadores)
// que alimenta o filtro consultivo de proposito/area. Publica, nao exige key.
router.get('/lgpd', (_req, res) => {
  res.json({ data: getLgpdData() });
});

router.get('/runs', async (_req, res) => {
  try {
    const data = await listRuns();
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const record = await loadRun(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Run nao encontrada' });
      return;
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// SSE: nao exige key (a key so e necessaria para INICIAR a run, nao para acompanhar)
router.get('/runs/:id/events', async (req, res) => {
  const runId = req.params.id;
  const record = await loadRun(runId);
  if (!record) {
    res.status(404).json({ error: 'Run nao encontrada' });
    return;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'snapshot', record });

  const isTerminal =
    record.status === 'finished' || record.status === 'error' || record.status === 'aborted';
  if (isTerminal) {
    // evento terminal correto: 'error' vira run.error (UI mostra o motivo),
    // o resto vira run.finished. Em ambos o cliente fecha o EventSource.
    if (record.status === 'error') {
      send({ type: 'run.error', runId, error: record.error ?? 'Run terminou com erro.' });
    } else {
      send({ type: 'run.finished', runId, record });
    }
    res.end();
    return;
  }

  const unsubscribe = subscribe(runId, (event) => {
    send(event);
    if (event.type === 'run.finished' || event.type === 'run.error') {
      unsubscribe();
      res.end();
    }
  });

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

function csvEscape(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/runs/:id/export.csv', async (req, res) => {
  const record = await loadRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Run nao encontrada' });
    return;
  }
  const byId = new Map(record.contestants.map((c) => [c.id, c]));
  const rows: string[] = [];
  rows.push(
    [
      'runId',
      'sessionId',
      'iteration',
      'stageIndex',
      'question',
      'contestantId',
      'label',
      'technique',
      'modelId',
      'status',
      'latencyMs',
      'tokensIn',
      'tokensOut',
      'costUsd',
      'rankPosition',
      'errorMsg',
      'text',
    ]
      .map(csvEscape)
      .join(','),
  );
  for (const stage of record.stages) {
    const ranking = stage.judge?.rankedContestantIds ?? [];
    for (const r of stage.responses) {
      const rankPosition = ranking.indexOf(r.contestantId);
      const c = byId.get(r.contestantId);
      rows.push(
        [
          record.id,
          record.sessionId ?? '',
          record.iteration ?? '',
          stage.index,
          stage.spec?.question ?? '',
          r.contestantId,
          c?.label ?? '',
          c?.techniqueId ?? '',
          r.modelId,
          r.status,
          r.latencyMs,
          r.tokensIn,
          r.tokensOut,
          r.costUsd,
          rankPosition >= 0 ? rankPosition + 1 : '',
          r.errorMsg ?? '',
          r.text,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="run-${record.id}.csv"`,
  });
  res.send(rows.join('\n'));
});

// ---------------------------------------------------------------------------
// Sessoes de treino (modo training = N iteracoes encadeadas)
// ---------------------------------------------------------------------------

router.post('/sessions', requireKey, async (req, res) => {
  const parsed = runConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Config invalida', details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.mode !== 'training') {
    res.status(400).json({ error: 'POST /sessions exige mode "training".' });
    return;
  }
  const apiKey = (req as Request & { apiKey: string }).apiKey;

  const keyCheck = await validateKey(apiKey);
  if (!keyCheck.ok) {
    res.status(401).json({ error: `Key OpenRouter invalida: ${keyCheck.error}` });
    return;
  }

  try {
    const { sessionId } = await startTraining(parsed.data, apiKey);
    res.status(202).json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/sessions', async (_req, res) => {
  try {
    res.json({ data: await listSessions() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const record = await loadSession(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Sessao nao encontrada' });
      return;
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/sessions/:id/events', async (req, res) => {
  const sessionId = req.params.id;
  const record = await loadSession(sessionId);
  if (!record) {
    res.status(404).json({ error: 'Sessao nao encontrada' });
    return;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'snapshot', record });

  const isTerminal =
    record.status === 'finished' || record.status === 'error' || record.status === 'aborted';
  if (isTerminal) {
    if (record.status === 'error') {
      send({ type: 'session.error', sessionId, error: record.error ?? 'Sessao terminou com erro.' });
    } else {
      send({ type: 'session.finished', sessionId, record });
    }
    res.end();
    return;
  }

  const unsubscribe = subscribeSession(sessionId, (event) => {
    send(event);
    if (event.type === 'session.finished' || event.type === 'session.error') {
      unsubscribe();
      res.end();
    }
  });

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

export type { RunRecord, CompetitorResponse };

export default router;
