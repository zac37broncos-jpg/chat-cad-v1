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
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'id'; v: string; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number };

/** A unit word or mark that may follow a number directly (a fraction or mixed number before one is one quantity). */
const UNIT_AHEAD = String.raw`(?=(?:in|mm|cm|ft|m|deg|rad)(?![A-Za-z_0-9])|["'°])`;
const FRACTION_BEFORE_UNIT = new RegExp(String.raw`^(\d+\.?\d*|\.\d+)\s*\/\s*(\d+\.?\d*|\.\d+)\s*` + UNIT_AHEAD);
/**
 * Mixed numbers as drawings write them: whole number, then a hyphen or spaces,
 * then a fraction, directly before a unit: 1-1/2", 1 1/2 in, 2-3/8". All three
 * parts are whole numbers and the fraction is proper (1/2, 3/8; not 3/2).
 */
const MIXED_BEFORE_UNIT = new RegExp(String.raw`^(\d+)(-|[ \t]+)(\d+)\/(\d+)\s*` + UNIT_AHEAD);
/** The same hyphen form with no unit after it, e.g. "1-1/2": 1.5 or 0.5? Refused (see tokenize). */
const MIXED_BARE = /^(\d+)-(\d+)\/(\d+)(?![0-9.eE])/;

/**
 * Split an expression into tokens.
 *
 * Mixed numbers (docs/UNITS_AND_FRACTIONS.md): "1-1/2\"" with no spaces is one
 * and a half inches, the way drawings, machinists and professional CAD's own fraction
 * display write it. Subtraction is written with spaces: "1 - 1/2\"" is half an
 * inch. Forms that could mean either are refused with a message, never guessed:
 * "1-1/2" with no unit, and a mixed number right after *, / or ^ (is "2*1-1/2\""
 * 2 x 1.5 in or 2 - 0.5 in?).
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const prevOp = () => { const t = out[out.length - 1]; return t && t.t === 'op' ? t.v : undefined; };
  const bindsTighter = () => { const o = prevOp(); return o === '*' || o === '/' || o === '^'; };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const rest = src.slice(i);
      const mixed = MIXED_BEFORE_UNIT.exec(rest);
      if (mixed) {
        const whole = Number(mixed[1]), num = Number(mixed[3]), den = Number(mixed[4]);
        const text = rest.slice(0, mixed[0].length).trim();
        const unit = /^(?:in|mm|cm|ft|m|deg|rad|["'°])/.exec(rest.slice(mixed[0].length))![0];
        const sp = unit.length > 1 ? ' ' : '';
        if (mixed[2] === '-' && bindsTighter()) {
          const o = prevOp();
          throw new ExpressionError(`"${text}${sp}${unit}" right after "${o}" is ambiguous: for the mixed number put it in parentheses, ${o}(${text}${sp}${unit}); for subtraction put spaces around the minus sign, ${mixed[1]} - ${mixed[3]}/${mixed[4]}${sp}${unit}`);
        }
        if (!(den > 0 && num >= 1 && num < den)) {
          throw new ExpressionError(`"${text}${sp}${unit}" is not a mixed number (its fraction must be less than 1, as in 1-1/2")${mixed[2] === '-' ? `. For subtraction put spaces around the minus sign: ${mixed[1]} - ${mixed[3]}/${mixed[4]}${sp}${unit}` : ''}`);
        }
        // One correctly rounded division: 1-1/3" is exactly the double nearest 4/3.
        out.push({ t: 'num', v: (whole * den + num) / den, s: i, e: i + text.length });
        i += mixed[0].length;
        continue;
      }
      // A fraction written directly before a unit, e.g. 1/4" or 3/8 in, is one quantity
      // (a quarter inch), not 1 divided by 4 inches.
      const frac = FRACTION_BEFORE_UNIT.exec(rest);
      if (frac) {
        const den = Number(frac[2]);
        if (den === 0) throw new ExpressionError('Division by zero');
        out.push({ t: 'num', v: Number(frac[1]) / den, s: i, e: i + frac[0].trimEnd().length });
        i += frac[0].length;
        continue;
      }
      const bare = MIXED_BARE.exec(rest);
      if (bare && !bindsTighter()) {
        const after = rest.slice(bare[0].length).trimStart()[0];
        if (after === undefined || after === '+' || after === '-' || after === ')') {
          const [, a, b, c] = bare;
          throw new ExpressionError(`"${bare[0]}" is ambiguous: for a mixed number add the unit (${a}-${b}/${c}" or ${a}-${b}/${c} mm), or write ${a} + ${b}/${c}; for subtraction put spaces around the minus sign (${a} - ${b}/${c})`);
        }
      }
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
      if (!m) throw new ExpressionError(`Bad number at "${rest}"`);
      out.push({ t: 'num', v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if ('"\'°'.includes(ch)) { out.push({ t: 'id', v: ch, s: i, e: i + 1 }); i++; continue; }
    if ('+-*/()^'.includes(ch)) { out.push({ t: 'op', v: ch, s: i, e: i + 1 }); i++; continue; }
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
  /** Called for every plain-number part that took the default length unit (tokens [start, end) of the normalized text). */
  onDefaultLength?: (span: [number, number], v: number) => void,
): Q {
  src = normalizeExpr(src);
  return evaluateTokens(src, tokenize(src), params, defaultLengthMM, onDefaultLength);
}

function evaluateTokens(
  src: string,
  toks: Token[],
  params: Record<string, Q>,
  defaultLengthMM: number,
  onDefaultLength?: (span: [number, number], v: number) => void,
): Q {
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const tk = toks[p];
    if (!tk || (v !== undefined && tk.v !== v)) throw new ExpressionError(`Expected "${v}" in "${src}"`);
    p++;
    return tk;
  };
  const combine = (a: Q, b: Q, op: string, spans?: [[number, number], [number, number]]): Q => {
    switch (op) {
      case '+': case '-': {
        if (a.dim !== 'none' && b.dim !== 'none' && a.dim !== b.dim) throw new ExpressionError('Cannot add length and angle');
        // A bare number added to a length/angle takes the default unit (doc length unit, or degrees).
        const dim = a.dim !== 'none' ? a.dim : b.dim;
        const scale = (x: Q) => (x.dim !== 'none' || dim === 'none' ? x.v : x.v * (dim === 'length' ? defaultLengthMM : Math.PI / 180));
        if (dim === 'length' && onDefaultLength && spans) {
          if (a.dim === 'none') onDefaultLength(spans[0], a.v);
          if (b.dim === 'none') onDefaultLength(spans[1], b.v);
        }
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
    const s0 = p;
    let a = term();
    while (peek() && (peek()!.v === '+' || peek()!.v === '-') && peek()!.t === 'op') {
      const aEnd = p;
      const op = eat().v as string;
      const s1 = p;
      const b = term();
      a = combine(a, b, op, [[s0, aEnd], [s1, p]]);
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

// ------------------------------------------------------------------ changing document units

/**
 * Rewrite `src` so it means exactly the same size whatever the document unit
 * is. Every plain-number part that took the document unit `from` gets that
 * unit written out: "3.1417" -> "3.1417 in", "W + 5" -> "W + 5 in",
 * "(0) + (2.5)" -> "((0) + (2.5)) in". Used when the units menu or set_units
 * changes the document unit, so the part keeps its physical size, as in
 * professional CAD (see docs/UNITS_AND_FRACTIONS.md).
 *
 * `context` is how the field is read: 'length' (a plain result is in document
 * units, evalLength) or 'number' (a count: only plain numbers added to a
 * length inside it depend on the unit). Angle fields never depend on the
 * document unit and are not passed here.
 *
 * Returns `src` itself when nothing depends on the unit. The rewrite is
 * checked: it must give bit-for-bit the same value in inches and in mm, or
 * this throws instead of changing the size of anything.
 */
export function pinDocumentUnit(src: string, from: LengthUnit, params: Record<string, Q>, context: 'length' | 'number'): string {
  const norm = normalizeExpr(src);
  const toks = tokenize(norm);
  const spans: [number, number][] = [];
  const read = (text: string, t: Token[], k: number, hook?: (sp: [number, number], v: number) => void) => {
    const q = evaluateTokens(text, t, params, k, hook);
    if (context === 'number') return q.v;
    if (q.dim === 'angle') throw new ExpressionError(`"${src}" is an angle, expected a length`);
    return q.dim === 'length' ? q.v : q.v * k;
  };
  // 0 is 0 in any unit, so a plain 0 is left as it is.
  const before = read(norm, toks, MM_PER[from], (sp, v) => { if (v !== 0) spans.push(sp); });
  const top = evaluateTokens(norm, toks, params, MM_PER[from]);
  if (context === 'length' && top.dim === 'none' && top.v !== 0) spans.push([0, toks.length]);
  if (!spans.length) return src;

  const match = (open: number): number => {
    let depth = 0;
    for (let k = open; k < toks.length; k++) {
      if (toks[k].t !== 'op') continue;
      if (toks[k].v === '(') depth++;
      else if (toks[k].v === ')' && --depth === 0) return k;
    }
    return -1;
  };
  const isParen = (k: number, v: string) => toks[k]?.t === 'op' && toks[k].v === v;
  const isNumber = (a: number, b: number) =>
    (b - a === 1 && toks[a].t === 'num') ||
    (b - a === 2 && toks[a].t === 'op' && (toks[a].v === '-' || toks[a].v === '+') && toks[a + 1].t === 'num');
  // Insertions: [position, text, order]. At one position, closing text of inner spans goes first, opening text of outer spans first.
  const ins: { at: number; text: string; order: number }[] = [];
  for (const [i, j] of spans) {
    let a = i, b = j;
    while (isParen(a, '(') && isParen(b - 1, ')') && match(a) === b - 1) { a++; b--; }
    if (isNumber(a, b)) ins.push({ at: toks[b - 1].e, text: ` ${from}`, order: -a });
    else if (a !== i) ins.push({ at: toks[j - 1].e, text: ` ${from}`, order: -i });
    else {
      ins.push({ at: toks[i].s, text: '(', order: -1e9 - (j - i) });
      ins.push({ at: toks[j - 1].e, text: `) ${from}`, order: -i });
    }
  }
  ins.sort((x, y) => x.at - y.at || x.order - y.order);
  let out = '', pos = 0;
  for (const x of ins) { out += norm.slice(pos, x.at) + x.text; pos = x.at; }
  out += norm.slice(pos);

  for (const u of ['in', 'mm'] as LengthUnit[]) {
    const after = read(out, tokenize(out), MM_PER[u]);
    if (after !== before) throw new Error(`Internal error: could not keep "${src}" the same size when changing units (got "${out}")`);
  }
  return out;
}

/** Names an expression refers to, and whether each use is written "name deg" / "name rad" (a unitless parameter used as an angle). */
export function nameUses(src: string): { name: string; asAngle: boolean }[] {
  const toks = tokenize(normalizeExpr(src));
  const out: { name: string; asAngle: boolean }[] = [];
  toks.forEach((t, k) => {
    if (t.t !== 'id' || UNIT_ALIASES[t.v] || FUNCS[t.v] || TRIG[t.v] || INV_TRIG[t.v] || CONSTS[t.v] !== undefined) return;
    const next = toks[k + 1];
    out.push({ name: t.v, asAngle: !!next && next.t === 'id' && UNIT_ALIASES[next.v]?.kind === 'angle' });
  });
  return out;
}

/** Format mm for display in the given unit with fixed decimals (default 4 for in, 3 for mm). */
export function formatLength(mm: number, unit: LengthUnit, decimals?: number): string {
  const d = decimals ?? (unit === 'in' ? 4 : 3);
  const v = mm / MM_PER[unit];
  const s = (Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v).toFixed(d);
  return `${s} ${unit}`;
}

export type { Q as Quantity };
