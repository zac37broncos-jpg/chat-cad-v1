/**
 * Dimension text formatting per ASME Y14.5-2018 §1.6 / §2 and ISO 129-1.
 *
 * Decimal inch (ASME): no zero before the decimal point for values < 1
 * (".250"), and the dimension carries as many decimals as its tolerance
 * (trailing zeros added). Unilateral inch tolerances show the zero with the
 * same decimals and a sign ("+.000").
 * Millimetres: zero before the decimal point ("0.5"), no trailing zeros on
 * the basic value ("32", "32.5"); a unilateral zero is a single "0";
 * bilateral tolerance values share a decimal count ("+0.25 / -0.10").
 */
import type { Tolerance } from './model';

export interface DimText {
  /** Main line, e.g. "2X Ø.250" or "1.500". */
  main: string;
  /** Stacked tolerance (bilateral) or limits; drawn to the right of `main` (or alone for limits). */
  stack?: [string, string];
  /** Limit dimension: only the stack is shown. */
  limitsOnly?: boolean;
  /** Basic dimension: boxed. */
  boxed?: boolean;
  /** Suffix after the tolerance (e.g. " THRU"). */
  after?: string;
}

const MM_PER_IN = 25.4;

/** Round half away from zero at `dec` decimals, robust to binary representation (0.1 + 0.2 issues). */
export function roundTo(v: number, dec: number): number {
  const f = 10 ** dec;
  const x = Math.abs(v) * f;
  const r = Math.round(x + 1e-9 * Math.max(1, x));
  return (Math.sign(v) * r) / f;
}

/** Format a value already in drawing units. */
export function formatNumber(v: number, dec: number, units: 'in' | 'mm', opts: { trailingZeros?: boolean; leadingZero?: boolean } = {}): string {
  const r = roundTo(v, dec);
  let s = Math.abs(r).toFixed(dec);
  const trailing = opts.trailingZeros ?? units === 'in';
  if (!trailing && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  const leading = opts.leadingZero ?? units === 'mm';
  if (!leading && s.startsWith('0.')) s = s.slice(1);
  if (s === '' || s === '.') s = '0';
  return (r < 0 ? '-' : '') + s;
}

/** mm → drawing units. */
export const toUnits = (mm: number, units: 'in' | 'mm') => (units === 'in' ? mm / MM_PER_IN : mm);

function tolValue(v: number, dec: number, units: 'in' | 'mm', sign: '+' | '-'): string {
  if (roundTo(v, dec) === 0) return units === 'in' ? `${sign}${formatNumber(0, dec, 'in')}` : '0';
  return sign + formatNumber(v, dec, units, { trailingZeros: true, leadingZero: units === 'mm' });
}

/** Decimal places needed to show a tolerance value exactly (min `dec`). */
function tolDecimals(values: number[], dec: number, units: 'in' | 'mm'): number {
  if (units === 'in') return dec;
  let d = 0;
  for (const v of values) for (let k = 0; k <= 6; k++) if (Math.abs(roundTo(v, k) - v) < 1e-12) { d = Math.max(d, k); break; }
  return Math.max(d, 1);
}

/**
 * Build the text for a dimension. `value` is in drawing units. `lead` is a
 * prefix such as "Ø" / "R" / "2X Ø". Angles pass units 'mm' semantics with
 * the degree sign appended by the caller via `unitSuffix`.
 */
export function dimensionText(value: number, dec: number, units: 'in' | 'mm', tol: Tolerance, lead = '', unitSuffix = '', after = ''): DimText {
  const isAngle = unitSuffix === '°';
  const fmt = (v: number) => (isAngle ? formatNumber(v, dec, 'mm', { trailingZeros: dec > 0, leadingZero: true }) : formatNumber(v, dec, units)) + unitSuffix;
  const plus = tol.plus ?? 0, minus = tol.minus ?? 0;
  const tu: 'in' | 'mm' = isAngle ? 'mm' : units;
  const td = tolDecimals([plus, minus], dec, tu);
  const tfmt = (v: number, s: '+' | '-') => tolValue(v, td, tu, s) + (isAngle && roundTo(v, td) !== 0 ? '°' : '');
  const base = `${lead}${fmt(value)}`;
  switch (tol.type) {
    case 'none': return { main: base, after };
    case 'symmetric': return { main: `${base} ±${tfmt(plus, '+').slice(1)}`, after };
    case 'bilateral':
      if (roundTo(plus, td) === roundTo(minus, td) && plus !== 0) return { main: `${base} ±${tfmt(plus, '+').slice(1)}`, after };
      return { main: base, stack: [tfmt(plus, '+'), tfmt(minus, '-')], after };
    case 'limit': return { main: lead, stack: [fmt(value + plus), fmt(value - minus)], limitsOnly: true, after };
    case 'basic': return { main: base, boxed: true, after };
    case 'reference': return { main: `(${base})`, after };
    case 'min': return { main: `${base} MIN`, after };
    case 'max': return { main: `${base} MAX`, after };
  }
}

/** Plain one-line string of a DimText (for lists, tests and DXF fallbacks). */
export function dimTextString(t: DimText): string {
  const stack = t.stack ? (t.limitsOnly ? `${t.stack[0]}/${t.stack[1]}` : ` ${t.stack[0]}/${t.stack[1]}`) : '';
  return (t.limitsOnly ? t.main + stack : t.main + stack) + (t.after ?? '');
}
