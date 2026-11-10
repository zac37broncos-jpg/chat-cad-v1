/**
 * Sheet canvas: renders composed primitives as SVG, with conventional CAD-style
 * navigation (wheel zoom about the cursor, middle-drag or Ctrl+left... pan,
 * F / double-middle-click fit). Reports pointer events in paper millimetres.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { V2 } from '../../drawing/geom2d';
import type { Prim } from '../../drawing/prims';
import { primsToSvg } from '../../drawing/export/svg';
import type { DraftStandard } from '../../drawing/standards';

export interface CanvasHandle { fit(): void; zoomBy(f: number): void }

export interface CanvasPointer { p: V2; button: number; shift: boolean; ctrl: boolean; alt: boolean; detail: number }

interface Props {
  prims: Prim[];
  sheetW: number;
  sheetH: number;
  standard: DraftStandard;
  highlight: Prim[];
  hover: Prim[];
  overlay: Prim[];
  cursor?: string;
  onDown?: (e: CanvasPointer) => void;
  onMove?: (e: CanvasPointer) => void;
  onUp?: (e: CanvasPointer) => void;
  onDouble?: (e: CanvasPointer) => void;
  /** Pixels per mm, for screen-space tolerances. */
  onZoom?: (pxPerMm: number) => void;
}

export const DrawingCanvas = forwardRef<CanvasHandle, Props>(function DrawingCanvas(props, ref) {
  const { prims, sheetW, sheetH, standard } = props;
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([800, 600]);
  // View state: paper centre (mm) and pixels per mm.
  const [view, setView] = useState<{ cx: number; cy: number; s: number }>({ cx: sheetW / 2, cy: sheetH / 2, s: 2 });
  const viewRef = useRef(view); viewRef.current = view;
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setSize([el.clientWidth || 1, el.clientHeight || 1]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const [w, h] = size;
    const s = Math.min((w - 40) / sheetW, (h - 40) / sheetH);
    setView({ cx: sheetW / 2, cy: sheetH / 2, s: Math.max(s, 0.05) });
  }, [size, sheetW, sheetH]);
  // Fit on first layout, whenever the sheet size changes, and on window
  // resizes until the user zooms or pans themselves.
  const fitted = useRef('');
  const navigated = useRef(false);
  useEffect(() => {
    if (size[0] <= 1) return;
    const k = `${sheetW}x${sheetH}`;
    if (fitted.current !== k) { fitted.current = k; navigated.current = false; fit(); } else if (!navigated.current) fit();
  }, [sheetW, sheetH, size, fit]);
  useEffect(() => { props.onZoom?.(view.s); }, [view.s]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    fit: () => { navigated.current = false; fit(); },
    zoomBy: (f: number) => { navigated.current = true; setView((v) => ({ ...v, s: Math.min(200, Math.max(0.05, v.s * f)) })); },
  }), [fit]);

  const toPaper = (clientX: number, clientY: number): V2 => {
    const r = host.current!.getBoundingClientRect();
    const v = viewRef.current;
    const x = v.cx + (clientX - r.left - size[0] / 2) / v.s;
    const y = v.cy - (clientY - r.top - size[1] / 2) / v.s;
    return [x, y];
  };
  const ptr = (e: React.PointerEvent | React.MouseEvent): CanvasPointer => ({ p: toPaper(e.clientX, e.clientY), button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, detail: e.detail });

  const onWheel = (e: React.WheelEvent) => {
    const p = toPaper(e.clientX, e.clientY);
    // Mainstream CAD default: wheel forward zooms out... we follow the common "forward = zoom in".
    const f = Math.exp(-e.deltaY * 0.0015);
    navigated.current = true;
    setView((v) => {
      const s = Math.min(200, Math.max(0.05, v.s * f));
      return { s, cx: p[0] - (p[0] - v.cx) * (v.s / s), cy: p[1] - (p[1] - v.cy) * (v.s / s) };
    });
  };
  useEffect(() => {
    const el = host.current!;
    const prevent = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', prevent, { passive: false });
    return () => el.removeEventListener('wheel', prevent);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.ctrlKey && e.altKey)) {
      e.preventDefault();
      pan.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
      navigated.current = true;
      return;
    }
    props.onDown?.(ptr(e));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, cx: p.cx - (e.clientX - p.x) / v.s, cy: p.cy + (e.clientY - p.y) / v.s }));
      return;
    }
    props.onMove?.(ptr(e));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (pan.current) { pan.current = null; return; }
    props.onUp?.(ptr(e));
  };

  const vb = `${view.cx - size[0] / 2 / view.s} ${sheetH - view.cy - size[1] / 2 / view.s} ${size[0] / view.s} ${size[1] / view.s}`;
  // Lines thinner than one device pixel vanish on screen; keep a minimum visible width.
  const boost = Math.max(0, 0.9 / view.s - 0.25);
  const sheetMarkup = useMemo(() => primsToSvg(prims, sheetH, { standard, warnColor: '#a06a00', widthBoost: boost }), [prims, sheetH, standard, boost]);
  const hlMarkup = useMemo(() => primsToSvg(props.highlight, sheetH, { standard, color: '#1f6feb', widthBoost: boost + 0.25 }), [props.highlight, sheetH, standard, boost]);
  const hoverMarkup = useMemo(() => primsToSvg(props.hover, sheetH, { standard, color: '#e8862a', widthBoost: boost + 0.2 }), [props.hover, sheetH, standard, boost]);
  const ovMarkup = useMemo(() => primsToSvg(props.overlay, sheetH, { standard, color: '#1f8f4e', widthBoost: boost }), [props.overlay, sheetH, standard, boost]);

  return (
    <div
      ref={host}
      className="dw-canvas"
      style={{ cursor: props.cursor ?? 'default' }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => { if (e.button === 1) { navigated.current = false; fit(); } else props.onDouble?.(ptr(e)); }}
      onAuxClick={(e) => { if (e.button === 1 && e.detail === 2) { navigated.current = false; fit(); } }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={size[0]} height={size[1]} viewBox={vb} preserveAspectRatio="xMidYMid meet">
        <rect x={-2} y={-2} width={sheetW + 4} height={sheetH + 4} fill="#8c96a3" opacity={0.35} />
        <rect x={0} y={0} width={sheetW} height={sheetH} fill="#fff" />
        <g dangerouslySetInnerHTML={{ __html: sheetMarkup }} />
        <g dangerouslySetInnerHTML={{ __html: hoverMarkup }} />
        <g dangerouslySetInnerHTML={{ __html: hlMarkup }} />
        <g dangerouslySetInnerHTML={{ __html: ovMarkup }} />
      </svg>
    </div>
  );
});
