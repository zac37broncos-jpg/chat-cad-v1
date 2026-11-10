/**
 * Small original line icons (20x20 grid, stroke = currentColor).
 * Drawn for this project; not taken from any other product.
 */
import type { ReactElement } from 'react';

const P: Record<string, ReactElement> = {
  part: <><path d="M4 7l6-3 6 3v7l-6 3-6-3z" /><path d="M4 7l6 3 6-3M10 10v7" /></>,
  boss: <><path d="M4 12l6-3 6 3-6 3z" /><path d="M4 12v3l6 3 6-3v-3" /><path d="M10 3v6M7.5 5.5L10 3l2.5 2.5" /></>,
  cut: <><path d="M3 10l7-3.5 7 3.5v4l-7 3.5L3 14z" /><path d="M8 9.5l2-1 2 1v2.5l-2 1-2-1z" fill="currentColor" fillOpacity=".25" /><path d="M10 2v5M8 5l2 2 2-2" /></>,
  revolve: <><path d="M10 3v14" strokeDasharray="2 1.5" /><path d="M5 8a5 2.2 0 1 0 10 0" /><path d="M5 8v5a5 2.2 0 0 0 10 0V8" /><path d="M13.5 4.5l1.5 1.5-2 .8" /></>,
  revcut: <><path d="M10 3v14" strokeDasharray="2 1.5" /><path d="M4 7a6 2.4 0 1 0 12 0a6 2.4 0 1 0-12 0v6a6 2.4 0 0 0 12 0V7" /><path d="M7.5 9.5v3a2.5 1 0 0 0 5 0v-3" fill="currentColor" fillOpacity=".25" /></>,
  sketch: <><path d="M3 17l1-4 9-9 3 3-9 9z" /><path d="M11.5 5.5l3 3" /><path d="M3 17h6" /></>,
  plane: <path d="M2 13l5-7h11l-5 7z" />,
  skLine: <><path d="M4 16L16 4" /><circle cx="4" cy="16" r="1.3" fill="currentColor" /><circle cx="16" cy="4" r="1.3" fill="currentColor" /></>,
  skRect: <><rect x="3.5" y="5.5" width="13" height="9" /><circle cx="3.5" cy="14.5" r="1.2" fill="currentColor" /><circle cx="16.5" cy="5.5" r="1.2" fill="currentColor" /></>,
  skCircle: <><circle cx="10" cy="10" r="6.5" /><path d="M8.8 10h2.4M10 8.8v2.4" /></>,
  skArc: <><path d="M3.5 15a7 7 0 0 1 13 0" /><circle cx="3.5" cy="15" r="1.2" fill="currentColor" /><circle cx="16.5" cy="15" r="1.2" fill="currentColor" /><circle cx="10" cy="8" r="1.2" fill="currentColor" /></>,
  skDim: <><path d="M3 6v8M17 6v8" /><path d="M3 10h14M5.5 8L3 10l2.5 2M14.5 8L17 10l-2.5 2" /></>,
  skTrim: <><path d="M3 10h14" strokeDasharray="2 1.5" /><path d="M7 4l6 12M13 4L7 16" /></>,
  skOffset: <><path d="M3 15V7h9" /><path d="M6 15v-5h6" strokeDasharray="2 1.5" /></>,
  skFillet: <><path d="M4 4v6a6 6 0 0 0 6 6h6" /></>,
  skPoint: <><circle cx="10" cy="10" r="2" fill="currentColor" /><path d="M10 3v3M10 14v3M3 10h3M14 10h3" /></>,
  skExit: <><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M6.5 10.5l2.5 2.5 4.5-5" /></>,
  origin: <><circle cx="10" cy="10" r="2.2" /><path d="M10 2v5M10 13v5M2 10h5M13 10h5" /></>,
  material: <><path d="M3 15l7-11 7 11z" /><path d="M6.5 15l3.5-5.5 3.5 5.5" /></>,
  measure: <><path d="M3 14l11-11 3 3-11 11z" /><path d="M6 11l1.5 1.5M8 9l1 1M10 7l1.5 1.5M12 5l1 1" /></>,
  mass: <><path d="M5 8h10l2 9H3z" /><circle cx="10" cy="5" r="2" /></>,
  params: <><path d="M4 16c3 0 2-12 6-12" /><path d="M6 9h5" /><path d="M12 11l5 5M17 11l-5 5" /></>,
  fit: <><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /><rect x="7" y="7" width="6" height="6" /></>,
  prev: <><path d="M8 5L3 10l5 5" /><path d="M3 10h9a5 5 0 0 1 5 5" /></>,
  views: <><path d="M4 7l6-3 6 3v7l-6 3-6-3z" /><path d="M4 7l6 3 6-3" /><path d="M10 10v7" fill="none" /><path d="M10 10l6-3v7l-6 3z" fill="currentColor" fillOpacity=".3" /></>,
  shaded: <><path d="M4 7l6-3 6 3v7l-6 3-6-3z" fill="currentColor" fillOpacity=".35" /><path d="M4 7l6 3 6-3M10 10v7" /></>,
  eye: <><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" /><circle cx="10" cy="10" r="2.3" /></>,
  newdoc: <><path d="M5 2h7l4 4v12H5z" /><path d="M12 2v4h4" /></>,
  open: <><path d="M2 5h6l2 2h8v9H2z" /></>,
  save: <><path d="M3 3h11l3 3v11H3z" /><path d="M6 3v5h7V3M6 17v-5h8v5" /></>,
  undo: <><path d="M7 5L3 9l4 4" /><path d="M3 9h9a4 4 0 0 1 0 8H8" /></>,
  redo: <><path d="M13 5l4 4-4 4" /><path d="M17 9H8a4 4 0 0 0 0 8h4" /></>,
  rebuild: <><path d="M15 6a6 6 0 1 0 1.5 5" /><path d="M16 2v4h-4" /></>,
  export: <><path d="M4 12v5h12v-5" /><path d="M10 3v10M6.5 6.5L10 3l3.5 3.5" /></>,
  options: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M4.3 15.7l2.1-2.1M13.6 6.4l2.1-2.1" /></>,
  folder: <path d="M2 5h6l2 2h8v9H2z" />,
  rollback: <path d="M2 10h16" strokeWidth="3" />,
  chat: <><path d="M3 4h14v9H8l-4 3v-3H3z" /><path d="M7 8.5h6" /></>,
  drawing: <><rect x="3" y="3" width="14" height="14" /><path d="M10 13h7M13 13v4" /><rect x="5.5" y="5.5" width="5" height="4" /></>,
  warn: <><path d="M10 3l8 14H2z" /><path d="M10 8v4M10 14.5v.5" /></>,
  error: <><circle cx="10" cy="10" r="7" /><path d="M7 7l6 6M13 7l-6 6" /></>,
  fillet: <><path d="M3 17V8a5 5 0 0 1 5-5h9" /><path d="M3 17h14" strokeDasharray="2 1.5" /><path d="M6 3.5v3M3.5 6h3" /></>,
  chamfer: <><path d="M3 17V8l5-5h9" /><path d="M3 8h5V3" strokeDasharray="2 1.5" /></>,
  hole: <><path d="M3 8l7-3.5L17 8v5l-7 3.5L3 13z" /><ellipse cx="10" cy="8" rx="3" ry="1.4" /><path d="M7 8v4a3 1.4 0 0 0 6 0V8" fill="currentColor" fillOpacity=".2" /></>,
  lpattern: <><rect x="2.5" y="7" width="4" height="4" /><rect x="8" y="7" width="4" height="4" strokeDasharray="1.6 1.2" /><rect x="13.5" y="7" width="4" height="4" strokeDasharray="1.6 1.2" /><path d="M3 15h14M15 13.5l2 1.5-2 1.5" /></>,
  cpattern: <><circle cx="10" cy="10" r="6" strokeDasharray="2 1.5" /><circle cx="10" cy="4" r="1.6" fill="currentColor" fillOpacity=".35" /><circle cx="15.2" cy="13" r="1.6" /><circle cx="4.8" cy="13" r="1.6" /><circle cx="10" cy="10" r=".8" fill="currentColor" /></>,
  mirror: <><path d="M10 2v16" strokeDasharray="2 1.5" /><path d="M8 5L3 9l5 5z" fill="currentColor" fillOpacity=".3" /><path d="M12 5l5 4-5 5z" /></>,
  rib: <><path d="M2 16h16M4 16V5" /><path d="M4 7l10 9" /><path d="M4 9l8 7" strokeDasharray="1.6 1.2" /></>,
  draft: <><path d="M5 16L7 4h6l2 12z" /><path d="M7 4L5 4M5 4v12" strokeDasharray="1.6 1.2" /><path d="M2 16h16" /></>,
  shell: <><path d="M3 7l7-3.5L17 7v7l-7 3.5L3 14z" /><path d="M5.5 8l4.5-2.2L14.5 8v4.5L10 14.8l-4.5-2.3z" fill="currentColor" fillOpacity=".2" /></>,
  sweep: <><path d="M3 16c4 0 3-10 9-10h5" strokeDasharray="2 1.5" /><ellipse cx="4" cy="15" rx="1.6" ry="2.4" /><ellipse cx="16" cy="6" rx="1.6" ry="2.4" fill="currentColor" fillOpacity=".3" /></>,
  sweepCut: <><path d="M3 16c4 0 3-10 9-10h5" strokeDasharray="2 1.5" /><ellipse cx="4" cy="15" rx="1.6" ry="2.4" /><ellipse cx="16" cy="6" rx="1.6" ry="2.4" /><path d="M13 13l4 4M17 13l-4 4" /></>,
  loft: <><rect x="2.5" y="12" width="7" height="5" /><circle cx="14" cy="6" r="3.2" fill="currentColor" fillOpacity=".25" /><path d="M2.5 12L10.8 6M9.5 17l7.5-9.5" /></>,
  loftCut: <><rect x="2.5" y="12" width="7" height="5" /><circle cx="14" cy="6" r="3.2" /><path d="M2.5 12L10.8 6M9.5 17l7.5-9.5" strokeDasharray="1.6 1.2" /><path d="M13.5 13l3.5 3.5M17 13l-3.5 3.5" /></>,
  refPlane: <><path d="M2 13l5-7h11l-5 7z" /><path d="M10 9.5V2M8 4l2-2 2 2" /></>,
  refAxis: <><path d="M3 17L17 3" strokeDasharray="3 1.5" /><circle cx="10" cy="10" r="2.5" /></>,
  refPoint: <><circle cx="10" cy="10" r="1.8" fill="currentColor" /><path d="M10 4v3M10 13v3M4 10h3M13 10h3" /><path d="M5 5l1.5 1.5M15 15l-1.5-1.5" /></>,
  check: <path d="M4 10.5l4 4 8-9" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, className }: { name: IconName | string; size?: number; className?: string }) {
  return (
    <svg className={`ico ${className ?? ''}`} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name] ?? P.part}
    </svg>
  );
}
