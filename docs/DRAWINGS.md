# Drawings (hidden in CHAD)

> CHAD hides this workspace (`src/edition.ts`, see [CHAD_SCOPE.md](CHAD_SCOPE.md)): 2D drawings are for
> machine shops, not 3D printing. The code and its tests stay in the repository and keep running.
> This page describes it for developers.

The engineering edition makes 2D engineering drawings from the part. The views come from the
exact 3D model (not the screen mesh), so they stay correct to the model's
precision, and they update by themselves when the part changes.

## Using it

1. Build a part, then click **Drawings** in the ribbon.
2. Pick the standard (ASME = inches, third-angle; ISO = millimetres,
   first-angle) and a sheet size, then **Create drawing**. You get Front, Top,
   Right and an isometric view at the largest standard scale that fits, plus
   the part's own dimensions if "Import model dimensions" is ticked.
3. Tabs along the top:
   - **View Layout**: Standard 3 View, Model View (any named orientation),
     Projected View (click a view, then move the mouse up, down, left or right
     and click), Section View (horizontal, vertical or two-point cut: click the
     view where to cut, then click where to place the section), Detail View
     (click the centre, click the radius, click where to place it), Auxiliary
     View (click a straight edge, then place the view).
   - **Annotation**: Dimension (D): click an edge
     for its length, two edges or points for a distance, a point and an edge
     for the square distance between them, a circle for its diameter, or two
     slanted edges for an angle, then click where the text goes. Also Model
     Items, Note, Geometric Tolerance (feature control frames), Datum Feature,
     Center Mark, Centerline, Balloon and Bill of Materials.
   - **Sheet Format**: sheet size, scale, standard, units and decimals, title
     block fields, revisions, and Add Sheet.
   - **Export**: PDF (every sheet), DXF and SVG (this sheet), and save or open
     the drawing file.
4. Click to select, drag to move views and annotations. Double-click a
   dimension to edit it. If it is a dimension that drives the part (extrude
   depth, hole size, a rectangle side set by a parameter, or a sketch
   dimension) the part changes too. Double-click a title block cell to fill it
   in. Delete removes the selection; Ctrl+Z and Ctrl+Y undo and redo; F fits
   the sheet; the mouse wheel zooms about the cursor and the middle button
   pans.
5. Anything shown in amber has lost the geometry it was attached to (for
   example, a hole that was deleted). The status bar counts these warnings.

The drawing autosaves in the browser for each part name. Use **Save drawing
file** to keep a copy next to the part file.

## Standards followed

| Topic | ASME (default) | ISO |
|---|---|---|
| Sheet sizes | ANSI A to E (ASME Y14.1) | A4 to A0 (ISO 5457 / ISO 216) |
| Border and zones | 0.5" border; zones A 2×2, B 4×2, C 4×4, D 8×4, E 8×8; numbers right to left, letters bottom to top, I and O skipped (Y14.1) | 20 mm filing margin on the left, 10 mm elsewhere, 0.7 mm frame, centring marks, grid reference fields (ISO 5457) |
| Title block | Company, title, size, CAGE, drawing number, revision, scale, weight, sheet, approvals, tolerance block (Y14.1) | 180 mm wide block with the ISO 7200 fields (owner, title, identification number, revision, date of issue, sheet, language, document type and status) |
| Projection | Third angle, symbol in the title block (Y14.3) | First angle, symbol in the title block (ISO 128-3 / ISO 5456-2) |
| Lines | Thick 0.6 mm, thin 0.3 mm; hidden dashes and centre lines per Y14.2 | Line widths and dash patterns as multiples of the width (ISO 128-2) |
| Text | 0.12" for dimensions and notes, 0.24" for view titles, unidirectional (Y14.2) | 3.5 mm, aligned with the dimension line (ISO 129-1) |
| Dimension numbers | Decimal inch with no leading zero (.500) (Y14.5) | Leading zero, no trailing zeros (0.5) (ISO 129-1) |
| Geometric tolerances | ASME Y14.5-2018 symbols (concentricity and symmetry removed) | ISO 1101 symbols (adds concentricity and symmetry) |
| Section and detail labels | SECTION A-A, DETAIL B, letters I, O and Q not used | Same letters, labels per ISO 128-3 |

Hidden lines are left out of section views (ASME and ISO convention). A detail
view shows its parent's region with the parent's display style.

## Exports

- **PDF**: vector, true scale (a B sheet is exactly 17 × 11 in), all sheets in
  one file, standard Helvetica text so any viewer shows it the same.
- **DXF**: AutoCAD R12 format, which every CAD program reads. Drawn at 1:1
  paper size in inches (ASME) or millimetres (ISO). Set the importing program
  to the same unit.
- **SVG**: true size in millimetres, for web pages or laser cutters.

All three come from the same internal list of lines, arcs and text that the
screen shows, so what you see is what you get.

## How it works (for developers)

- `src/kernel/hlr.ts`: exact hidden-line removal with OpenCascade
  `HLRBRep_Algo` in the geometry worker. Each view request gives a frame (and
  for sections a cut point); it returns visible, hidden and tangent edges as
  lines, arcs, ellipses or polylines, the cut faces for hatching, and the
  model anchors (vertices, circles, lines, axes) used for snapping and
  associative dimensions. Worker op: `{ op: 'drawing', doc, views }`.
- `src/drawing/`: pure TypeScript, no DOM. `model.ts` is the saved drawing
  format; `views.ts` the view frames and projection rules (third and first
  angle); `sheetFormat.ts` borders, zones and title blocks; `compose.ts` turns
  a sheet plus geometry into paper primitives (`prims.ts`); `annotate.ts` and
  `gdt.ts` draw dimensions, leaders and frames; `layout.ts` places standard
  views and imports model items; `export/` writes SVG, PDF and DXF.
- `src/ui/drawing/`: the React workspace (`DrawingWorkspace`), the canvas and
  picking/snapping.
- Dimensions keep 3D references (a point, circle or line, plus the kernel's
  vertex or edge index) and re-resolve on every rebuild. Model dimensions
  link to the feature or sketch they came from.
- Tests: `tests/drawing-views.test.ts` (projection, HLR, sections, 2D
  geometry) and `tests/drawing-compose.test.ts` (full drawings, associativity,
  exports, ISO). Set `CHATCAD_TEST_OUT=folder` to write the test PDF, DXF and
  SVG files for a look.

## Not done yet

- Drawings of assemblies (BOM rows per component, exploded views) wait for
  assemblies.
- Broken-out and revolved sections, break views, crop views.
- Hole callouts that read the hole data, ordinate and baseline
  dimensions, surface finish and weld symbols.
- Dragging the section line or detail circle after placing them (edit their
  numbers in the view's properties for now).
