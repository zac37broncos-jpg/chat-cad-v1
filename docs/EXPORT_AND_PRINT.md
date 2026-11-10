# How to export and print

This guide covers getting a finished part out of CHAD, as a STEP file for other CAD/CAM programs or an STL file for a 3D printer.

## The two buttons

- **Export STEP** and **Export STL** are on the top toolbar. They are also in the **File ▾** menu, under the part file commands.
- Each one opens a panel on the left with a few choices and a **Save** button.
- The file name starts as the part's name, for example `Mounting Plate.stl`. You can change it in the panel.
- The file goes to your browser's **Downloads** folder, the same as any other download. There is no "Save As" window. To keep files somewhere else, move them from Downloads, or set Chrome to ask where to save (Chrome Settings → Downloads → "Ask where to save each file").
- CHAD checks every file before saving it. When the check passes you see a green **Saved …** message, and the status bar at the bottom says the same.
- If the check finds a problem, nothing is saved. The panel shows a red list of what is wrong, and a **Save anyway** button that you should only use if you know why the problem is acceptable. A problem almost always means the part itself has a fault, for example two bodies that touch but are not joined. Fix the part, then export again.
- The export always uses the **whole part as it is now**. If the rollback bar is above some features, the panel warns you, because those features would be left out.
- If a feature **failed to rebuild** (red in the tree, "rebuild error" in the status bar), it is missing from the solid, so the file would be missing it too (a hole that is not drilled, a boss that is not printed). The panel warns as soon as it opens, and pressing Save saves **nothing**: it lists the failed features and why. Fix them first (or ask the AI chat to). Only if you really want the part without them, press **Save without the failed feature**; the result then says what is missing.

## Which file do I want?

| You want to… | Use | Why |
|---|---|---|
| 3D print it | **STL** | Every slicer reads STL. |
| Machine it (CAM software), or open it in another CAD program | **STEP** | STEP keeps the exact shape (true circles, cylinders and curves), not triangles. |
| Keep working on it in CHAD | **Save part file** (File menu, Ctrl+S) | This is the only file that keeps the feature tree, sketches and names. STEP and STL are "dumb" solids. |

## Printing: STL

### Settings in the Export STL panel

- **Format: Binary (recommended).** Binary is small and holds the numbers exactly as CHAD wrote them. ASCII is the same mesh as text, about 5 times bigger. Use ASCII only if a program asks for it.
- **Units: Millimeters (recommended).** This is the one setting that matters most. An STL file has **no units inside it**, only bare numbers. Every common slicer (PrusaSlicer, Cura, Bambu Studio, OrcaSlicer) reads those numbers as millimeters. CHAD converts your inch part to mm for you, so a 4" plate is written as 101.6 and prints 4" long.
- **Resolution** (how closely the triangles follow curves):

| Preset | Max distance from the true surface | Use it for |
|---|---|---|
| Draft | 0.05 mm (0.002") | Quick test prints. Small holes may show flats. |
| **Fine (recommended)** | **0.01 mm (0.0004")** | Normal prints. Holes and curves print round on any printer. |
| Extra fine | 0.005 mm (0.0002") | Resin printers. Bigger files, slower to save. |
| Custom | 0.001 to 0.127 mm, 0.5° to 30° | Only if you need something specific. |

Even Draft is more than twice as tight as your 0.005" (0.127 mm) precision rule, and Fine is about 12 times tighter. An FDM printer's nozzle is about 0.4 mm wide and a layer is about 0.1 to 0.3 mm, so at Fine the file is far more accurate than any printer can print.

The resolution is **measured, not just requested**. The meshing library sometimes misses its target on curved surfaces, so CHAD checks every triangle against the real surface after meshing and splits the ones that sag too far. Each triangle on a curved face is measured at 12 points, and the largest gap anywhere in it is worked out from those with a safety margin (the largest gap is often between the points, for example a third more than at any side's middle). Triangle sides along a part's edges are also measured against the edge itself. The small shift from writing the numbers into the file (rounding to the file's number format) is counted too. The panel shows the measured value, and it is never above the setting you chose.

On organic parts made of several joined bodies, the joint lines themselves are only exact to a small amount (on one Easter Island head build, 0.019 mm), because the kernel computes where two curved surfaces meet as an approximation. No finer mesh can change that. When it is more than the resolution you picked, the panel adds a **Note** with the number; the file follows the joint exactly as the model has it. If it were ever more than the 0.005" (0.127 mm) promise, the panel would list it as a problem instead.

### What "Ready to print" means

Before saving, CHAD checks the mesh the way a slicer or a mesh repair tool would. The check confirms:

- **Closed and watertight.** Every triangle edge is shared by exactly two triangles, with no gaps and no holes in the skin.
- **Manifold.** No edge is shared by three or more triangles.
- **Facing the right way.** Every triangle faces outward, so the slicer knows which side is solid.
- **No flat or zero-size triangles.** Any slivers are flipped away or removed.
- **No triangle passes through another** (no self-intersections). Where a shape has a sharp spot thinner than the resolution, or the mesher folds a few triangles past a face's border, CHAD meshes the part again a little finer by itself until none cross. If some still cross, nothing is saved and the panel says where.
- **The right volume and size.** The volume is positive and the number of separate pieces and through-holes matches the part.
- **Separate bodies are pointed out.** If the part is two or more bodies that do not touch (for example a mirrored boss that landed beside the plate instead of on it), the file is still valid, but the panel adds a **Note**: the slicer prints each body as its own object, and one in the air needs supports.

If all of that passes you see **"Ready to print: closed and watertight"** with the triangle count and file size. A slicer should not need to "repair" the file. If your slicer offers to repair it anyway, the file is not as CHAD made it, so please report it (open an issue on GitHub).

### In the slicer (PrusaSlicer, Cura, Bambu Studio, OrcaSlicer)

1. Open or drag the `.stl` file into the slicer. These slicers all read STL as millimeters, which is what CHAD wrote.
2. **Check the size right away.** Select the part and look at its size (Bambu/Orca: the object's size fields; PrusaSlicer: the "Size" box on the right; Cura: the Scale tool shows mm). A 4" × 2" plate must show **101.6 × 50.8 mm**. Compare it to the part's size in CHAD.
3. **Up is the same.** CHAD's Top plane is the printer bed, and up (Z) is up in both programs. A part sketched on the Top plane and extruded up lands flat on the bed. A part built on the Front or Right plane lands on its side as modeled; use the slicer's "Lay on face" / "Place on face" tool to choose the bottom.
4. The slicer moves the part onto the bed and centers it. That is normal and does not change the part.

### The inch pitfall (read this once)

If you ever export the STL in **inches**, the file holds the inch numbers (a 4" plate is written as 4.0). The slicer will think that means **4 mm**, and the part comes in **25.4 times too small**. Some slicers notice a tiny part and offer to convert from inches. If you see such a message, say yes; otherwise scale the part by **2540%**. Exporting in millimeters avoids all of this, which is why it is the default.

The STL header also records the unit and the part name (for example `CHAD binary STL; units: mm; part: Mounting Plate`), in case you need to check a file later.

## Machining and other CAD: STEP

### Settings in the Export STEP panel

- **Units: Inches or Millimeters.** Unlike STL, a STEP file **records its unit inside the file**, so CAD and CAM programs scale it correctly either way. The default is the part's own unit, which keeps the dimensions as round numbers (4.000" stays 4.000, not 101.6).
- **STEP version: AP214 (recommended).** Every CAD and CAM program reads AP214. Pick AP242 only if a shop or program asks for it.
- The part's name is stored in the file and shows up as the part name in the other program.

### What the check means

After writing the STEP file, CHAD reads it back with a separate STEP reader. It confirms the solid that comes back:

- has the same number of solids, faces, edges and corners;
- is a valid solid with no open edges;
- is the same size, to within a millionth of its length.

Smooth organic surfaces (lofts) are closed loops in CHAD, but a STEP surface has a start and an end. Where a face runs across that point, CHAD splits it there in the file (the same surface, one extra edge); without that split such a face read back wrong.

Holes come back as true cylinders and flat faces as true planes, which is what CAM toolpaths need. When this passes you see **"Read back by a separate STEP reader: the same solid"**.

### In a CAM or CAD program

1. Open the `.step` file (usually File → Open with the STEP file type, or Import / Upload in web-based CAD).
2. Measure one known dimension with the program's measure tool to confirm the size, for example the 4.000" length of a plate.
3. The part comes in where it was modeled. The origin and the Top plane are the same as in CHAD, so set your work offset from the same origin you designed with.

## Honest limits

- The files were checked by CHAD's automatic tests against hand-calculated sizes and volumes. The tested parts are a plate with holes, a block with rounds and a chamfer, a bolt-circle flange, a revolved ring, two organic figures, and the Easter Island head and cartoon bear examples. Each one was read back by independent code in every unit and format.
- On 2026-11-06 every file of 18 test parts was also checked by separate tools that share no code with CHAD (MeshLab, the Manifold library, trimesh, ADMesh, PrusaSlicer 2.7, and a separate OpenCascade 7.8): see [PRINT_VERIFICATION.md](PRINT_VERIFICATION.md). PrusaSlicer sliced every part. That check found and fixed crossing triangles on the organic examples, and triangles a few percent over the setting inside organic faces.
- **No physical print has been measured, and no import into a commercial CAM or CAD program has been tried yet.** The files follow the published STL and STEP (ISO 10303-21) formats, and STEP was checked with OpenCascade's own STEP reader, so they should open correctly. A first real print and a first CAM import are still the final proof. Check the size in the slicer (step 2 above) the first few times.
- A very large, very curved part at Extra fine can take a while to save: from about 10 seconds up to about 3 minutes for the 6 in Easter Island head built with joined bodies. The Save button reads "Meshing and checking…" until it is done.
- STEP and STL hold the shape only. Colors, sketches, the feature tree and the names of individual features are not in these files. Use **Save part file** for that.

## Trademarks

Program names in this guide (PrusaSlicer, Cura, Bambu Studio, OrcaSlicer) are trademarks of their owners and appear here only to say which programs can open CHAD's files. CHAD is not made by, affiliated with or endorsed by any of them.

## For developers

- Code: `src/kernel/exporters.ts` (STL meshing, measured refinement and mesh check; STEP writing and read-back; `stepReady` splits faces that STEP cannot describe as they are: pole-to-pole faces with holes on surfaces closed around (periodic or not), and faces across the start of a periodic B-spline), `src/kernel/exportDefaults.ts` (presets, safe file names), `src/ui/ExportPMs.tsx` (the two panels), `src/kernel/regenOp.ts` `modelForExport` (each export rebuilds exactly the open document through the history cache, never the worker's last model, and names failed features).
- Crossing triangles: `src/kernel/meshIntersect.ts` (bounding-volume tree, proper edge-through-triangle crossings; the same counts as MeshLab on the verification files). Tests: `tests/stl-mesh-quality.test.ts`.
- Independent verification with outside tools: `verify/print/` (`npm run verify:print`, see [PRINT_VERIFICATION.md](PRINT_VERIFICATION.md)).
- Tests: `tests/export.test.ts` (round trips, read back by independent STL and ISO 10303-21 parsers), `tests/export-partial.test.ts` (exports follow the open document, failed features named), `tests/step-periodic.test.ts` (the Easter Island head and the cartoon bear, with seams that failed before, read back as the same solid), `e2e/smoke.spec.ts` steps 5 and 5b (real browser: click the buttons and check the downloaded files), `e2e/export-partial.spec.ts` (a part with a failed feature is held back until confirmed). These run in CI on every PR and on main, and must never be removed or weakened (see [BACKUP_AND_SAFETY.md](BACKUP_AND_SAFETY.md)).
