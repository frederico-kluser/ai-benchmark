import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listModels, validateKey } from './openrouter.js';
import { startRun } from './orchestrator.js';
import { listRuns, loadRun } from './storage.js';
import { subscribe } from './events.js';
import type { CompetitorResponse, RunRecord } from './types.js';

const router = Router();

const runConfigSchema = z
  .object({
    theme: z.string().min(1),
    stages: z.number().int().min(1).max(50),
    // >= 2 competidores, todos distintos
    competitorModelIds: z.array(z.string().min(1)).min(2),
    // exatamente UM gerador de cenarios
    datagenModelId: z.string().min(1),
    // exatamente UM juiz — nada mais
    judgeModelId: z.string().min(1),
    concurrency: z.number().int().min(1).max(32).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    maxOutputTokens: z.number().int().min(50).max(16_000).optional(),
  })
  .superRefine((cfg, ctx) => {
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
    if (cfg.datagenModelId === cfg.judgeModelId) {
      ctx.addIssue({
        code: 'custom',
        path: ['judgeModelId'],
        message: 'O juiz e o gerador de cenarios devem ser modelos diferentes.',
      });
    }
    if (cfg.competitorModelIds.includes(cfg.datagenModelId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['datagenModelId'],
        message: 'O gerador de cenarios nao pode ser tambem um competidor.',
      });
    }
    if (cfg.competitorModelIds.includes(cfg.judgeModelId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['judgeModelId'],
        message: 'O juiz nao pode ser tambem um competidor.',
      });
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
    const { runId } = startRun(parsed.data, apiKey);
    res.status(202).json({ runId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
  const rows: string[] = [];
  rows.push(
    [
      'runId',
      'stageIndex',
      'question',
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
    const ranking = stage.judge?.rankedModelIds ?? [];
    for (const r of stage.responses) {
      const rankPosition = ranking.indexOf(r.modelId);
      rows.push(
        [
          record.id,
          stage.index,
          stage.spec?.question ?? '',
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

export type { RunRecord, CompetitorResponse };

export default router;
