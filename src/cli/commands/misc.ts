// Comandos menores: `key`, `estimate`, `runs`, `sessions`, `techniques`,
// `lgpd`, `config`, `doctor`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listRuns, loadRun, listSessions, loadSession, getDataDir } from '../../storage.js';
import { listTechniques } from '../../techniques.js';
import { getLgpdData } from '../../lgpd.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { parseArenaConfig, arenaConfigSummary } from '../../configFile.js';
import { arenaConfigToRunConfig } from '../../arenaConfig.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { buildContext, buildNetworkContext, checkKey, keyFilePath, parse, removeStoredKey, writeStoredKey } from '../context.js';
import { CliError, EXIT, fmtUsd, renderSpend } from '../output.js';

// --- key ---------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export async function cmdKey(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, { stdin: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'path') {
    out.line(keyFilePath());
    out.result(true, 'key.path', { path: keyFilePath() });
    return EXIT.OK;
  }

  if (sub === 'rm') {
    await removeStoredKey();
    out.info('key removida.');
    out.result(true, 'key.rm', {});
    return EXIT.OK;
  }

  if (sub === 'set') {
    // Exigir --stdin fora de um terminal e uma protecao real: uma key em argv
    // entra no historico do shell E na transcricao do proprio agente.
    if (parsed.values.stdin !== true) {
      throw new CliError(
        'Use `benchmark-arena key set --stdin` e mande a key pela entrada padrão — ' +
          'passar a key como argumento a deixaria no histórico do shell.',
        EXIT.USAGE,
      );
    }
    const key = await readStdin();
    if (!key) throw new CliError('Nada recebido na entrada padrão.', EXIT.USAGE);
    const info = await checkKey(key);
    const file = await writeStoredKey(key);
    out.info(`key válida, gravada em ${file}`);
    out.result(true, 'key.set', { path: file, ...info });
    return EXIT.OK;
  }

  // check
  const net = await buildNetworkContext(parsed);
  const info = await checkKey(net.apiKey);
  if (out.isText) {
    out.line(`key válida${info.label ? ` (${info.label})` : ''}`);
    if (typeof info.usageUsd === 'number') out.line(`  uso        ${fmtUsd(info.usageUsd)}`);
    if (info.limitUsd != null) out.line(`  limite     ${fmtUsd(info.limitUsd)}`);
    if (info.limitRemainingUsd != null) out.line(`  disponível ${fmtUsd(info.limitRemainingUsd)}`);
    if (info.isFreeTier) out.line('  tier       gratuito (limites de rate dominam o custo)');
    out.line(`  catálogo   ${net.models.length} modelos (${net.catalogSource})`);
  }
  out.result(true, 'key.check', { ...info, models: net.models.length });
  return EXIT.OK;
}

// --- estimate ----------------------------------------------------------------

export async function cmdEstimate(argv: string[]): Promise<number> {
  const parsed = parse(argv, { config: { type: 'string', short: 'c' } });
  const ctx = await buildNetworkContext(parsed);
  const { out } = ctx;
  const file = parsed.values.config;
  if (typeof file !== 'string') {
    throw new CliError('Uso: benchmark-arena estimate --config <arquivo.json>', EXIT.USAGE);
  }

  const json = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
  const formato = (json as Record<string, unknown>)?.format;
  let config;
  if (typeof formato === 'string') {
    const p = parseArenaConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new CliError(c.error, EXIT.CONFIG);
    config = c.config;
  } else {
    const p = parseRunConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG, p.details);
    config = p.config;
  }

  const est = estimateRunCost(estimateInputFromConfig(config), ctx.models);
  if (out.isText) {
    out.line(`Estimativa: ${fmtUsd(est.low)} – ${fmtUsd(est.high)}`);
    out.line();
    out.line('Por papel (no teto):');
    for (const [role, usd] of Object.entries(est.byRole).sort((a, b) => b[1] - a[1])) {
      if (usd > 0) out.line(`  ${role.padEnd(12)} ${fmtUsd(usd)}`);
    }
    out.line();
    out.line('Premissas:');
    for (const [k, v] of Object.entries(est.assumptions)) out.line(`  ${k.padEnd(18)} ${v}`);
    if (est.unpricedModelIds.length) {
      out.warn(`sem preço no catálogo: ${est.unpricedModelIds.join(', ')}`);
    }
  }
  out.result(true, 'estimate', { estimate: est });
  return EXIT.OK;
}

// --- runs / sessions ---------------------------------------------------------

export async function cmdRuns(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    limit: { type: 'string' },
    status: { type: 'string' },
    'prompt-only': { type: 'boolean' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'list') {
    let rows = await listRuns();
    if (typeof parsed.values.status === 'string') {
      rows = rows.filter((r) => r.status === parsed.values.status);
    }
    const limit = Number(parsed.values.limit ?? 20);
    rows = rows.slice(0, Number.isFinite(limit) ? limit : 20);
    if (out.isText) {
      for (const r of rows) {
        out.line(
          `${r.id}  ${r.status.padEnd(8)} ${r.mode.padEnd(9)} ${fmtUsd(r.totalCostUsd).padStart(9)}  ${r.theme.slice(0, 48)}`,
        );
      }
      if (rows.length === 0) out.info('nenhuma run em ' + getDataDir());
    }
    out.result(true, 'runs.list', { runs: rows });
    return EXIT.OK;
  }

  const id = parsed.positionals[0];
  if (!id) throw new CliError(`Uso: benchmark-arena runs ${sub} <id>`, EXIT.USAGE);
  const record = await loadRun(id);
  if (!record) throw new CliError(`Run "${id}" não encontrada em ${getDataDir()}.`, EXIT.USAGE);

  if (sub === 'winner') {
    const ranking = record.standings?.length
      ? record.standings.map((s) => s.id)
      : Object.entries(record.judgeScoreByContestant ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([cid]) => cid);
    const vencedorId = ranking[0];
    const vencedor = record.contestants.find((c) => c.id === vencedorId);
    if (parsed.values['prompt-only'] === true) {
      // Payload puro no stdout: e o movimento final do fluxo
      // (`… winner <id> --prompt-only > prompt.md`).
      out.raw(vencedor?.systemPrompt ?? '');
      return EXIT.OK;
    }
    if (out.isText) {
      out.line(`vencedor: ${vencedor?.label ?? vencedorId ?? '—'}`);
      out.line(`régua: ${record.standings?.length ? 'duelos das finais' : 'judge-score'}`);
      if (vencedor?.systemPrompt) {
        out.line();
        out.line(vencedor.systemPrompt);
      }
    }
    out.result(true, 'runs.winner', {
      contestantId: vencedorId,
      label: vencedor?.label,
      systemPrompt: vencedor?.systemPrompt,
      ruler: record.standings?.length ? 'duels' : 'judge-score',
    });
    return EXIT.OK;
  }

  // show
  if (out.isText) {
    out.line(`${record.id}  ${record.status}  ${record.mode}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`etapas: ${record.stages.length} · participantes: ${record.contestants.length}`);
    out.line();
    for (const l of renderSpend(
      record.costByRole,
      record.totalCostUsd,
      record.budgetUsd,
      record.costAccuracy,
    )) {
      out.line(l);
    }
  }
  out.result(true, 'runs.show', { run: record });
  return EXIT.OK;
}

export async function cmdSessions(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    'prompt-only': { type: 'boolean' },
    limit: { type: 'string' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'list') {
    const rows = (await listSessions()).slice(0, Number(parsed.values.limit ?? 20));
    if (out.isText) {
      for (const r of rows) {
        out.line(
          `${r.id}  ${r.status.padEnd(8)} ${String(r.iterationsDone).padStart(2)}/${r.iterationsPlanned} it  ${fmtUsd(r.totalCostUsd).padStart(9)}  ${r.theme.slice(0, 40)}`,
        );
      }
    }
    out.result(true, 'sessions.list', { sessions: rows });
    return EXIT.OK;
  }

  const id = parsed.positionals[0];
  if (!id) throw new CliError(`Uso: benchmark-arena sessions ${sub} <id>`, EXIT.USAGE);
  const record = await loadSession(id);
  if (!record) throw new CliError(`Sessão "${id}" não encontrada.`, EXIT.USAGE);
  const campeao = record.bestPromptByIteration.at(-1);

  if (sub === 'winner') {
    if (parsed.values['prompt-only'] === true) {
      out.raw(campeao?.systemPrompt ?? '');
      return EXIT.OK;
    }
    if (out.isText && campeao) {
      out.line(`campeão da iteração ${campeao.iteration + 1}: ${campeao.winnerContestantId}`);
      if (record.holdoutSkipped) {
        out.warn('campeão NÃO validado em holdout — pode estar sobreajustado.');
      }
      out.line();
      out.line(campeao.systemPrompt);
    }
    out.result(true, 'sessions.winner', {
      systemPrompt: campeao?.systemPrompt,
      iteration: campeao?.iteration,
      holdoutSkipped: Boolean(record.holdoutSkipped),
      holdout: record.holdout,
      significance: record.significance,
    });
    return EXIT.OK;
  }

  if (out.isText) {
    out.line(`${record.id}  ${record.status}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`iterações: ${record.bestPromptByIteration.length}/${record.config.iterations}`);
    out.line();
    for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd)) out.line(l);
  }
  out.result(true, 'sessions.show', { session: record });
  return EXIT.OK;
}

// --- techniques / lgpd / config / doctor -------------------------------------

export async function cmdTechniques(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const techs = listTechniques();
  if (ctx.out.isText) {
    for (const t of techs) ctx.out.line(`${t.id.padEnd(16)} ${t.name} — ${t.good}`);
  }
  ctx.out.result(true, 'techniques', { techniques: techs });
  return EXIT.OK;
}

export async function cmdLgpd(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const data = getLgpdData();
  if (ctx.out.isText) {
    for (const a of data.areas) ctx.out.line(`${a.id.padEnd(24)} ${a.label}`);
    ctx.out.info('Filtro CONSULTIVO: orienta a escolha, não muda o roteamento no OpenRouter.');
  }
  ctx.out.result(true, 'lgpd.areas', { areas: data.areas });
  return EXIT.OK;
}

export async function cmdConfig(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'validate';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    mode: { type: 'string' },
    out: { type: 'string', short: 'o' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'example') {
    const mode = typeof parsed.values.mode === 'string' ? parsed.values.mode : 'train';
    const exemplo = {
      format: 'arena-config@1',
      mode: mode === 'train' ? 'training' : mode,
      theme: 'Assistente de suporte técnico de um SaaS de faturamento',
      scenarioBrief: 'Cubra dúvidas de cobrança, recusa de pedidos fora da política e extração de dados de faturas.',
      stages: 8,
      prompt: { text: 'Você é um assistente de suporte. Responda com base na política do produto.' },
      models: {
        datagen: 'openai/gpt-5-mini',
        judges: ['anthropic/claude-sonnet-5'],
        contestant: 'openai/gpt-5-mini',
      },
      effort: { judge: 'high', datagen: 'low' },
      variation: { optimize: true, techniques: ['persona', 'constraints', 'format'] },
      training: { iterations: 3, minGain: 1, holdoutRatio: 0.2 },
      finalists: 3,
      limits: { maxOutputTokens: 600 },
    };
    const texto = JSON.stringify(exemplo, null, 2);
    if (typeof parsed.values.out === 'string') {
      await fs.writeFile(parsed.values.out, `${texto}\n`, 'utf-8');
      out.info(`exemplo gravado em ${parsed.values.out}`);
    } else {
      out.raw(`${texto}\n`);
    }
    return EXIT.OK;
  }

  const file = parsed.positionals[0];
  if (!file) throw new CliError('Uso: benchmark-arena config validate <arquivo.json>', EXIT.USAGE);
  const json = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
  const formato = (json as Record<string, unknown>)?.format;

  if (typeof formato === 'string') {
    const p = parseArenaConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new CliError(c.error, EXIT.CONFIG);
    out.info(`válido — ${arenaConfigSummary(p.config)}`);
    out.result(true, 'config.validate', { format: formato, config: c.config });
    return EXIT.OK;
  }
  const p = parseRunConfig(json);
  if (!p.ok) throw new CliError(p.error, EXIT.CONFIG, p.details);
  out.info('válido (RunConfig)');
  out.result(true, 'config.validate', { format: 'run-config', config: p.config });
  return EXIT.OK;
}

export async function cmdDoctor(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const checks: Record<string, unknown> = {
    node: process.version,
    dataDir: getDataDir(),
  };

  try {
    await fs.mkdir(path.join(getDataDir(), 'cache'), { recursive: true });
    checks.dataDirWritable = true;
  } catch (err) {
    checks.dataDirWritable = false;
    checks.dataDirError = (err as Error).message;
  }

  try {
    const net = await buildNetworkContext(parsed);
    const info = await checkKey(net.apiKey);
    checks.key = 'ok';
    checks.models = net.models.length;
    checks.catalogSource = net.catalogSource;
    checks.creditRemaining = info.limitRemainingUsd ?? null;
  } catch (err) {
    checks.key = `falhou: ${(err as Error).message}`;
  }

  if (out.isText) {
    for (const [k, v] of Object.entries(checks)) out.line(`${k.padEnd(18)} ${String(v)}`);
  }
  out.result(true, 'doctor', checks);
  return EXIT.OK;
}
