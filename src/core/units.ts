/**
 * Units and expressions.
 *
 * Precision rules (see docs/ARCHITECTURE.md, Precision):
 * - All internal geometry is millimeters in IEEE-754 doubles.
 * - Inches exist only at the input/display boundary. 1 in = 25.4 mm exactly.
 * - User input is stored as the original expression string, never as a
 *   rounded number, so re-saving a document cannot drift a value.
 */

export type LengthUnit = 'in' | 'mm';
export type AngleUnit = 'deg' | 'rad';

export const MM_PER: Record<LengthUnit, number> = { in: 25.4, mm: 1 };

const UNIT_ALIASES: Record<string, { kind: 'length' | 'angle'; factor: number }> = {
  mm: { kind: 'length', factor: 1 },
  cm: { kind: 'length', factor: 10 },
  m: { kind: 'length', factor: 1000 },
  in: { kind: 'length', factor: 25.4 },
  '"': { kind: 'length', factor: 25.4 },
  ft: { kind: 'length', factor: 304.8 },
  "'": { kind: 'length', factor: 304.8 },
  deg: { kind: 'angle', factor: Math.PI / 180 },
  '°': { kind: 'angle', factor: Math.PI / 180 },
  rad: { kind: 'angle', factor: 1 },
};

export class ExpressionError extends Error {}

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      // A fraction written directly before a unit, e.g. 1/4" or 3/8 in, is one quantity
      // (a quarter inch), not 1 divided by 4 inches.
      const frac = /^(\d+\.?\d*|\.\d+)\s*\/\s*(\d+\.?\d*|\.\d+)\s*(?=(?:in|mm|cm|ft|m|deg|rad)(?![A-Za-z_0-9])|["'°])/.exec(src.slice(i));
      if (frac) {
        const den = Number(frac[2]);
        if (den === 0) throw new ExpressionError('Division by zero');
        out.push({ t: 'num', v: Number(frac[1]) / den });
        i += frac[0].length;
        continue;
      }
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExpressionError(`Bad number at "${src.slice(i)}"`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('"\'°'.includes(ch)) { out.push({ t: 'id', v: ch }); i++; continue; }
    if ('+-*/()^'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new ExpressionError(`Unexpected character "${ch}"`);
  }
  return out;
}

const FUNCS: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs };
/** Trig functions take an angle only (never a bare number or a length) so a missing unit is an error, not a wrong shape. */
const TRIG: Record<string, (x: number) => number> = { sin: Math.sin, cos: Math.cos, tan: Math.tan };
/** Inverse trig takes a plain number and returns an angle. */
const INV_TRIG: Record<string, (x: number) => number> = { asin: Math.asin, acos: Math.acos, atan: Math.atan };
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI };

/** A value with a dimension: length in mm, angle in rad, or a plain number. */
interface Q {
  v: number; dim: 'length' | 'angle' | 'none';
  /** Set on a parameter typed without a unit (e.g. "20"): the plain number as typed, so `name deg` can reuse it. */
  bare?: number;
}

/**
 * Evaluate an expression like `2*wall + 0.125 in`, `1/4"`, `30 deg`.
 * Bare numbers take `defaultUnit` when the result must be a length/angle.
 * `params` are named variables already resolved to mm / rad / plain values.
 */
/**
 * Forgive harmless input slips that have exactly one meaning: Unicode minus and
 * multiplication signs, and an expression wrapped in quotes as a whole
 * (e.g. "\"W/2\"" sent as a quoted string). A leading quote mark is never a valid
 * expression, so this cannot change the meaning of anything that was valid.
 */
export function normalizeExpr(src: string): string {
  let s = src.trim().replace(/\u2212/g, '-').replace(/[\u00d7\u22c5]/g, '*');
  for (const q of ['"', "'"]) {
    if (s.length >= 2 && s.startsWith(q) && s.endsWith(q) && !s.slice(1, -1).includes(q)) s = s.slice(1, -1).trim();
  }
  return s;
}

export function evaluate(
  src: string,
  params: Record<string, Q> = {},
  defaultLengthMM = 1,
): Q {
  src = normalizeExpr(src);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const tk = toks[p];
    if (!tk || (v !== undefined && tk.v !== v)) throw new ExpressionError(`Expected "${v}" in "${src}"`);
    p++;
    return tk;
  };
  const combine = (a: Q, b: Q, op: string): Q => {
    switch (op) {
      case '+': case '-': {
        if (a.dim !== 'none' && b.dim !== 'none' && a.dim !== b.dim) throw new ExpressionError('Cannot add length and angle');
        // A bare number added to a length/angle takes the default unit (doc length unit, or degrees).
        const dim = a.dim !== 'none' ? a.dim : b.dim;
        const scale = (x: Q) => (x.dim !== 'none' || dim === 'none' ? x.v : x.v * (dim === 'length' ? defaultLengthMM : Math.PI / 180));
        const av = scale(a), bv = scale(b);
        return { v: op === '+' ? av + bv : av - bv, dim };
      }
      case '*': {
        if (a.dim !== 'none' && b.dim !== 'none') throw new ExpressionError('Multiplying two lengths or angles (an area) is not supported; multiply by a plain number instead');
        return { v: a.v * b.v, dim: a.dim !== 'none' ? a.dim : b.dim };
      }
      case '/': {
        if (b.v === 0) throw new ExpressionError('Division by zero');
        if (a.dim === b.dim) return { v: a.v / b.v, dim: 'none' };
        if (b.dim !== 'none') throw new ExpressionError('Cannot divide by a length/angle');
        return { v: a.v / b.v, dim: a.dim };
      }
      default: throw new ExpressionError(`Unknown op ${op}`);
    }
  };
  function primary(): Q {
    const tk = peek();
    if (!tk) throw new ExpressionError(`Unexpected end of "${src}"`);
    if (tk.t === 'op' && tk.v === '(') { eat('('); const q = expr(); eat(')'); return postfixUnit(q); }
    if (tk.t === 'op' && tk.v === '-') { eat('-'); const q = primary(); return { v: -q.v, dim: q.dim }; }
    if (tk.t === 'op' && tk.v === '+') { eat('+'); return primary(); }
    if (tk.t === 'num') { eat(); return postfixUnit({ v: tk.v, dim: 'none' }); }
    if (tk.t === 'id') {
      eat();
      if (TRIG[tk.v]) {
        eat('('); const q = expr(); eat(')');
        if (q.dim === 'angle') return postfixUnit({ v: TRIG[tk.v](q.v), dim: 'none' });
        throw new ExpressionError(q.bare !== undefined
          ? `${tk.v}() needs an angle, but this parameter was defined without a unit; write ${tk.v}(name deg) or define it as e.g. "${q.bare} deg"`
          : q.dim === 'length'
            ? `${tk.v}() needs an angle, not a length; write the unit, e.g. ${tk.v}(20 deg)`
            : `${tk.v}() needs an angle with a unit; write e.g. ${tk.v}(20 deg) (a bare number is ambiguous between degrees and radians)`);
      }
      if (INV_TRIG[tk.v]) {
        eat('('); const q = expr(); eat(')');
        if (q.dim !== 'none') throw new ExpressionError(`${tk.v}() needs a plain number`);
        return postfixUnit({ v: INV_TRIG[tk.v](q.v), dim: 'angle' });
      }
      if (FUNCS[tk.v]) { eat('('); const q = expr(); eat(')'); return postfixUnit({ v: FUNCS[tk.v](q.v), dim: 'none' }); }
      if (CONSTS[tk.v] !== undefined) return postfixUnit({ v: CONSTS[tk.v], dim: 'none' });
      if (params[tk.v]) {
        const pq = params[tk.v];
        if (pq.bare !== undefined && peek()?.t === 'id' && UNIT_ALIASES[peek()!.v as string]?.kind === 'angle') {
          return postfixUnit({ v: pq.bare, dim: 'none' }); // "lean deg" where lean was typed as plain 20
        }
        if (pq.dim !== 'none' && peek()?.t === 'id' && UNIT_ALIASES[peek()!.v as string]) {
          throw new ExpressionError(`"${tk.v}" already has a unit (${pq.dim}); write it without "${String(peek()!.v)}"`);
        }
        return pq.dim === 'none' ? postfixUnit(pq) : pq;
      }
      throw new ExpressionError(`Unknown name "${tk.v}"`);
    }
    throw new ExpressionError(`Unexpected "${tk.v}"`);
  }
  function postfixUnit(q: Q): Q {
    const tk = peek();
    if (tk && tk.t === 'id' && UNIT_ALIASES[tk.v]) {
      if (q.dim !== 'none') throw new ExpressionError(`Value already has a unit; remove "${String(tk.v)}"`);
      eat();
      const u = UNIT_ALIASES[tk.v];
      return { v: q.v * u.factor, dim: u.kind };
    }
    return q;
  }
  function power(): Q {
    const b = primary();
    if (peek()?.v === '^') {
      eat('^');
      const e = power();
      if (b.dim !== 'none' || e.dim !== 'none') throw new ExpressionError('Exponents only on plain numbers');
      return { v: Math.pow(b.v, e.v), dim: 'none' };
    }
    return b;
  }
  function term(): Q {
    let a = power();
    while (peek() && (peek()!.v === '*' || peek()!.v === '/')) {
      const op = eat().v as string;
      a = combine(a, power(), op);
    }
    return a;
  }
  function expr(): Q {
    let a = term();
    while (peek() && (peek()!.v === '+' || peek()!.v === '-') && peek()!.t === 'op') {
      const op = eat().v as string;
      a = combine(a, term(), op);
    }
    return a;
  }
  const q = expr();
  if (p !== toks.length) throw new ExpressionError(`Unexpected "${String(toks[p].v)}" in "${src}"`);
  if (!Number.isFinite(q.v)) throw new ExpressionError(`"${src}" is not a finite number`);
  return q;
}

/** Evaluate an expression that must be a length; returns mm. */
export function evalLength(src: string | number, defaultUnit: LengthUnit, params: Record<string, Q> = {}): number {
  if (typeof src === 'number') return src * MM_PER[defaultUnit];
  const q = evaluate(src, params, MM_PER[defaultUnit]);
  if (q.dim === 'angle') throw new ExpressionError(`"${src}" is an angle, expected a length`);
  return q.dim === 'length' ? q.v : q.v * MM_PER[defaultUnit];
}

/** Evaluate an expression that must be an angle; returns radians. Bare numbers are degrees. */
export function evalAngle(src: string | number, params: Record<string, Q> = {}): number {
  if (typeof src === 'number') return (src * Math.PI) / 180;
  const q = evaluate(src, params);
  if (q.dim === 'length') throw new ExpressionError(`"${src}" is a length, expected an angle`);
  return q.dim === 'angle' ? q.v : (q.v * Math.PI) / 180;
}

/** Format mm for display in the given unit with fixed decimals (default 4 for in, 3 for mm). */
export function formatLength(mm: number, unit: LengthUnit, decimals?: number): string {
  const d = decimals ?? (unit === 'in' ? 4 : 3);
  const v = mm / MM_PER[unit];
  const s = (Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v).toFixed(d);
  return `${s} ${unit}`;
}

export type { Q as Quantity };
