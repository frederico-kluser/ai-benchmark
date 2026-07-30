// Caminhos do PACOTE (nao do processo). O `tsc` nao copia .json para dist/, e o
// modulo pode rodar de tres lugares diferentes: `src/` sob tsx (dev), `dist/`
// sob node (self-host) e `node_modules/prompt-builder/dist/` (instalado).
//
// A resolucao abaixo funciona nos tres porque `src/paths.ts` e `dist/paths.js`
// estao ambos a UM nivel da raiz do pacote — entao `../` sempre cai na raiz e
// `src/data/` sempre existe (o package.json publica esse arquivo em `files`).
//
// NAO troque por `process.cwd()`: instalado como CLI, o cwd e o projeto do
// usuario, e a leitura da base LGPD falha com ENOENT.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do pacote — um nivel acima de src/ (dev) ou dist/ (build/instalado). */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Dados versionados que viajam no tarball (ver `files` do package.json). */
export const PKG_DATA_DIR = path.join(PKG_ROOT, 'src', 'data');

/** Markdown de onboarding lido pelo comando `docs`. */
export const PKG_DOCS_DIR = path.join(PKG_ROOT, 'agent-docs');

/** Skills instalaveis pelo comando `init`. */
export const PKG_SKILLS_DIR = path.join(PKG_ROOT, 'skills');

/**
 * Versao do pacote, lida do package.json em vez de chumbada no codigo.
 * Chumbar significava manter o mesmo numero em tres lugares (CLI, MCP e
 * package.json) — e eles ja tinham divergido no primeiro bump.
 */
export function pkgVersion(): string {
  try {
    const raw = readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
