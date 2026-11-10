/**
 * Drafting standards data: sheet sizes, zones, line conventions, lettering
 * and dimensioning defaults.
 *
 * Sources (values researched, not guessed; see docs/DRAWINGS.md):
 * - ASME Y14.1-2012 Table 4-1: ANSI sheet sizes A–E, 0.50 in format margins,
 *   zone counts (A 2×2, B 4×2, C 4×4, D 8×4, E 8×8; zones optional on A/B,
 *   required on C–E). Zones numbered right→left and lettered bottom→top
 *   from the lower right corner; letters I and O are not used.
 * - ASME Y14.2: two line widths, thick ≥ 0.6 mm and thin ≥ 0.3 mm;
 *   lettering ≥ 0.12 in (3 mm) for dimensions and notes, 0.24 in (6 mm)
 *   for view titles / section letters, 0.10 in for title block labels.
 *   Hidden dashes ≈ 3 mm with ≈ 1 mm gaps; center/phantom long dashes
 *   20–40 mm, short dashes ≈ 3 mm, gaps ≈ 1.5 mm.
 * - ASME Y14.5-2018: arrowheads filled, length ≈ letter height, 3:1;
 *   extension lines start with a visible gap (≈ 1.5 mm) and extend ≈ 3 mm
 *   past the dimension line; first dimension line ≥ 10 mm from the part,
 *   then ≥ 6 mm apart. Decimal inch: no leading zero, decimals match the
 *   tolerance. Metric: leading zero, no trailing zeros.
 * - ISO 216 sheet sizes A4–A0; ISO 5457 frame: 20 mm filing margin on the
 *   left, 10 mm on the other edges, frame line 0.7 mm, grid fields 50 mm
 *   from the centring marks (numbers along the horizontal edges, capital
 *   letters along the vertical edges, starting at the top left).
 * - ISO 128-20 line groups (here 0.5 / 0.25 mm), ISO 128-20 dash pattern
 *   lengths proportional to line width d: dashed 12d dash / 3d gap;
 *   long-dash-dot 24d / 3d gap / 0.5d dot. ISO 3098 lettering 3.5 mm.
 * - ISO 7200 title block: at most 180 mm wide, bottom right of the frame.
 */

export type SheetSizeId = 'A' | 'A-portrait' | 'B' | 'C' | 'D' | 'E' | 'A4' | 'A4-landscape' | 'A3' | 'A2' | 'A1' | 'A0';
export type DraftStandard = 'ASME' | 'ISO';

export interface SheetSize {
  id: SheetSizeId;
  label: string;
  family: 'ANSI' | 'ISO';
  /** Trimmed sheet size, mm (width × height as placed). */
  w: number;
  h: number;
  /** Zone counts along width and height (ASME); ISO computes 50 mm fields. */
  zones?: [number, number];
}

const IN = 25.4;

export const SHEET_SIZES: SheetSize[] = [
  { id: 'A', label: 'ANSI A (11 × 8.5 in)', family: 'ANSI', w: 11 * IN, h: 8.5 * IN, zones: [2, 2] },
  { id: 'A-portrait', label: 'ANSI A portrait (8.5 × 11 in)', family: 'ANSI', w: 8.5 * IN, h: 11 * IN, zones: [2, 2] },
  { id: 'B', label: 'ANSI B (17 × 11 in)', family: 'ANSI', w: 17 * IN, h: 11 * IN, zones: [4, 2] },
  { id: 'C', label: 'ANSI C (22 × 17 in)', family: 'ANSI', w: 22 * IN, h: 17 * IN, zones: [4, 4] },
  { id: 'D', label: 'ANSI D (34 × 22 in)', family: 'ANSI', w: 34 * IN, h: 22 * IN, zones: [8, 4] },
  { id: 'E', label: 'ANSI E (44 × 34 in)', family: 'ANSI', w: 44 * IN, h: 34 * IN, zones: [8, 8] },
  { id: 'A4', label: 'ISO A4 portrait (210 × 297 mm)', family: 'ISO', w: 210, h: 297 },
  { id: 'A4-landscape', label: 'ISO A4 landscape (297 × 210 mm)', family: 'ISO', w: 297, h: 210 },
  { id: 'A3', label: 'ISO A3 (420 × 297 mm)', family: 'ISO', w: 420, h: 297 },
  { id: 'A2', label: 'ISO A2 (594 × 420 mm)', family: 'ISO', w: 594, h: 420 },
  { id: 'A1', label: 'ISO A1 (841 × 594 mm)', family: 'ISO', w: 841, h: 594 },
  { id: 'A0', label: 'ISO A0 (1189 × 841 mm)', family: 'ISO', w: 1189, h: 841 },
];

export function sheetSize(id: SheetSizeId): SheetSize {
  const s = SHEET_SIZES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sheet size ${id}`);
  return s;
}

/** Short size designation for the title block SIZE field. */
export const sizeDesignation = (id: SheetSizeId) => (id === 'A-portrait' ? 'A' : id === 'A4-landscape' ? 'A4' : id);

/** Line types used on drawings. */
export type LineType = 'visible' | 'hidden' | 'center' | 'phantom' | 'thin' | 'cutting' | 'border' | 'frame' | 'tangent' | 'hatch';

export interface LineStyle { width: number; dash?: number[] }

export interface StandardSpec {
  id: DraftStandard;
  label: string;
  lines: Record<LineType, LineStyle>;
  /** Lettering heights (cap height, mm). */
  text: { dim: number; note: number; viewLabel: number; title: number; tbLabel: number; tbValue: number; zone: number };
  arrow: { length: number; width: number };
  ext: { gap: number; overshoot: number };
  dimOffset: { first: number; next: number };
  /** Text placement relative to dimension lines: ASME breaks the line (unidirectional); ISO writes above it (aligned). */
  textMode: 'unidirectional' | 'aligned';
  /** Leading zero for values < 1 (inch ASME: no; metric: yes). */
  leadingZero: (units: 'in' | 'mm') => boolean;
  /** Hatch spacing (paper mm) and angle. */
  hatch: { spacing: number; angle: number };
  /** Gap letters never used for view / datum letters. */
  excludedLetters: string[];
  defaultProjection: 'third' | 'first';
}

const asmeThick = 0.6, asmeThin = 0.3;
const isoThick = 0.5, isoThin = 0.25;

export const STANDARDS: Record<DraftStandard, StandardSpec> = {
  ASME: {
    id: 'ASME',
    label: 'ASME Y14 (inch, third angle)',
    lines: {
      visible: { width: asmeThick },
      tangent: { width: asmeThin },
      hidden: { width: asmeThin, dash: [3, 1] },
      center: { width: asmeThin, dash: [24, 1.5, 3, 1.5] },
      phantom: { width: asmeThin, dash: [24, 1.5, 3, 1.5, 3, 1.5] },
      cutting: { width: asmeThick, dash: [24, 1.5, 3, 1.5, 3, 1.5] },
      thin: { width: asmeThin },
      hatch: { width: asmeThin },
      border: { width: asmeThick },
      frame: { width: asmeThin },
    },
    text: { dim: 0.12 * IN, note: 0.12 * IN, viewLabel: 0.24 * IN, title: 0.24 * IN, tbLabel: 0.08 * IN, tbValue: 0.12 * IN, zone: 0.12 * IN },
    arrow: { length: 0.125 * IN, width: 0.125 * IN / 3 },
    ext: { gap: 0.0625 * IN, overshoot: 0.125 * IN },
    dimOffset: { first: 0.375 * IN, next: 0.25 * IN },
    textMode: 'unidirectional',
    leadingZero: (u) => u === 'mm',
    hatch: { spacing: 0.125 * IN, angle: Math.PI / 4 },
    excludedLetters: ['I', 'O', 'Q'],
    defaultProjection: 'third',
  },
  ISO: {
    id: 'ISO',
    label: 'ISO (mm, first angle)',
    lines: {
      visible: { width: isoThick },
      tangent: { width: isoThin },
      hidden: { width: isoThin, dash: [12 * isoThin, 3 * isoThin] },
      center: { width: isoThin, dash: [24 * isoThin, 3 * isoThin, 0.5 * isoThin, 3 * isoThin] },
      phantom: { width: isoThin, dash: [24 * isoThin, 3 * isoThin, 0.5 * isoThin, 3 * isoThin, 0.5 * isoThin, 3 * isoThin] },
      cutting: { width: isoThick, dash: [24 * isoThin, 3 * isoThin, 0.5 * isoThin, 3 * isoThin] },
      thin: { width: isoThin },
      hatch: { width: isoThin },
      border: { width: 0.7 },
      frame: { width: isoThin },
    },
    text: { dim: 3.5, note: 3.5, viewLabel: 5, title: 7, tbLabel: 1.8, tbValue: 3.5, zone: 3.5 },
    arrow: { length: 3.5, width: 1.2 },
    ext: { gap: 1, overshoot: 2 },
    dimOffset: { first: 10, next: 7 },
    textMode: 'aligned',
    leadingZero: () => true,
    hatch: { spacing: 3, angle: Math.PI / 4 },
    excludedLetters: ['I', 'O', 'Q'],
    defaultProjection: 'first',
  },
};

/** Next unused view letter (A, B, C... skipping I, O, Q; then AA, BB...). */
export function nextLetter(used: string[], excluded: string[]): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !excluded.includes(l));
  for (let rep = 1; rep < 4; rep++) for (const l of letters) { const s = l.repeat(rep); if (!used.includes(s)) return s; }
  return 'Z';
}
