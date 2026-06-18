import { readFileSync } from 'node:fs';
import path from 'node:path';

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

const JSON_PATH = path.resolve(process.cwd(), 'src', 'data', 'lgpd-compliance.json');

let cache: LgpdData | null = null;

export function getLgpdData(): LgpdData {
  if (!cache) {
    cache = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as LgpdData;
  }
  return cache;
}
