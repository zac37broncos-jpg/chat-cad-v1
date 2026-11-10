/**
 * Text metrics for the drawing font. Drawings use Helvetica (PDF base-14
 * font; Arial on screen has identical advance widths), so text measured
 * here lines up the same on screen, in PDF and in SVG.
 *
 * Drafting "text height" means CAP height. Helvetica's cap height is 718/1000
 * of the em, so font size = height / 0.718.
 */

export const CAP_HEIGHT = 0.718;

/** Helvetica advance widths (1/1000 em), Adobe AFM, for WinAnsi characters used on drawings. */
const W: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
  '±': 584, '°': 400, 'Ø': 778, '×': 584, '²': 333, '³': 333, 'µ': 556, '·': 278, '–': 556, '—': 1000,
};

/** Width (mm) of a single line of text at cap height h (mm). */
export function textWidth(s: string, h: number): number {
  let u = 0;
  for (const ch of s) u += W[ch] ?? 556;
  return (u / 1000) * (h / CAP_HEIGHT);
}

export const fontSize = (h: number) => h / CAP_HEIGHT;
