import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PKG_DATA_DIR } from './paths.js';

/**
 * Base de conhecimento de conformidade LGPD (derivada do relatório técnico de
 * 2026-06-17). Serve a UI consultiva do filtro de propósito/área em Nova Run.
 *
 * É CONSULTIVA: orienta a escolha por família de modelo, mas NÃO força o
 * roteamento de providers no OpenRouter. NÃO é aconselhamento jurídico.
 *
 * O JSON fica em `src/data/` (fonte de verdade versionada) e é lido via cwd,
 * mesma convenção de `storage.ts` — funciona no dev (tsx) e no prod (node dist),
 * já que `tsc` não copia .json para `dist/`.
 */

export type AreaStatus = 'permitido' | 'permitido com ressalvas' | 'não recomendado';

export interface LgpdArea {
  id: string;
  label: string;
  descricao: string;
}

export interface LgpdFamilia {
  id: string;
  nome: string;
  prefixos: string[];
  provedor_modelo: string;
  origem: string;
  pais_adequacao_lgpd: string;
  certificacoes: string[];
  observacoes: string;
  areas_permitidas: Record<string, AreaStatus>;
  areas_notas?: Record<string, string>;
}

export interface LgpdData {
  data_referencia: string;
  aviso: string;
  principio_central: string;
  status_adequacao_anpd: Record<string, string>;
  configuracao_openrouter_recomendada: Record<string, string>;
  statuses: AreaStatus[];
  areas: LgpdArea[];
  familias: LgpdFamilia[];
  heuristica_nao_classificados: {
    descricao: string;
    defaults_restrita: Record<string, AreaStatus>;
    defaults_ocidental: Record<string, AreaStatus>;
  };
  creators_origem: Record<string, string>;
  providers: Record<string, { origem: string; zdr: boolean; treina: boolean }>;
  regioes_ue_tags: string[];
}

// Resolvido pela raiz do PACOTE, nao pelo cwd: instalado via npm o cwd e o
// projeto do usuario e a leitura falharia com ENOENT. Ver src/paths.ts.
const JSON_PATH = path.join(PKG_DATA_DIR, 'lgpd-compliance.json');

let cache: LgpdData | null = null;

export function getLgpdData(): LgpdData {
  if (!cache) {
    cache = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as LgpdData;
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Classificacao e filtragem por area. Portado de `web/src/lgpd.ts` — o CLI
// precisa filtrar o catalogo sem passar pelo navegador. Mantenha os dois
// espelhos em sincronia.
// ---------------------------------------------------------------------------

export const AREA_LIVRE = 'livre';

/** Prefixo do criador no id OpenRouter: trecho antes de "/", sem o "~" de variantes. */
export function creatorPrefix(modelId: string): string {
  const head = modelId.split('/')[0] ?? '';
  return head.replace(/^~/, '').toLowerCase();
}

/** Família do relatório que cobre este modelo (por prefixo), se houver. */
export function familiaFor(modelId: string, data: LgpdData): LgpdFamilia | undefined {
  const prefix = creatorPrefix(modelId);
  return data.familias.find((f) => f.prefixos.some((p) => p.toLowerCase() === prefix));
}

/** Origem (rótulo p/ badge): da família, ou do mapa creators_origem, ou "Indefinido". */
export function originFor(modelId: string, data: LgpdData): string {
  const fam = familiaFor(modelId, data);
  if (fam) return fam.origem;
  return data.creators_origem[creatorPrefix(modelId)] ?? 'Indefinido';
}

/**
 * Status de uma área para um modelo:
 *  1) família do relatório → usa areas_permitidas;
 *  2) senão, heurística por origem do criador: China/SG → defaults_restrita;
 *     demais (ocidental/indefinido) → defaults_ocidental.
 */
export function statusFor(modelId: string, area: string, data: LgpdData): AreaStatus {
  if (area === AREA_LIVRE) return 'permitido';

  const fam = familiaFor(modelId, data);
  if (fam) return fam.areas_permitidas[area] ?? 'permitido com ressalvas';

  const origem = data.creators_origem[creatorPrefix(modelId)];
  const restrita = origem === 'China' || origem === 'SG';
  const defaults = restrita
    ? data.heuristica_nao_classificados.defaults_restrita
    : data.heuristica_nao_classificados.defaults_ocidental;
  return defaults[area] ?? 'permitido com ressalvas';
}

/** Um status passa no filtro? "não recomendado" nunca passa; ressalvas só com a flag. */
export function statusAllowed(status: AreaStatus, includeRessalvas: boolean): boolean {
  if (status === 'permitido') return true;
  if (status === 'permitido com ressalvas') return includeRessalvas;
  return false;
}

export interface ModelPermission {
  status: AreaStatus;
  nota?: string;
  origem: string;
  familiaId?: string;
}

/** Permissão detalhada de um modelo numa área (p/ badges/tooltips). */
export function permissionOf(modelId: string, area: string, data: LgpdData): ModelPermission {
  const fam = familiaFor(modelId, data);
  return {
    status: statusFor(modelId, area, data),
    nota: fam?.areas_notas?.[area],
    origem: originFor(modelId, data),
    familiaId: fam?.id,
  };
}

/** Particiona um catálogo em permitidos/bloqueados para (área, rigor). */
export function filterModels<T extends { id: string }>(
  models: T[],
  area: string,
  includeRessalvas: boolean,
  data: LgpdData,
): { allowed: T[]; blockedIds: Set<string> } {
  if (area === AREA_LIVRE) return { allowed: models, blockedIds: new Set() };

  const allowed: T[] = [];
  const blockedIds = new Set<string>();
  for (const m of models) {
    if (statusAllowed(statusFor(m.id, area, data), includeRessalvas)) allowed.push(m);
    else blockedIds.add(m.id);
  }
  return { allowed, blockedIds };
}

/** Um id específico está permitido para (área, rigor)? Útil p/ podar seleções. */
export function isAllowed(
  modelId: string,
  area: string,
  includeRessalvas: boolean,
  data: LgpdData,
): boolean {
  return statusAllowed(statusFor(modelId, area, data), includeRessalvas);
}
