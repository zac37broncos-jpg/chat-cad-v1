# What CHAD shows, what it hides, and why

CHAD is for people who own a 3D printer and want to print whatever they can imagine: describe it to the AI chat or model it by hand, then get a file the slicer accepts on the first try. It was split from a fuller engineering CAD edition (2D drawings, and later assemblies) that shares the same code.

CHAD **hides** the engineering-only screens instead of deleting them. The hidden code and its tests stay and keep running, so the two editions keep sharing one tested code base. The switches are in `src/edition.ts`, and `tests/edition.test.ts` checks them.

## Kept: CHAD's strengths for printing

| Area | What it does for a printer owner |
|---|---|
| AI chat | Builds whole models from one sentence (brackets, enclosures, figurines), or does a single step when you're stuck. It states its assumptions, names every part, and you edit by name ("make the left ear bigger by 2 mm"). One Ctrl+Z undoes a whole request. |
| Organic modelling | Smooth bodies (profile bodies, lofted sections, tubes, dish cuts) for figurines, statues and characters, with tested reference examples (a moai and a cartoon bear). |
| Parametric feature tree | Every step stays editable: sketch, extrude, revolve, sweep, loft, fillet, chamfer, hole, patterns, mirror, shell, rib, draft, planes/axes/points, named parameters, rollback bar, suppress, edit by name. |
| Sketcher | Mouse sketching with relations and dimensions, plus exact typed entry. |
| Check before printing | "Ready to print" check: exactly one closed solid, watertight STL, no floating or barely-touching pieces. |
| STL export | Checked, watertight binary STL in mm, with a measured surface deviation (accuracy promise 0.005 in / 0.127 mm). Slicer guide in [EXPORT_AND_PRINT.md](EXPORT_AND_PRINT.md). |
| STEP export | The exact solid, for print services, other CAD programs and CNC. |
| Size, mass, materials | Measure, exact bounding box, volume and mass with PLA, PETG, ABS, nylon and other materials, so you know the size and roughly how much filament before slicing. |
| Safety | Autosave with 3 restore points, crash recovery, undo/redo. |

## Hidden in CHAD

| Hidden | What it is | Why it is hidden | How |
|---|---|---|---|
| **Drawings** (the Drawings tab and the whole 2D drawing workspace) | ASME/ISO drawing sheets, title blocks, sheet formats, standard views, dimensions, GD&T, PDF/DXF/SVG export | These are for sending parts to a machine shop, not for printing. They're also the most standards-heavy part of the app (sheet layouts and drafting rules), which a consumer product doesn't need to carry. | `EDITION.drawings = false` in `src/edition.ts`, so the Drawings tab never appears. The code stays, and `tests/drawing-*.test.ts` plus the benchmarks still run it. |

## Kept on purpose, though they sound "engineering"

- **Draft.** Tapering faces is how people make printed molds for casting resin or silicone, a common printer-owner project.
- **Hole tables (inch and metric screws).** Printed parts are screwed together all the time. Clearance, counterbore and countersink holes from real screw sizes save guessing. (Print-specific hole sizes are on the roadmap below.)
- **STEP export.** Print services and friends with other CAD programs ask for it.
- **Parameters and the feature tree.** This is what makes CHAD better than mesh-only "AI to STL" tools: every model stays editable.

## Print-focused roadmap (ideas, not started)

1. **3MF export.** The modern slicer format. It stores units, so the "inch part comes out 25 times too small" pitfall disappears. Bambu Studio, PrusaSlicer, OrcaSlicer and Cura all read it.
2. **Millimetres by default for new parts.** Most printer owners think in mm; new parts start in inches today.
3. **Printability checks.** Overhang angle map, minimum wall thickness, thin features, a suggestion for which face goes on the bed, and a build-volume check against common printers.
4. **Print-aware holes and fits.** Hole compensation for FDM (holes print small), heat-set insert sizes, press-fit and sliding-fit presets.
5. **Filament estimate.** Grams and metres of filament from the exact volume and the chosen material (needs measured densities from the filament makers, no guessed numbers).
6. **Text and logos on parts** (embossed and engraved), a frequent request for printed gifts and labels.
7. **Split a large model** into printable pieces with alignment pins.
