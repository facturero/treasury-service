#!/usr/bin/env node
// Coteja `asyncapi.yaml` con los eventos que el código realmente publica y consume.
//
//     node scripts/check-asyncapi-events.mjs
//
// Falla (código 1) si:
//   - el código publica un evento que el contrato no documenta (o al revés: un canal `publish` que nadie publica),
//   - el código consume un evento (CONSUMED_BINDINGS) que el contrato no documenta como `subscribe` (o al revés),
//   - el contrato cita un `$ref` a un esquema que no existe, o un canal usa `properties: { $ref }`, que no es JSON Schema.
//
// Por qué existe: el contrato se escribe a mano y ya se desincronizó varias veces (un `schemas:` duplicado que impedía parsearlo,
// «no consume ninguno» cuando sí consumía, un `$ref` dentro de `properties`). La bitácora y quien consuma estos eventos se fían de él.
// Mismo espíritu que `check-openapi-routes.mjs`: sin dependencias nuevas, el YAML se lee por indentación (aquí es estable).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(join(ROOT, 'asyncapi.yaml'), 'utf8').split(/\r?\n/);
const problems = [];

// ---- Canales del contrato ----
const published = new Set();
const consumed = new Set();
{
  let inChannels = false;
  let channel = null;
  for (const line of yaml) {
    if (/^[A-Za-z]/.test(line)) {
      inChannels = line.startsWith('channels:');
      channel = null;
      continue;
    }
    if (!inChannels) continue;
    const mChannel = line.match(/^ {2}([A-Za-z0-9_.]+):\s*$/);
    if (mChannel) {
      channel = mChannel[1];
      continue;
    }
    const mOp = line.match(/^ {4}(publish|subscribe):/);
    if (mOp && channel) (mOp[1] === 'publish' ? published : consumed).add(channel);
  }
}

// ---- Eventos del código (fuera de las pruebas) ----
const codePublished = new Set();
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') walk(full);
    } else if (name.endsWith('.ts')) {
      const text = readFileSync(full, 'utf8');
      // Cualquier literal con forma de routing key propia: `treasury.<recurso>.<acción>`.
      for (const m of text.matchAll(/['"`](treasury\.[a-z_]+\.[a-z_]+)['"`]/g)) codePublished.add(m[1]);
    }
  }
}
walk(join(ROOT, 'src'));

const consumerSource = readFileSync(join(ROOT, 'src/infrastructure/messaging/consumer.ts'), 'utf8');
const bindingsBlock = consumerSource.match(/CONSUMED_BINDINGS\s*=\s*\[([\s\S]*?)\]/);
const codeConsumed = new Set(bindingsBlock ? [...bindingsBlock[1].matchAll(/['"`]([a-z0-9_.]+)['"`]/g)].map((m) => m[1]) : []);

for (const e of codePublished) if (!published.has(e)) problems.push(`el código publica «${e}» y asyncapi.yaml no lo documenta (publish)`);
for (const e of published) if (!codePublished.has(e)) problems.push(`asyncapi.yaml documenta «${e}» (publish) y ningún código lo publica`);
for (const e of codeConsumed) if (!consumed.has(e)) problems.push(`el código consume «${e}» y asyncapi.yaml no lo documenta (subscribe)`);
for (const e of consumed) if (!codeConsumed.has(e)) problems.push(`asyncapi.yaml documenta «${e}» (subscribe) y CONSUMED_BINDINGS no lo incluye`);

// ---- Referencias y forma del esquema ----
const text = yaml.join('\n');
const schemaNames = new Set();
{
  let inSchemas = false;
  for (const line of yaml) {
    if (/^ {2}schemas:\s*$/.test(line)) { inSchemas = true; continue; }
    if (/^ {2}[A-Za-z]/.test(line) && !/^ {2}schemas:/.test(line)) inSchemas = false;
    const m = line.match(/^ {4}([A-Za-z0-9_]+):\s*$/);
    if (inSchemas && m) schemaNames.add(m[1]);
  }
}
for (const m of text.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) {
  if (!schemaNames.has(m[1])) problems.push(`$ref a un esquema que no existe: components/schemas/${m[1]}`);
}
for (let i = 0; i < yaml.length - 1; i++) {
  if (/^\s*properties:\s*$/.test(yaml[i]) && /^\s*\$ref:/.test(yaml[i + 1])) {
    problems.push(`línea ${i + 2}: «$ref» dentro de «properties» no es JSON Schema válido (usa allOf)`);
  }
}
const schemasBlocks = yaml.filter((l) => /^ {2}schemas:\s*$/.test(l)).length;
if (schemasBlocks > 1) problems.push(`components tiene ${schemasBlocks} claves «schemas:» (el YAML no parsearía)`);

if (problems.length) {
  console.error('asyncapi.yaml NO coincide con el código:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`OK — asyncapi.yaml y el código coinciden (${published.size} eventos publicados, ${consumed.size} consumido${consumed.size === 1 ? '' : 's'}).`);
