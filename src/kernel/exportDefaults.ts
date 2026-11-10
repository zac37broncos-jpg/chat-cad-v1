/**
 * Export settings shared by the app's dialogs, the kernel and the tests.
 * All lengths in mm (the model's unit), angles in radians.
 *
 * STL chord tolerance: the largest distance between a triangle and the true
 * surface. CHAD's accuracy promise is 0.005 in (0.127 mm); every preset is
 * inside it and the default is 1/12 of it. The value shown is an upper bound:
 * every export measures the sag of its curved triangles and meshes finer when
 * needed (exporters.ts), and tests/export.test.ts measures the real error of
 * exported files independently against the exact surface.
 */
const DEG = Math.PI / 180;

export interface StlPreset { id: 'draft' | 'fine' | 'extra'; label: string; linearDeflection: number; angularDeflection: number; note: string }

export const STL_PRESETS: readonly StlPreset[] = [
  { id: 'draft', label: 'Draft', linearDeflection: 0.05, angularDeflection: 15 * DEG, note: 'quick test prints; small holes show flats' },
  { id: 'fine', label: 'Fine (recommended)', linearDeflection: 0.01, angularDeflection: 5 * DEG, note: 'holes and curves print round on any printer' },
  { id: 'extra', label: 'Extra fine', linearDeflection: 0.005, angularDeflection: 3 * DEG, note: 'resin printers; bigger files, slower to save' },
];

export const STL_DEFAULT: StlPreset = STL_PRESETS[1];

/**
 * A file name that is safe on Windows, macOS and Linux: no \ / : * ? " < > |
 * or control characters, no trailing dots or spaces, not a reserved device
 * name (CON, PRN, AUX, NUL, COM1-9, LPT1-9), at most 120 characters.
 */
export function safeFileBase(name: string): string {
  let s = (name ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = 'Part';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = `${s}_part`;
  return s.slice(0, 120).replace(/[. ]+$/g, '') || 'Part';
}
