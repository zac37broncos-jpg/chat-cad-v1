/**
 * Hole data: clearance holes, counterbores, countersinks and tap
 * drills for standard inch and metric fasteners. Pure data + lookups (no
 * kernel), shared by the kernel, the UI and the AI tools.
 *
 * Sources (values typed in, not computed):
 * - Inch socket head cap screws, close / normal fit drills, counterbore
 *   diameter and depth: ASME B18.3 "Drill and counterbore sizes for socket
 *   head cap screws" as printed in Machinery's Handbook (29th/30th ed.),
 *   cross-checked against engineersedge.com and amesweb.info.
 * - Inch 82 deg flat socket head diameter (theoretical sharp, max) for the
 *   countersink: ASME B18.3 Table 2A (fasten.it).
 * - Inch tap drills for 75% thread (UNC/UNF): standard drill and tap chart
 *   (UPenn MEAM labs chart and Machinery's Handbook).
 * - Metric clearance holes: ISO 273 fine / medium / coarse.
 * - Metric counterbores for ISO 4762 socket head cap screws: DIN 974-1
 *   (M3-M10 cross-checked against a DIN 373 counterbore set, M12 against a
 *   catalogue M12 counterbore of 20 mm).
 * - Metric 90 deg countersunk head diameter (theoretical, max): ISO 10642.
 * - Metric tap drill = nominal diameter minus pitch (ISO 2306 / common practice).
 *
 * Counterbore depth defaults to the screw's head height (= nominal diameter
 * for socket head cap screws), which seats the head flush, as in the
 * Machinery's Handbook table.
 *
 * All inch values are inches, metric values are millimetres.
 */
import type { HoleStandard, HoleType, HoleFit } from './featureTypes';

interface InchScrew { size: string; d: number; close: number; normal: number; cbore: number; cboreDepth: number; csk: number }

// size, body dia, close fit, normal fit, counterbore dia, counterbore depth, 82 deg csk head dia
const INCH_SCREWS: InchScrew[] = ([
  ['#0', 0.060, 0.067, 0.073, 0.125, 0.060, 0.138],
  ['#1', 0.073, 0.081, 0.089, 0.156, 0.073, 0.168],
  ['#2', 0.086, 0.094, 0.106, 0.188, 0.086, 0.197],
  ['#3', 0.099, 0.106, 0.120, 0.219, 0.099, 0.226],
  ['#4', 0.112, 0.125, 0.136, 0.219, 0.112, 0.255],
  ['#5', 0.125, 0.141, 0.154, 0.250, 0.125, 0.281],
  ['#6', 0.138, 0.154, 0.170, 0.281, 0.138, 0.307],
  ['#8', 0.164, 0.180, 0.194, 0.312, 0.164, 0.359],
  ['#10', 0.190, 0.206, 0.221, 0.375, 0.190, 0.411],
  ['1/4', 0.250, 0.266, 0.281, 0.438, 0.250, 0.531],
  ['5/16', 0.3125, 0.328, 0.344, 0.531, 0.312, 0.656],
  ['3/8', 0.375, 0.391, 0.406, 0.625, 0.375, 0.781],
  ['7/16', 0.4375, 0.453, 0.469, 0.719, 0.438, 0.844],
  ['1/2', 0.500, 0.516, 0.531, 0.812, 0.500, 0.938],
  ['5/8', 0.625, 0.641, 0.656, 1.000, 0.625, 1.188],
  ['3/4', 0.750, 0.766, 0.781, 1.188, 0.750, 1.438],
  ['7/8', 0.875, 0.891, 0.906, 1.375, 0.875, 1.688],
  ['1', 1.000, 1.016, 1.031, 1.625, 1.000, 1.938],
] as const).map(([size, d, close, normal, cbore, cboreDepth, csk]) => ({ size, d, close, normal, cbore, cboreDepth, csk }));

interface InchThread { name: string; screw: string; tpi: number; series: 'UNC' | 'UNF'; tapDrill: number; drill: string }

const INCH_THREADS: InchThread[] = ([
  ['0-80', '#0', 80, 'UNF', 0.0469, '3/64'],
  ['1-64', '#1', 64, 'UNC', 0.0595, '#53'],
  ['1-72', '#1', 72, 'UNF', 0.0595, '#53'],
  ['2-56', '#2', 56, 'UNC', 0.0700, '#50'],
  ['2-64', '#2', 64, 'UNF', 0.0700, '#50'],
  ['3-48', '#3', 48, 'UNC', 0.0785, '#47'],
  ['3-56', '#3', 56, 'UNF', 0.0820, '#45'],
  ['4-40', '#4', 40, 'UNC', 0.0890, '#43'],
  ['4-48', '#4', 48, 'UNF', 0.0935, '#42'],
  ['5-40', '#5', 40, 'UNC', 0.1015, '#38'],
  ['5-44', '#5', 44, 'UNF', 0.1040, '#37'],
  ['6-32', '#6', 32, 'UNC', 0.1065, '#36'],
  ['6-40', '#6', 40, 'UNF', 0.1130, '#33'],
  ['8-32', '#8', 32, 'UNC', 0.1360, '#29'],
  ['8-36', '#8', 36, 'UNF', 0.1360, '#29'],
  ['10-24', '#10', 24, 'UNC', 0.1495, '#25'],
  ['10-32', '#10', 32, 'UNF', 0.1590, '#21'],
  ['1/4-20', '1/4', 20, 'UNC', 0.2010, '#7'],
  ['1/4-28', '1/4', 28, 'UNF', 0.2130, '#3'],
  ['5/16-18', '5/16', 18, 'UNC', 0.2570, 'F'],
  ['5/16-24', '5/16', 24, 'UNF', 0.2720, 'I'],
  ['3/8-16', '3/8', 16, 'UNC', 0.3125, '5/16'],
  ['3/8-24', '3/8', 24, 'UNF', 0.3320, 'Q'],
  ['7/16-14', '7/16', 14, 'UNC', 0.3680, 'U'],
  ['7/16-20', '7/16', 20, 'UNF', 0.3906, '25/64'],
  ['1/2-13', '1/2', 13, 'UNC', 0.4219, '27/64'],
  ['1/2-20', '1/2', 20, 'UNF', 0.4531, '29/64'],
  ['5/8-11', '5/8', 11, 'UNC', 0.5312, '17/32'],
  ['5/8-18', '5/8', 18, 'UNF', 0.5781, '37/64'],
  ['3/4-10', '3/4', 10, 'UNC', 0.6562, '21/32'],
  ['3/4-16', '3/4', 16, 'UNF', 0.6875, '11/16'],
  ['7/8-9', '7/8', 9, 'UNC', 0.7656, '49/64'],
  ['7/8-14', '7/8', 14, 'UNF', 0.8125, '13/16'],
  ['1-8', '1', 8, 'UNC', 0.8750, '7/8'],
  ['1-12', '1', 12, 'UNF', 0.9219, '59/64'],
] as const).map(([name, screw, tpi, series, tapDrill, drill]) => ({ name, screw, tpi, series, tapDrill, drill }));

interface MetricScrew { size: string; d: number; pitch: number; fine: number; medium: number; coarse: number; cbore?: number; csk?: number }

// size, d, coarse pitch, ISO 273 fine/medium/coarse, DIN 974-1 cbore (ISO 4762), ISO 10642 head dia
const METRIC_SCREWS: MetricScrew[] = ([
  ['M3', 3, 0.5, 3.2, 3.4, 3.6, 6.5, 6.72],
  ['M4', 4, 0.7, 4.3, 4.5, 4.8, 8, 8.96],
  ['M5', 5, 0.8, 5.3, 5.5, 5.8, 10, 11.2],
  ['M6', 6, 1.0, 6.4, 6.6, 7.0, 11, 13.44],
  ['M8', 8, 1.25, 8.4, 9.0, 10.0, 15, 17.92],
  ['M10', 10, 1.5, 10.5, 11.0, 12.0, 18, 22.4],
  ['M12', 12, 1.75, 13.0, 13.5, 14.5, 20, 26.88],
  ['M14', 14, 2.0, 15.0, 15.5, 16.5, 24, undefined],
  ['M16', 16, 2.0, 17.0, 17.5, 18.5, 26, 33.6],
  ['M20', 20, 2.5, 21.0, 22.0, 24.0, 33, 40.32],
  ['M24', 24, 3.0, 25.0, 26.0, 28.0, 40, undefined],
] as const).map(([size, d, pitch, fine, medium, coarse, cbore, csk]) => ({ size, d, pitch, fine, medium, coarse, cbore, csk }));

/** Standard metric fine pitches offered for tapped holes. */
const METRIC_FINE: Record<string, number[]> = { M6: [0.75], M8: [1.0], M10: [1.25, 1.0], M12: [1.5, 1.25], M14: [1.5], M16: [1.5], M20: [1.5], M24: [2.0] };

export interface HoleSpec {
  /** Values in the standard's unit (in for ansi-inch, mm for iso-metric). */
  unit: 'in' | 'mm';
  /** Nominal fastener diameter. */
  nominal: number;
  /** Diameter of the drilled hole (clearance or tap drill). */
  diameter: number;
  cboreDiameter?: number;
  cboreDepth?: number;
  cskDiameter?: number;
  /** Included countersink angle, degrees. */
  cskAngle?: number;
  /** Tapped holes. */
  thread?: { callout: string; major: number; pitch: number; series: string; drill: string };
  /** Short description for the tree / drawings, e.g. "CBORE for 1/4 SHCS". */
  label: string;
}

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '').replace(/^NO\.?/, '#');

function inchScrew(size: string): InchScrew {
  const k = norm(size).split('-')[0].replace(/"$/, '');
  const s = INCH_SCREWS.find((x) => x.size.toUpperCase() === k || x.size.toUpperCase() === `#${k}`);
  if (!s) throw new Error(`Unknown inch screw size "${size}". Sizes: ${INCH_SCREWS.map((x) => x.size).join(', ')}`);
  return s;
}

function metricScrew(size: string): MetricScrew {
  const k = norm(size).split('X')[0];
  const s = METRIC_SCREWS.find((x) => x.size === k);
  if (!s) throw new Error(`Unknown metric size "${size}". Sizes: ${METRIC_SCREWS.map((x) => x.size).join(', ')}`);
  return s;
}

/** Look up a hole in the tables. Throws a clear error for sizes or combinations the tables do not have. */
export function holeSpec(standard: HoleStandard, type: HoleType, size: string, fit: HoleFit = 'normal'): HoleSpec {
  if (standard === 'ansi-inch') {
    if (type === 'tapped') {
      const k = norm(size).replace(/^#/, '');
      const t = INCH_THREADS.find((x) => x.name === k) ?? INCH_THREADS.find((x) => x.name === k.replace(/(UNC|UNF)$/, ''));
      if (!t) {
        // "1/4" alone means the coarse thread.
        const sc = INCH_SCREWS.find((x) => x.size.replace('#', '') === k);
        const unc = sc && INCH_THREADS.find((x) => x.screw === sc.size && x.series === 'UNC');
        if (!unc) throw new Error(`Unknown inch thread "${size}". Use e.g. 1/4-20, 10-32, 4-40.`);
        return tappedInch(unc);
      }
      return tappedInch(t);
    }
    const s = inchScrew(size);
    if (fit === 'loose') throw new Error('Inch tables have close and normal fit only (ASME B18.3); use normal, or give the diameter');
    const diameter = fit === 'close' ? s.close : s.normal;
    if (type === 'counterbore') return { unit: 'in', nominal: s.d, diameter, cboreDiameter: s.cbore, cboreDepth: s.cboreDepth, label: `CBORE for ${s.size} SHCS` };
    if (type === 'countersink') return { unit: 'in', nominal: s.d, diameter, cskDiameter: s.csk, cskAngle: 82, label: `CSK for ${s.size} Flat Head Screw` };
    return { unit: 'in', nominal: s.d, diameter, label: `${s.size} Clearance Hole` };
  }
  if (type === 'tapped') {
    const k = norm(size);
    const s = metricScrew(k);
    const m = /X([\d.]+)$/.exec(k);
    const pitch = m ? Number(m[1]) : s.pitch;
    if (pitch !== s.pitch && !(METRIC_FINE[s.size] ?? []).includes(pitch)) throw new Error(`${s.size} has no standard ${pitch} mm pitch. Coarse is ${s.pitch}${METRIC_FINE[s.size] ? `, fine: ${METRIC_FINE[s.size].join(', ')}` : ''}`);
    const callout = `${s.size}x${pitch}`;
    const drill = +(s.d - pitch).toFixed(3);
    return { unit: 'mm', nominal: s.d, diameter: drill, thread: { callout, major: s.d, pitch, series: pitch === s.pitch ? 'coarse' : 'fine', drill: `${drill} mm` }, label: `${callout} Tapped Hole` };
  }
  const s = metricScrew(size);
  const diameter = fit === 'close' ? s.fine : fit === 'loose' ? s.coarse : s.medium;
  if (type === 'counterbore') {
    if (s.cbore === undefined) throw new Error(`No counterbore data for ${s.size}; give the counterbore diameter`);
    return { unit: 'mm', nominal: s.d, diameter, cboreDiameter: s.cbore, cboreDepth: s.d, label: `CBORE for ${s.size} SHCS` };
  }
  if (type === 'countersink') {
    if (s.csk === undefined) throw new Error(`No countersink data for ${s.size}; give the countersink diameter`);
    return { unit: 'mm', nominal: s.d, diameter, cskDiameter: s.csk, cskAngle: 90, label: `CSK for ${s.size} Flat Head Screw` };
  }
  return { unit: 'mm', nominal: s.d, diameter, label: `${s.size} Clearance Hole` };
}

function tappedInch(t: InchThread): HoleSpec {
  const sc = INCH_SCREWS.find((x) => x.size === t.screw)!;
  return {
    unit: 'in', nominal: sc.d, diameter: t.tapDrill,
    thread: { callout: `${t.name} ${t.series}`, major: sc.d, pitch: 1 / t.tpi, series: t.series, drill: `${t.drill} (${t.tapDrill.toFixed(4)})` },
    label: `${t.name} Tapped Hole`,
  };
}

/** Sizes the UI / AI can offer for a standard and hole type. */
export function holeSizes(standard: HoleStandard, type: HoleType): string[] {
  if (standard === 'ansi-inch') return type === 'tapped' ? INCH_THREADS.map((t) => t.name) : INCH_SCREWS.map((s) => s.size);
  if (type === 'tapped') return METRIC_SCREWS.flatMap((s) => [`${s.size}x${s.pitch}`, ...(METRIC_FINE[s.size] ?? []).map((p) => `${s.size}x${p}`)]);
  return METRIC_SCREWS.filter((s) => (type === 'counterbore' ? s.cbore : type === 'countersink' ? s.csk : true) !== undefined).map((s) => s.size);
}

/**
 * Drawing-style hole callout (ASME Y14.5 symbols), values in the given unit
 * with 3 (in) or 2 (mm) decimals, e.g. "⌀.281 THRU ALL  ⌴ ⌀.438 ↧ .250".
 */
export function holeCallout(h: {
  holeType: HoleType; diameter: number; through: boolean; depth?: number;
  cboreDiameter?: number; cboreDepth?: number; cskDiameter?: number; cskAngle?: number;
  thread?: string; threadDepth?: number; count?: number;
}, unit: 'in' | 'mm'): string {
  const f = (v: number) => (unit === 'in' ? v.toFixed(3).replace(/^0\./, '.') : v.toFixed(2));
  const parts: string[] = [];
  if (h.count && h.count > 1) parts.push(`${h.count}X`);
  if (h.thread) {
    parts.push(`${h.thread}${h.through ? ' THRU' : h.threadDepth !== undefined ? ` ↧ ${f(h.threadDepth)}` : ''}`);
    parts.push(`TAP DRILL ⌀${f(h.diameter)}${h.through ? ' THRU' : h.depth !== undefined ? ` ↧ ${f(h.depth)}` : ''}`);
  } else {
    parts.push(`⌀${f(h.diameter)} ${h.through ? 'THRU ALL' : h.depth !== undefined ? `↧ ${f(h.depth)}` : ''}`.trim());
  }
  if (h.holeType === 'counterbore' && h.cboreDiameter !== undefined) parts.push(`⌴ ⌀${f(h.cboreDiameter)} ↧ ${f(h.cboreDepth ?? 0)}`);
  if (h.holeType === 'countersink' && h.cskDiameter !== undefined) parts.push(`⌵ ⌀${f(h.cskDiameter)} X ${h.cskAngle ?? 82}°`);
  return parts.join('  ');
}
