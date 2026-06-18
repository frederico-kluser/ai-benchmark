#!/usr/bin/env node
// Gera src/data/lgpd-allowlist.generated.json: um snapshot de referência do
// catálogo OpenRouter cruzado com a base de conformidade LGPD.
//
// Usa SOMENTE os endpoints PÚBLICOS do OpenRouter (/models e /endpoints/zdr) —
// NÃO precisa de API key. A regra de classificação espelha web/src/lgpd.ts.
//
// Uso:  node scripts/gen-lgpd-allowlist.mjs
//       OPENROUTER_BASE_URL=... node scripts/gen-lgpd-allowlist.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const ROOT = process.cwd();
const DATA = JSON.parse(readFileSync(path.join(ROOT, 'src/data/lgpd-compliance.json'), 'utf-8'));

// ---- classificação (espelha web/src/lgpd.ts) ----
const creatorPrefix = (id) => (id.split('/')[0] ?? '').replace(/^~/, '').toLowerCase();
const familiaFor = (id) =>
  DATA.familias.find((f) => f.prefixos.some((p) => p.toLowerCase() === creatorPrefix(id)));
const originFor = (id) => familiaFor(id)?.origem ?? DATA.creators_origem[creatorPrefix(id)] ?? 'Indefinido';

function statusFor(id, area) {
  const fam = familiaFor(id);
  if (fam) return fam.areas_permitidas[area] ?? 'permitido com ressalvas';
  const origem = DATA.creators_origem[creatorPrefix(id)];
  const restrita = origem === 'China' || origem === 'SG';
  const defaults = restrita
    ? DATA.heuristica_nao_classificados.defaults_restrita
    : DATA.heuristica_nao_classificados.defaults_ocidental;
  return defaults[area] ?? 'permitido com ressalvas';
}

const EU_PATTERNS = ['eu-west', 'swedencentral', 'europe', 'eu-central', 'eu-north'];
const isEuTag = (tag) => {
  const t = (tag ?? '').toLowerCase();
  return EU_PATTERNS.some((p) => t.includes(p)) || t.endsWith('/eu') || t === 'azure/eu';
};

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`[gen-lgpd] buscando catálogo público em ${BASE} …`);
  const [modelsResp, zdrResp] = await Promise.all([
    getJson(`${BASE}/models`),
    getJson(`${BASE}/endpoints/zdr`),
  ]);
  const models = Array.isArray(modelsResp.data) ? modelsResp.data : [];
  const zdr = Array.isArray(zdrResp.data) ? zdrResp.data : [];

  // model_id -> { providers:Set, eu:bool }
  const zdrByModel = new Map();
  for (const ep of zdr) {
    const e = zdrByModel.get(ep.model_id) ?? { providers: new Set(), eu: false };
    if (ep.provider_name) e.providers.add(ep.provider_name);
    if (isEuTag(ep.tag)) e.eu = true;
    zdrByModel.set(ep.model_id, e);
  }

  const areaIds = DATA.areas.map((a) => a.id);
  const porModelo = {};
  const resumo = Object.fromEntries(
    areaIds.map((a) => [a, { permitidos: 0, com_ressalvas: 0, bloqueados: 0 }]),
  );

  for (const m of models.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const id = m.id;
    const areas = {};
    for (const a of areaIds) {
      const s = statusFor(id, a);
      areas[a] = s;
      if (s === 'permitido') resumo[a].permitidos += 1;
      else if (s === 'permitido com ressalvas') resumo[a].com_ressalvas += 1;
      else resumo[a].bloqueados += 1;
    }
    const z = zdrByModel.get(id);
    porModelo[id] = {
      familia: familiaFor(id)?.id ?? null,
      origem: originFor(id),
      areas,
      zdr_providers: z ? [...z.providers].sort() : [],
      zdr_eu: z?.eu ?? false,
    };
  }

  const out = {
    gerado_em: new Date().toISOString().slice(0, 10),
    fonte: `${BASE}/models + ${BASE}/endpoints/zdr (públicos)`,
    base_conhecimento: DATA.data_referencia,
    aviso: DATA.aviso,
    total_modelos: models.length,
    total_modelos_com_zdr: zdrByModel.size,
    resumo_por_area: resumo,
    por_modelo: porModelo,
  };

  const target = path.join(ROOT, 'src/data/lgpd-allowlist.generated.json');
  writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`[gen-lgpd] ${models.length} modelos (${zdrByModel.size} com ZDR) → ${path.relative(ROOT, target)}`);
  for (const a of areaIds) {
    const r = resumo[a];
    console.log(`  ${a.padEnd(22)} permitidos=${r.permitidos}  ressalvas=${r.com_ressalvas}  bloqueados=${r.bloqueados}`);
  }
}

main().catch((err) => {
  console.error('[gen-lgpd] falhou:', err.message);
  process.exit(1);
});
