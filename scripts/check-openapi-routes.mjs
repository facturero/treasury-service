#!/usr/bin/env node
// Coteja `openapi.yaml` con las rutas realmente montadas en `src/interface/http/routes.ts`.
//
//     node scripts/check-openapi-routes.mjs
//
// Falla (código 1) si:
//   - hay una ruta implementada que el contrato no documenta, o
//   - hay una ruta documentada que ningún router implementa.
//
// El contrato se escribe a mano; sin este cotejo ya se desincronizó una vez
// (faltaba el `PUT /purchasing/bills/{id}`). Mismo espíritu que
// `organization-service/scripts/check-openapi-refs.mjs`: una comprobación puntual,
// sin dependencias nuevas (se lee el YAML por indentación, que aquí es estable).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

// ---- Rutas documentadas (openapi.yaml) ----
const documented = new Set();
{
  const lines = readFileSync(join(ROOT, 'openapi.yaml'), 'utf8').split(/\r?\n/);
  let inPaths = false;
  let current = null;
  for (const line of lines) {
    if (/^[A-Za-z]/.test(line)) {
      inPaths = line.startsWith('paths:');
      current = null;
      continue;
    }
    if (!inPaths) continue;
    const mPath = line.match(/^ {2}(\/\S*):/);
    if (mPath) {
      current = mPath[1];
      continue;
    }
    const mMethod = line.match(/^ {4}([a-z]+):/);
    if (mMethod && current && METHODS.has(mMethod[1])) {
      documented.add(`${mMethod[1].toUpperCase()} ${current}`);
    }
  }
}

// ---- Rutas implementadas (routes.ts) ----
// Todas las registraciones `r.<método>('/ruta', …)` llevan la ruta en la misma línea.
const implemented = new Set();
{
  const text = readFileSync(join(ROOT, 'src', 'interface', 'http', 'routes.ts'), 'utf8');
  for (const m of text.matchAll(/r\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    implemented.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
}

// `:id` (Hono) y `{id}` (OpenAPI) son la misma ruta.
const canon = (entry) => entry.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const norm = (set) => new Set([...set].map(canon));

const docSet = norm(documented);
const impSet = norm(implemented);

const sinDocumentar = [...impSet].filter((e) => !docSet.has(e)).sort();
const sinImplementar = [...docSet].filter((e) => !impSet.has(e)).sort();

if (!sinDocumentar.length && !sinImplementar.length) {
  console.log(`OK — openapi.yaml y routes.ts coinciden (${impSet.size} rutas).`);
  process.exit(0);
}

if (sinDocumentar.length) {
  console.error('❌ Implementadas pero NO documentadas en openapi.yaml:');
  for (const e of sinDocumentar) console.error(`   ${e}`);
}
if (sinImplementar.length) {
  console.error('❌ Documentadas en openapi.yaml pero SIN implementar:');
  for (const e of sinImplementar) console.error(`   ${e}`);
}
process.exit(1);
