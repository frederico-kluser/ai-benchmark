// Servidor MCP por stdio, no MESMO binario (precedente: `npx -y prisma mcp`).
//
// Implementado a mao, sem SDK: o transporte stdio do MCP e JSON-RPC 2.0
// delimitado por linha, e `initialize` + `tools/list` + `tools/call` cabem em
// ~150 linhas. Puxar o SDK custaria dezenas de pacotes transitivos em TODA
// instalacao — inclusive de quem so quer o CLI — e o cold start rapido e
// metade da vantagem de um binario sobre um servidor MCP.
//
// A superficie e deliberadamente PEQUENA (6 ferramentas): o schema de cada uma
// entra no contexto do agente a cada turno, entao cada ferramenta a mais e um
// imposto permanente de tokens.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PKG_DOCS_DIR, PKG_ROOT } from '../../paths.js';
import { setDataDir, loadRun, loadSession } from '../../storage.js';
import { ensureCatalog } from '../../modelsCache.js';
import { toExportRow } from '../../modelCaps.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { parseArenaConfig } from '../../configFile.js';
import { arenaConfigToRunConfig } from '../../arenaConfig.js';
import { runToCompletion } from '../../orchestrator.js';
import { prepareOptsFor } from '../../prepareRun.js';
import { trainToCompletion } from '../../trainer.js';
import { resolveHome, resolveKey, parse } from '../context.js';
import { EXIT } from '../output.js';
import type { RunConfig } from '../../types.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'benchmark-arena', version: '0.1.0' };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, apiKey: string) => Promise<unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const numOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

async function toRunConfig(raw: unknown): Promise<RunConfig> {
  if (typeof (raw as Record<string, unknown>)?.format === 'string') {
    const p = parseArenaConfig(raw);
    if (!p.ok) throw new Error(p.error);
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new Error(c.error);
    return c.config;
  }
  const p = parseRunConfig(raw);
  if (!p.ok) throw new Error(p.error);
  return p.config;
}

const TOOLS: Tool[] = [
  {
    name: 'list_models',
    description:
      'Lista modelos do OpenRouter com preço e, principalmente, quais níveis de raciocínio ' +
      '(think levels) cada um aceita. Use ANTES de escolher um modelo ou um nível de esforço.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'filtra por parte do id ou do nome' },
        limit: { type: 'number', description: 'máximo de resultados (padrão 20)' },
      },
    },
    run: async (args, apiKey) => {
      const cat = await ensureCatalog(apiKey);
      const busca = str(args.search)?.toLowerCase();
      let rows = cat.models;
      if (busca) {
        rows = rows.filter(
          (m) => m.id.toLowerCase().includes(busca) || m.name.toLowerCase().includes(busca),
        );
      }
      return {
        count: rows.length,
        models: rows.slice(0, numOf(args.limit) ?? 20).map(toExportRow),
      };
    },
  },
  {
    name: 'estimate_cost',
    description:
      'Estima quanto uma configuração vai custar, SEM chamar nenhum modelo. ' +
      'Aceita arena-config@1 ou RunConfig. Rode isto antes de qualquer run cara.',
    inputSchema: {
      type: 'object',
      properties: { config: { type: 'object', description: 'a configuração da run' } },
      required: ['config'],
    },
    run: async (args, apiKey) => {
      const cfg = await toRunConfig(args.config);
      const cat = await ensureCatalog(apiKey);
      return estimateRunCost(estimateInputFromConfig(cfg), cat.models);
    },
  },
  {
    name: 'run_benchmark',
    description:
      'Roda um benchmark (compare ou vary) até o fim e devolve o resultado. ' +
      'budgetUsd é OBRIGATÓRIO — é o teto de gasto em dólares.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object' },
        budgetUsd: { type: 'number', description: 'teto de gasto em USD' },
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey) => {
      const base = await toRunConfig(args.config);
      const budgetUsd = numOf(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0) {
        throw new Error('budgetUsd é obrigatório e deve ser maior que zero.');
      }
      if (base.mode === 'training') {
        throw new Error('Use train_prompt para o modo training.');
      }
      await ensureCatalog(apiKey);
      const cfg: RunConfig = { ...base, budgetUsd };
      const rec = await runToCompletion(cfg, apiKey, prepareOptsFor(cfg, apiKey));
      return {
        runId: rec.id,
        status: rec.status,
        totalCostUsd: rec.totalCostUsd,
        costByRole: rec.costByRole,
        budgetExhausted: Boolean(rec.budgetExhausted),
        stoppedAtPhase: rec.stoppedAtPhase,
        standings: rec.standings,
        judgeScoreByContestant: rec.judgeScoreByContestant,
      };
    },
  },
  {
    name: 'train_prompt',
    description:
      'Treina um system prompt ao longo de iterações e devolve o prompt campeão, ' +
      'com holdout e significância. budgetUsd é OBRIGATÓRIO.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'configuração com mode "training"' },
        budgetUsd: { type: 'number' },
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey) => {
      const base = await toRunConfig(args.config);
      const budgetUsd = numOf(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0) {
        throw new Error('budgetUsd é obrigatório e deve ser maior que zero.');
      }
      if (base.mode !== 'training') throw new Error('config.mode precisa ser "training".');
      await ensureCatalog(apiKey);
      const rec = await trainToCompletion({ ...base, budgetUsd }, apiKey);
      const campeao = rec.bestPromptByIteration.at(-1);
      return {
        sessionId: rec.id,
        status: rec.status,
        totalCostUsd: rec.totalCostUsd,
        costByRole: rec.costByRole,
        iterationsDone: rec.bestPromptByIteration.length,
        championPrompt: campeao?.systemPrompt,
        holdout: rec.holdout,
        significance: rec.significance,
        // Sem o holdout o ganho NAO esta validado contra sobreajuste.
        holdoutSkipped: Boolean(rec.holdoutSkipped),
        budgetExhausted: Boolean(rec.budgetExhausted),
      };
    },
  },
  {
    name: 'get_result',
    description: 'Lê o resultado completo de uma run ou sessão já executada, pelo id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['run', 'session'] },
      },
      required: ['id'],
    },
    run: async (args) => {
      const id = str(args.id) ?? '';
      const kind = str(args.kind);
      if (kind === 'session') return (await loadSession(id)) ?? { error: 'sessão não encontrada' };
      return (await loadRun(id)) ?? (await loadSession(id)) ?? { error: 'não encontrado' };
    },
  },
  {
    name: 'read_docs',
    description:
      'Lê a documentação embarcada nesta versão do benchmark-arena. ' +
      'Sem "topic", devolve a lista de tópicos. Comece por "quickstart".',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
    },
    run: async (args) => {
      const topic = str(args.topic);
      if (!topic) {
        const raw = await fs.readFile(path.join(PKG_DOCS_DIR, 'index.json'), 'utf-8');
        return JSON.parse(raw);
      }
      const file =
        topic === 'config'
          ? path.join(PKG_ROOT, 'ARENA-CONFIG.md')
          : path.join(PKG_DOCS_DIR, `${topic}.md`);
      return { topic, content: await fs.readFile(file, 'utf-8') };
    },
  },
];

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

export async function cmdMcp(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  setDataDir(resolveHome(parsed.values));

  // A key e resolvida preguicosamente: `read_docs` funciona sem nenhuma key, e
  // um servidor MCP nao deve morrer no boot por causa disso.
  let apiKeyCache: string | null = null;
  const getKey = async (): Promise<string> => {
    if (apiKeyCache) return apiKeyCache;
    apiKeyCache = await resolveKey(parsed.values);
    return apiKeyCache;
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      replyError(null, -32700, 'JSON inválido');
      continue;
    }

    // Notificacoes (sem `id`) nao recebem resposta — responder quebra o cliente.
    const isNotification = req.id === undefined || req.id === null;

    try {
      switch (req.method) {
        case 'initialize': {
          const pedido = str((req.params as Record<string, unknown>)?.protocolVersion);
          reply(req.id, {
            // Ecoa a versao pedida quando conhecida; senao anuncia a nossa.
            protocolVersion: pedido ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
          break;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          break;
        case 'ping':
          if (!isNotification) reply(req.id, {});
          break;
        case 'tools/list':
          reply(req.id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
          break;
        case 'tools/call': {
          const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const tool = TOOLS.find((t) => t.name === params.name);
          if (!tool) {
            replyError(req.id, -32602, `Ferramenta desconhecida: ${params.name}`);
            break;
          }
          try {
            const key = tool.name === 'read_docs' || tool.name === 'get_result' ? '' : await getKey();
            const out = await tool.run(params.arguments ?? {}, key);
            reply(req.id, {
              content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            });
          } catch (err) {
            // Erro de ferramenta vai como resultado com isError, nao como erro
            // de protocolo: o agente precisa LER a mensagem para se corrigir.
            reply(req.id, {
              content: [{ type: 'text', text: (err as Error).message }],
              isError: true,
            });
          }
          break;
        }
        default:
          if (!isNotification) replyError(req.id, -32601, `Método não suportado: ${req.method}`);
      }
    } catch (err) {
      if (!isNotification) replyError(req.id, -32603, (err as Error).message);
    }
  }

  return EXIT.OK;
}
