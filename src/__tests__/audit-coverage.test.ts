import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardia de la bitácora de auditoría. La bitácora no se entera de lo que un servicio NO publica: cada acción que escribe
 * en la base sin dejar un evento queda invisible y nadie lo nota. Esta prueba mira el código fuente: un archivo de
 * `application/` que escribe a través de un repositorio o de la unidad de trabajo tiene que mencionar el outbox.
 *
 * Es una revisión por heurística, no una prueba de comportamiento: no sustituye a los tests de cada caso de uso
 * (`events.test.ts` comprueba el contenido de cada evento).
 */
const EXENTOS: Record<string, string> = {
  // Ayudantes de cobros, pagos y ajustes: escriben el movimiento en la transacción de quien los llama, y ESE publica el evento del cobro,
  // pago o ajuste (y el de «emparejamiento deshecho», que el ayudante le devuelve para que lo publique).
  'bank-register': 'ayudante: el caso de uso que lo llama publica el evento en la misma transacción',
};

const ESCRITURA_APLICACION = /\b(?:uow|repos)(?:\.\w+)*\.(?:save|create|delete|remove|destroy|upsert|bulkCreate|update|add)\(/;
const ESCRITURA_DIRECTA = /\b\w+Model\.(?:create|update|destroy|bulkCreate|upsert)\(/;
// Solo cuenta el CÓDIGO (sin comentarios ni imports): una palabra en un comentario no publica nada.
const MENCIONA_AUDITORIA = /outbox|recordAuditEvent|\baudit\??\.record\(/i;

function leerCodigo(ruta: string): string {
  return readFileSync(ruta, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*import .*$/gm, '');
}

function archivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    return e.isDirectory() ? archivos(ruta) : [ruta];
  });
}

const fuentes = (carpeta: string) =>
  archivos(join(process.cwd(), 'src', carpeta)).filter((f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f));

const nombre = (ruta: string) => (ruta.split(/[\\/]/).pop() ?? ruta).replace(/\.ts$/, '');

function escribenSinEvento(): string[] {
  return fuentes('application')
    .filter((f) => {
      const texto = leerCodigo(f);
      return ESCRITURA_APLICACION.test(texto) && !MENCIONA_AUDITORIA.test(texto);
    })
    .map(nombre);
}

describe('toda acción que escribe deja huella en la bitácora', () => {
  it('los casos de uso que escriben publican un evento (o están exentos con motivo)', () => {
    const sinEvento = escribenSinEvento().filter((n) => !(n in EXENTOS));
    expect(sinEvento, 'escriben en la base sin publicar al outbox: ' + sinEvento.join(', ')).toEqual([]);
  });

  it('los controladores no escriben directo en la base sin registrar el evento', () => {
    const sinEvento = fuentes('interface')
      .filter((f) => {
        const texto = leerCodigo(f);
        return ESCRITURA_DIRECTA.test(texto) && !MENCIONA_AUDITORIA.test(texto);
      })
      .map(nombre);
    expect(sinEvento, 'escriben directo en un modelo sin evento: ' + sinEvento.join(', ')).toEqual([]);
  });

  it('cada exención sigue haciendo falta (si el archivo ya publica o ya no existe, quítala)', () => {
    const vigentes = new Set(escribenSinEvento());
    const sobran = Object.keys(EXENTOS).filter((n) => !vigentes.has(n));
    expect(sobran, 'exenciones que ya no hacen falta: ' + sobran.join(', ')).toEqual([]);
  });
});

describe('el evento y el cambio van en la misma transacción', () => {
  it('ningún caso de uso publica al outbox con repositorios de lectura: lo hace con la unidad de trabajo de su transacción', () => {
    // `this.reads.outbox.add(...)` o `this.repos.outbox.add(...)` se ejecutaría en otra transacción que el cambio: un fallo
    // entre ambos pierde el evento. Los casos de uso de escritura publican con `uow.outbox.add(...)` dentro de `inTransaction`.
    const sueltos = fuentes('application')
      .filter((f) => /\bthis\.\w+\.outbox\.add\(/.test(leerCodigo(f)))
      .map(nombre);
    expect(sueltos, 'publican fuera de la unidad de trabajo: ' + sueltos.join(', ')).toEqual([]);
  });

  it('los casos de uso de escritura usan `inTransaction`', () => {
    const sinTransaccion = fuentes('application')
      .filter((f) => /\buow\.outbox\.add\(/.test(leerCodigo(f)) && !/\binTransaction\(/.test(leerCodigo(f)))
      .map(nombre);
    expect(sinTransaccion, 'publican sin transacción: ' + sinTransaccion.join(', ')).toEqual([]);
  });
});
