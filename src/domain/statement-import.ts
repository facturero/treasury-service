import { createHash } from 'node:crypto';
import { isLocalDate } from './dates.js';
import { ValidationError } from './errors.js';
import type { CsvDateFormat, ImportProfile } from './bank.js';
import { validateImportProfile } from './bank.js';

/**
 * Lector del extracto bancario en CSV. Puro: recibe el texto y el perfil, devuelve renglones y errores por fila.
 *
 * Reglas que no se negocian:
 *  - Todo o nada: si UNA fila tiene error no se importa nada (un extracto a medias deja una conciliación imposible de explicar).
 *  - Los importes se leen como TEXTO a centavos enteros, nunca con `parseFloat` (0.1 + 0.2 ≠ 0.3 no puede llegar a un saldo).
 *  - Las fechas son de calendario y nunca pasan por `Date`.
 *  - Lo anterior a la fecha de apertura de la cuenta no es un error: se omite y se cuenta.
 */

export const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 5000;

export interface ParsedLine {
  /** Número de fila en el archivo (desde 1), para explicar un error o una omisión. */
  row: number;
  lineDate: string;
  description: string;
  reference: string | null;
  amountCents: number;
  balanceCents: number | null;
  /** Huella con ocurrencia: dos renglones idénticos del MISMO archivo (dos comisiones iguales el mismo día) no son uno solo. */
  fingerprint: string;
}

export interface RowError {
  row: number;
  field: string;
  message: string;
}

export interface ParsedStatement {
  lines: ParsedLine[];
  errors: RowError[];
  /** Filas anteriores a la fecha de apertura de la cuenta. */
  skippedBeforeOpening: number;
  periodStart: string | null;
  periodEnd: string | null;
  closingBalanceCents: number | null;
  closingDate: string | null;
  /** Hash del contenido normalizado. */
  contentHash: string;
  /** Filas de datos leídas (con o sin error, sin las vacías). */
  rowCount: number;
}

/** Quita el BOM y unifica saltos de línea: dos copias del mismo archivo con distinto fin de línea tienen el mismo hash. */
export function normalizeCsvText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Parte el texto en filas de celdas respetando comillas (RFC 4180: `""` dentro de comillas es una comilla; los saltos de línea dentro de comillas se conservan). */
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Importe en texto → centavos enteros con signo, o `null` si no es un importe.
 * Acepta símbolo de moneda, espacios, miles, `(12,50)` y `12,50-` como negativos. Más de dos decimales NO se redondean: se rechaza.
 */
export function parseAmountToCents(raw: string, decimalSeparator: '.' | ','): number | null {
  let s = raw.trim();
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s$€]|USD/gi, '');
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  const thousands = decimalSeparator === '.' ? ',' : '.';
  // El separador de miles solo puede estar antes del decimal; se quita. Lo que quede debe ser dígitos con, a lo sumo, un decimal.
  s = s.split(thousands).join('');
  const parts = s.split(decimalSeparator);
  if (parts.length > 2) return null;
  const [intPart, fracPart = ''] = parts as [string, string?];
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (intPart === '' && fracPart === '') return null;
  if (fracPart.length > 2) return null;
  const cents = Number(intPart || '0') * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** `13/10/2026` con `DD/MM/YYYY` → `2026-10-13`; `null` si no cuadra con el formato o el día no existe. */
export function parseDate(raw: string, format: CsvDateFormat): string | null {
  const s = raw.trim();
  const sep = format.includes('/') ? '/' : '-';
  const parts = s.split(sep);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const order = format.split(sep);
  const get = (token: string) => parts[order.indexOf(token)]!;
  const y = get('YYYY');
  const m = get('MM');
  const d = get('DD');
  if (y.length !== 4 || m.length > 2 || d.length > 2) return null;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isLocalDate(iso) ? iso : null;
}

const norm = (s: string): string => s.normalize('NFKD').replace(/\s+/g, ' ').trim().toLowerCase();

/** Para comparar referencias entre el extracto y los cobros/pagos: sin espacios, ceros a la izquierda ni símbolos. */
export function normalizeReference(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
}

export function fingerprintOf(lineDate: string, amountCents: number, reference: string | null, description: string): string {
  return createHash('sha256').update([lineDate, amountCents, norm(reference ?? ''), norm(description)].join('|')).digest('hex');
}

/** Lee el CSV con el perfil. Lanza 422 si el perfil no es válido o el archivo es demasiado grande; los problemas de FILA vuelven en `errors`. */
export function parseStatement(csvText: string, profile: ImportProfile, options: { openingDate: string }): ParsedStatement {
  const profileErrors = validateImportProfile(profile);
  if (profileErrors.length) throw new ValidationError(profileErrors);
  if (Buffer.byteLength(csvText, 'utf8') > MAX_STATEMENT_BYTES) {
    throw new ValidationError([{ field: 'csv', message: `El archivo pasa de ${MAX_STATEMENT_BYTES / 1024 / 1024} MB: divídelo por periodos.` }]);
  }
  const text = normalizeCsvText(csvText);
  const contentHash = createHash('sha256').update(text.trim()).digest('hex');
  const rows = splitCsv(text, profile.delimiter);
  const errors: RowError[] = [];
  const lines: ParsedLine[] = [];
  const seen = new Map<string, number>();
  let skippedBeforeOpening = 0;
  let rowCount = 0;

  const data = rows.slice(profile.skipRows);
  if (data.length > MAX_STATEMENT_ROWS) {
    throw new ValidationError([{ field: 'csv', message: `El archivo tiene más de ${MAX_STATEMENT_ROWS} filas: divídelo por periodos.` }]);
  }
  data.forEach((cells, index) => {
    const row = profile.skipRows + index + 1;
    if (cells.every((c) => c.trim() === '')) return;
    rowCount++;
    const at = (column: number | null): string => (column === null ? '' : (cells[column - 1] ?? ''));
    const fail = (field: string, message: string) => errors.push({ row, field, message });

    const lineDate = parseDate(at(profile.dateColumn), profile.dateFormat);
    if (!lineDate) return void fail('date', `La fecha «${at(profile.dateColumn).trim()}» no es válida para el formato ${profile.dateFormat}.`);

    let amountCents: number | null;
    if (profile.amountMode === 'signed') {
      amountCents = parseAmountToCents(at(profile.amountColumn), profile.decimalSeparator);
      if (amountCents === null) return void fail('amount', `El importe «${at(profile.amountColumn).trim()}» no es válido (máximo dos decimales).`);
      if (profile.invertSign) amountCents = -amountCents;
    } else {
      const debit = at(profile.debitColumn).trim() === '' ? 0 : parseAmountToCents(at(profile.debitColumn), profile.decimalSeparator);
      const credit = at(profile.creditColumn).trim() === '' ? 0 : parseAmountToCents(at(profile.creditColumn), profile.decimalSeparator);
      if (debit === null) return void fail('debit', `El débito «${at(profile.debitColumn).trim()}» no es válido (máximo dos decimales).`);
      if (credit === null) return void fail('credit', `El crédito «${at(profile.creditColumn).trim()}» no es válido (máximo dos decimales).`);
      if (debit !== 0 && credit !== 0) return void fail('amount', 'La fila trae débito y crédito a la vez.');
      amountCents = Math.abs(credit) - Math.abs(debit);
    }
    if (amountCents === 0) return void fail('amount', 'El importe es cero: el renglón no mueve nada.');

    let balanceCents: number | null = null;
    if (profile.balanceColumn !== null && at(profile.balanceColumn).trim() !== '') {
      balanceCents = parseAmountToCents(at(profile.balanceColumn), profile.decimalSeparator);
      if (balanceCents === null) return void fail('balance', `El saldo «${at(profile.balanceColumn).trim()}» no es válido.`);
    }

    if (lineDate <= options.openingDate) {
      skippedBeforeOpening++;
      return;
    }

    const description = at(profile.descriptionColumn).trim().replace(/\s+/g, ' ').slice(0, 300);
    const reference = at(profile.referenceColumn).trim().slice(0, 80) || null;
    const base = fingerprintOf(lineDate, amountCents, reference, description);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    lines.push({ row, lineDate, description, reference, amountCents, balanceCents, fingerprint: `${base}:${occurrence}` });
  });

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let closingBalanceCents: number | null = null;
  let closingDate: string | null = null;
  if (lines.length) {
    periodStart = lines.reduce((a, l) => (l.lineDate < a ? l.lineDate : a), lines[0]!.lineDate);
    periodEnd = lines.reduce((a, l) => (l.lineDate > a ? l.lineDate : a), lines[0]!.lineDate);
    // El saldo de cierre es el del último renglón EN EL TIEMPO: si el archivo viene del más nuevo al más viejo es el primero.
    const withBalance = lines.filter((l) => l.balanceCents !== null);
    if (withBalance.length) {
      const descending = lines[0]!.lineDate > lines[lines.length - 1]!.lineDate;
      const last = descending ? withBalance[0]! : withBalance[withBalance.length - 1]!;
      closingBalanceCents = last.balanceCents;
      closingDate = last.lineDate;
    }
  }
  return { lines, errors, skippedBeforeOpening, periodStart, periodEnd, closingBalanceCents, closingDate, contentHash, rowCount };
}
