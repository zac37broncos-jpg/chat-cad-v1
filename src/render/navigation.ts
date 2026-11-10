/**
 * Mouse navigation presets so users coming from other CAD tools feel at home.
 * These reproduce each tool's published default behaviour (they are
 * conventions, not copied code or UI).
 *
 * Middle button rotates (default here), the most common layout in
 * professional CAD, from published documentation:
 *   middle-drag rotate · Ctrl+middle pan · Shift+middle zoom · Alt+middle roll
 *   middle-click an entity then middle-drag = rotate about it
 *   double-middle-click = zoom to fit · wheel zooms (default direction is the
 *   reverse of most apps: wheel away = zoom out), toward the pointer.
 * Right button rotates: right-drag rotate, middle or Ctrl+right pan, wheel up zooms in.
 * Shift + middle button rotates: middle pan, Shift+middle orbit, wheel zoom.
 */
export type NavPresetId = 'middle-rotate' | 'right-rotate' | 'shift-middle-rotate';
export type NavAction = 'rotate' | 'pan' | 'zoom' | 'roll' | 'none';
export interface Mods { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }

export interface NavPreset {
  id: NavPresetId;
  label: string;
  /** Map a pointer-down (button + modifiers) to an action. button: 0 left, 1 middle, 2 right. */
  action(button: number, mods: Mods): NavAction;
  /** Wheel direction that zooms IN. */
  wheelZoomIn: 'away' | 'toward';
  /** Middle-click on geometry sets the rotation center (mainstream CAD "rotate about entity"). */
  middleClickPivot: boolean;
  /** Double-middle-click fits the view. */
  doubleMiddleFit: boolean;
}

export const NAV_PRESETS: Record<NavPresetId, NavPreset> = {
  'middle-rotate': {
    id: 'middle-rotate', label: 'Middle button rotates (default)',
    action: (b, m) => (b !== 1 ? 'none' : m.ctrl ? 'pan' : m.shift ? 'zoom' : m.alt ? 'roll' : 'rotate'),
    wheelZoomIn: 'toward', middleClickPivot: true, doubleMiddleFit: true,
  },
  'right-rotate': {
    id: 'right-rotate', label: 'Right button rotates',
    action: (b, m) => (b === 2 ? (m.ctrl ? 'pan' : 'rotate') : b === 1 ? 'pan' : 'none'),
    wheelZoomIn: 'away', middleClickPivot: false, doubleMiddleFit: false,
  },
  'shift-middle-rotate': {
    id: 'shift-middle-rotate', label: 'Shift + middle button rotates',
    action: (b, m) => (b === 1 ? (m.shift ? 'rotate' : 'pan') : 'none'),
    wheelZoomIn: 'away', middleClickPivot: false, doubleMiddleFit: true,
  },
};

/** Laptop trackpad fallback on every preset: Alt+left rotate, Alt+Shift+left pan, Alt+Ctrl+left zoom. */
export function trackpadAction(button: number, m: Mods): NavAction {
  if (button !== 0 || !m.alt) return 'none';
  return m.shift ? 'pan' : m.ctrl ? 'zoom' : 'rotate';
}
