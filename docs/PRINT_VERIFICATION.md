# Are CHAD's parts printable and precise? (independent check)

## CHAD, 2026-11-10: the same check run on CHAD, with three printer-owner parts added

**Yes.** CHAD was checked with the same outside tools as the first check on 2026-11-06 (described below), on CHAD's own code.

- **21 test parts, 168 files, 1,586 checks: 1,585 pass.** The 18 parts below plus three things printer owners make:
  - **16, desk organiser** (the CHAD demo part, 150 x 80 x 90 mm): parameters with formulas, outside R6 and inside R3.6 corner rounds, a pocket, two dividers fused flush with the walls. Volume matches the hand calculation to 4 parts in 10<sup>16</sup>.
  - **17, phone stand**: a 20° lean typed as an angle parameter and `tan(lean)` in the sketch, slanted faces, a Ø10 cable hole. Volume matches the hand calculation to 2 parts in 10<sup>16</sup>; the hole is within 0.0012 mm of Ø10 at Fine.
  - **18, vase**: a spline profile revolved and shelled 2 mm with the top open (a free-form surface and its offset). Within the setting at every quality.
- **Every STL** is one closed, watertight solid with its triangles facing out and none crossing; ADMesh repaired nothing; PrusaSlicer sliced all 21 Fine files. The inch files hold exactly 1/25.4 of the mm files.
- **Precision at Fine (0.01 mm):** every file within 0.01 mm of the exact model (except the joints of part 14b, as before: 0.017 mm, the model's own joint accuracy of 0.019 mm, shown in the app's Note). Holes within 0.0026 mm of their design size.
- **STEP:** all 63 files read back as one valid closed solid each, volume within 3.5 parts in 10 million. **No face in any of the 63 files lies past its surface's parameter range** (the "p-curves one period past" risk did not occur in any CHAD part).
- **The one check that did not pass** is part 14b at Extra fine (0.005 mm), the Easter Island head with the seams of an old build. Near one joint, one measured point is 0.0086 mm from the file. It was traced (verify/print, 2026-11-10): it lies where two of the model's own faces meet with a 0.019 mm gap (the joint the app's Note reports); the file's corners there sit on the joint edge, 0.017 to 0.019 mm off the neighbouring face's surface, exactly as at the 54 other points at that joint which the checker does put down to the joint. The checker only excuses a point by the corners of the one face it picks as the point's own, and here it picked the other face of the joint. The rule was left as strict as it is (checks are never weakened), so this stays listed as a failed check. It is far inside the 0.127 mm promise, and parts built today (part 14, same head) have joints under 0.001 mm and pass everything.
- **Found and fixed: Mass Properties area and volume on organic parts.** Not in the files, in the numbers the Mass Properties panel and the AI chat show. On faces of a smooth loft that run past the end of their surface's parameter range, the geometry engine's plain integration is wrong while it reports a tiny error: the Easter Island head showed its surface area 0.58 mm² too large (1.5 mm² with the old seams) and its volume up to 4.5 mm³ (0.001%) too large. An independent calculation (quadrature of the exact surface, written for this check, exact to 14 digits on planes, cylinders, cones and a torus) found it. Now such faces get their area from that independent calculation and the part's volume from the slower Gauss-Kronrod integration, which is right there. Both builds of the head now give 34735.60 mm² (reference 34735.59) and 357259.10 mm³ (reference 357259.10). Parts without such faces, every prismatic part, are computed exactly as before. Guarded by `tests/mass-area.test.ts`, which fails on the old code. On such organic parts Mass Properties now takes about 25 s instead of 10 s (only while the panel is open).

The complete list of every check: [verify/print/RESULTS-2026-11-10-chad.md](../verify/print/RESULTS-2026-11-10-chad.md).

| # | Part | Checks passed | Distance from the model, Draft / Fine / Extra fine (mm; settings 0.05 / 0.01 / 0.005) | PrusaSlicer layers |
|---|---|---|---|---|
| 01 | Plate with holes | 85/85 | 0.0068 / 0.0008 / 0.0003 | 63 |
| 02 | Block with rounds and a chamfer | 76/76 | 0.0262 / 0.0036 / 0.0015 | 127 |
| 03 | Flange with a bolt circle | 85/85 | 0.0246 / 0.0050 / 0.0025 | 32 |
| 04 | Revolved ring (torus) | 76/76 | 0.0380 / 0.0065 / 0.0030 | 317 |
| 05 | L mounting bracket | 85/85 | 0.0236 / 0.0026 / 0.0009 | 290 |
| 06 | Hole gauge | 85/85 | 0.0128 / 0.0014 / 0.0005 | 50 |
| 07 | Countersink and tapped hole | 85/85 | 0.0263 / 0.0033 / 0.0013 | 127 |
| 08a | Shelled box, 0.1 in walls | 76/76 | 0.0000 / 0.0000 / 0.0000 | 254 |
| 08b | Thin-wall cup, 0.8 mm walls | 76/76 | 0.0000 / 0.0000 / 0.0000 | 100 |
| 09 | Drafted boss | 76/76 | 0.0000 / 0.0000 / 0.0000 | 127 |
| 10 | Swept rod | 73/73 | 0.0317 / 0.0060 / 0.0029 | 394 |
| 11 | Skipped hole pattern and mirrored boss | 85/85 | 0.0076 / 0.0009 / 0.0003 | 190 |
| 12 | Organic figure | 66/66 | 0.0488 / 0.0099 / 0.0049 | 274 |
| 13 | Sculpted body with an arm | 66/66 | 0.0494 / 0.0099 / 0.0049 | 434 |
| 14 | Easter Island head (as built today) | 66/66 | 0.0408 / 0.0098 / 0.0049 | 777 |
| 14b | Easter Island head (old hard seams) | 65/66 | 0.0482 / 0.0174 / 0.0151 (joints, see above) | 777 |
| 15 | Cartoon bear (as built today) | 66/66 | 0.0487 / 0.0099 / 0.0049 | 563 |
| 15b | Cartoon bear (old hard seams) | 66/66 | 0.0491 / 0.0099 / 0.0049 | 563 |
| 16 | Desk organiser (CHAD demo part) | 76/76 | 0.0129 / 0.0014 / 0.0005 | 450 |
| 17 | Phone stand, 20° angle formula | 85/85 | 0.0107 / 0.0012 / 0.0004 | 530 |
| 18 | Vase, spline revolve, shelled | 66/66 | 0.0483 / 0.0100 / 0.0050 | 321 |

Still not provable by software (unchanged): a real print, and opening the STEP files in a commercial CAD or CAM program. The print test at the end of this page applies to CHAD as it is.

---

# The first check (2026-11-06)

This first check was run on the geometry and export code that CHAD shares with the engineering edition it was split from. The fixes it led to are part of CHAD.


## The short answer

**Yes, as far as software can show.** All 144 files of the 18 test parts passed every one of the 1,359 checks. They were judged by outside tools that share no code with CHAD.

- **Printable.** Every STL file is one closed solid with its triangles facing out and none crossing each other. ADMesh (the repair tool inside PrusaSlicer) found nothing to repair, and PrusaSlicer sliced all 18 Fine files to G-code.
- **Precise.** At Fine (0.01 mm) every file is within 0.01 mm of the exact model, and every hole is within 0.003 mm of its design size. That is about 1/13 of CHAD's 0.005 in (0.127 mm) promise, and at most 1/10 of what a good FDM printer can hold.
- **One exception, explained.** The Easter Island head with hard seams is made of joined bodies. In the model itself, its joint edges sit up to 0.019 mm off their faces. The file follows the model there (0.018 mm at Fine), the app says so in a Note, and the checker found the same 0.019 mm on its own.
- **STEP.** All 54 files read back as one valid closed solid each, with the volume right to 4 parts in 10 million or better, and every hole an exact cylinder.
- **Fixed on the way.** The check found six real problems in the STL export. All are fixed and guarded by automatic tests (see below).
- **Not proven yet.** A real print, and opening the STEP files in a commercial CAM or CAD program. The print test procedure is at the end.

## What was checked, and how

CHAD's export already checks every file before it saves it. That check is CHAD's own code, though, so a mistake in it could hide a mistake in the file. This verification uses only **outside tools that share no code with CHAD** to judge the files, the same way a print shop or a CAM programmer would.

**The test set** has 18 parts. Each one stands for something real parts need, and each simple part has a hand-calculated volume, size, hole list and thinnest wall:

| # | Part | What it tests |
|---|---|---|
| 01 | Plate with holes (4 x 2 x 0.5 in) | scale (4 in = 101.6 mm), sketch cut through all, small holes |
| 02 | Block with R0.25 rounds and a 0.1 chamfer (4 x 2 x 1 in) | fillets (cylinders), chamfer following tangent edges |
| 03 | Ø4 in flange, six #10 holes on a Ø3 bolt circle | hole, circular pattern, round outline |
| 04 | Revolved ring (torus R1 x r0.25 in) | revolve, doubly curved surface (torus) |
| 05 | L mounting bracket (demo part, mm) | parameters, linear pattern of ISO holes, hole on a vertical wall, fillet between two bodies |
| 06 | Hole gauge: Ø1 to Ø12 and an M6 counterbore (mm) | small holes (worst case for STL flats), counterbore |
| 07 | Countersink #10 and tapped 1/4-20 blind hole (4 x 2 x 1 in) | cones (countersink, drill point), blind hole |
| 08a | Shelled box, open top, 0.1 in walls (4 x 3 x 2 in) | shell (open top), 0.1 in walls: thin-wall check |
| 08b | Thin-wall cup, open top, 0.8 mm walls (40 x 30 x 20 mm) | shell (open top), 0.8 mm walls: thin-wall check |
| 09 | Drafted boss (1 in cube, 5° draft) | draft, inclined planes |
| 10 | Swept rod: Ø0.2 in along a line and an R2 arc | sweep (pipe) along a line and an arc |
| 11 | Plate with a skipped hole pattern and a mirrored boss (in) | linear pattern with skip, mirror feature, separate-looking bosses on one body |
| 12 | Organic figure from the chat (spline loft, nose, blend fillet, mm) | B-spline loft to a point, boolean with a cylinder, variable blend |
| 13 | Sculpted body with an arm tube (chat sculpting tools, in) | free-form faces joined along a curve (hardest case for meshing) |
| 14 | Easter Island head (chat example, as built today) | the chat's worked organic example as the chat builds it today: many lofts, mirrors, booleans |
| 14b | Easter Island head (recorded hard seams) | the chat's worked organic example with the seams of a build that once failed (hard case): many lofts, mirrors, booleans |
| 15 | Cartoon bear (chat example, as built today) | the chat's worked organic example as the chat builds it today: many lofts, mirrors, booleans |
| 15b | Cartoon bear (recorded hard seams) | the chat's worked organic example with the seams of a build that once failed (hard case): many lofts, mirrors, booleans |

**The files.** Each part was exported the way the app does it, with 8 files per part and 144 in all:

- STL in millimeters, binary, at Draft (0.05 mm), Fine (0.01 mm) and Extra fine (0.005 mm).
- The Fine STL also as ASCII, and again in inches.
- STEP AP214 in the part's own unit, AP214 in the other unit, and AP242 in mm.

**The tools** (versions as installed for this run):

| Tool | What it judged |
|---|---|
| Own STL reader (Python, numpy) | File structure byte by byte; every edge shared by exactly two triangles; stored normals match the winding |
| trimesh 5.2.0 | Watertight, consistent winding, a real volume; surface sampling; ray casting for wall thickness |
| Manifold 3.5.4 (Google's solid geometry library) | Accepts the mesh as a solid; counts its through-holes |
| MeshLab (pymeshlab 2025.7) | Open and non-manifold edges, **triangles passing through other triangles**, separate pieces |
| ADMesh 0.98.5 | The STL repair tool that PrusaSlicer is built on: must find nothing to repair |
| PrusaSlicer 2.7.2 | Reads each file (manifold, size), and **slices it to real G-code** (0.2 mm layers, 0.4 mm nozzle) |
| OpenCascade 7.8 for Python (cadquery-ocp) | A different build and version of the geometry kernel: reads each STEP file and judges validity, volume, size and exact hole cylinders |
| Own STEP text reader | Reads the ISO 10303-21 text with no CAD library: schema, unit, precision, hole radii |

**Precision is measured, not assumed.** For every mm binary STL:

- The STL surface was compared with the exact solid in the STEP file both ways: from the file to the solid, and from the solid to the file. This gives the two-sided Hausdorff distance, which is the largest gap in either direction.
  - Up to 400,000 points on the file and 300,000 on the solid were first compared with a very fine mesh of the solid, which is within a known distance of the true surface.
  - Then every point that could possibly be over the setting, allowing for that known distance, was measured **exactly** against the true surface (at least the worst 800 in each direction). So no point can hide a larger gap behind the fine mesh.
- Every hole was cut with a plane and measured.
- Walls were measured by ray casting.

## Results

| # | Part | Checks passed | Distance from the model, Draft / Fine / Extra fine (mm; settings 0.05 / 0.01 / 0.005) | Worst hole size error at Fine (mm) | PrusaSlicer layers |
|---|---|---|---|---|---|
| 01 | Plate with holes (4 x 2 x 0.5 in) | 85/85 | 0.0068 / 0.0008 / 0.0003 | 0.0008 | 63 |
| 02 | Block with R0.25 rounds and a 0.1 chamfer (4 x 2 x 1 in) | 76/76 | 0.0262 / 0.0036 / 0.0015 | - | 127 |
| 03 | Ø4 in flange, six #10 holes on a Ø3 bolt circle | 85/85 | 0.0246 / 0.0050 / 0.0025 | 0.0007 | 32 |
| 04 | Revolved ring (torus R1 x r0.25 in) | 76/76 | 0.0380 / 0.0065 / 0.0030 | - | 317 |
| 05 | L mounting bracket (demo part, mm) | 85/85 | 0.0236 / 0.0026 / 0.0009 | 0.0026 | 290 |
| 06 | Hole gauge: Ø1 to Ø12 and an M6 counterbore (mm) | 85/85 | 0.0128 / 0.0014 / 0.0005 | 0.0014 | 50 |
| 07 | Countersink #10 and tapped 1/4-20 blind hole (4 x 2 x 1 in) | 85/85 | 0.0263 / 0.0033 / 0.0013 | 0.0007 | 127 |
| 08a | Shelled box, open top, 0.1 in walls (4 x 3 x 2 in) | 76/76 | 0.0000 / 0.0000 / 0.0000 | - | 254 |
| 08b | Thin-wall cup, open top, 0.8 mm walls (40 x 30 x 20 mm) | 76/76 | 0.0000 / 0.0000 / 0.0000 | - | 100 |
| 09 | Drafted boss (1 in cube, 5° draft) | 76/76 | 0.0000 / 0.0000 / 0.0000 | - | 127 |
| 10 | Swept rod: Ø0.2 in along a line and an R2 arc | 73/73 | 0.0317 / 0.0060 / 0.0029 | - | 394 |
| 11 | Plate with a skipped hole pattern and a mirrored boss (in) | 85/85 | 0.0076 / 0.0009 / 0.0003 | 0.0009 | 190 |
| 12 | Organic figure from the chat (spline loft, nose, blend fillet, mm) | 66/66 | 0.0488 / 0.0099 / 0.0049 | - | 274 |
| 13 | Sculpted body with an arm tube (chat sculpting tools, in) | 66/66 | 0.0494 / 0.0099 / 0.0049 | - | 434 |
| 14 | Easter Island head (chat example, as built today) | 66/66 | 0.0407 / 0.0097 / 0.0049 | - | 777 |
| 14b | Easter Island head (recorded hard seams) | 66/66 | 0.0482 / 0.0181 / 0.0154 | - | 777 |
| 15 | Cartoon bear (chat example, as built today) | 66/66 | 0.0487 / 0.0099 / 0.0049 | - | 563 |
| 15b | Cartoon bear (recorded hard seams) | 66/66 | 0.0488 / 0.0099 / 0.0049 | - | 563 |

How to read this table:

- **Distance from the model** is the two-sided Hausdorff distance between the STL file and the exact solid: the largest gap anywhere, in either direction. It is at or under the setting in every file except the joints of part 14b (next point).
- **Part 14b** at Fine and Extra fine: every point over the setting (65 at Fine, 54 at Extra fine) lies within one triangle of a file corner that is itself off the exact surface by at least the excess. Those corners sit on the model's joint edges, which are up to 0.0191 mm off their faces in the model itself. The checker measured that 0.0191 mm on its own, and it is the same number the app shows in its Note. Away from the joints, the file is within the setting there too.
- **Flat parts** (08a, 08b, 09) have only planes, so their files are exact (0.0000).
- **Hole size error** is the worst difference between a hole's design diameter and the file's polygon, cut by a plane through the hole. A dash means the part has no plain round holes to measure.
- **Checks passed** differs between parts because parts with holes get the hole checks. Where there is no hand calculation (the swept rod's size, and the organic parts' size and volume), the files are compared with the exact model instead.

The complete list of every check and its numbers is in [verify/print/RESULTS-2026-11-06.md](../verify/print/RESULTS-2026-11-06.md).

## How this compares with industry standards

There is no single standard that says "a CAD program's STL file must be this accurate". The norms that apply are the STL format's own rules, general machining tolerances, and what print services publish for each printing process. CHAD is held to its own rule as well: every dimension within 0.005 in (0.127 mm).

| Norm | What it asks | CHAD's files |
|---|---|---|
| **STL format rules** (3D Systems, *StereoLithography Interface Specification*, 1989; text at fabbers.com) | Every triangle's normal points out of the solid, and its corners run counterclockwise seen from outside. Each triangle shares two corners with each neighbor ("vertex-to-vertex rule"). | **Followed by every file.** In all 90 STL files, every stored normal agrees with its triangle's corner order to within 0.02°, and points out of the solid. Every edge is shared by exactly two triangles, no triangle has zero area, and ADMesh fixed nothing. |
| | All coordinates positive (the part in the "all-positive octant"). | **Not followed, on purpose.** CHAD writes the part where it was modeled, which is what current CAD programs do. PrusaSlicer sliced every file and places the part on the bed itself. Moving the part into that octant could become an optional export setting. |
| | The file has no units. | mm by default, with the unit written in the file header. The inch file was checked to be exactly 1/25.4 of the mm file. |
| **Conversion accuracy** (Stratasys, *Best Practice: Converting CAD to STL*, 2015) | No single number. Its example setting for Solid Edge is a 0.001 in (0.0254 mm) conversion tolerance. | **Tighter.** At Fine every file is within 0.01 mm (0.0004 in) of the exact model, 2.5 times tighter than that example. The one exception is the joints of the hard-seam head (0.018 mm, still tighter). Extra fine (0.005 mm) is 5 times tighter. |
| **ISO 2768-1 general tolerances**, fine class "f" (amesweb.info table) | ±0.05 mm for sizes 0.5 to 6 mm, ±0.1 mm for 6 to 30 mm, ±0.15 mm for 30 to 120 mm, ±0.2 mm for 120 to 400 mm. | At Fine, the file is within 0.01 mm of the model. That is 1/5 of the tightest fine-class tolerance and 1/20 of the 120 to 400 mm range, so the file uses up very little of any tolerance. Draft (0.05 mm) uses up the whole ±0.05 mm band on small features: use Fine for parts with toleranced small features. |
| **Printer accuracy** (Hubs design guide) | FDM about ±0.1 to 0.2 mm; SLS about ±0.3 mm. | The Fine file error (0.01 mm) is at most 1/10 of the best FDM accuracy, so what you measure on a print is the printer, not the file. |
| **Minimum walls** (Hubs design guide) | FDM 0.8 mm; SLA 0.5 mm supported / 1.0 mm unsupported; SLS 0.8 mm / 1.0 mm. | **Kept exactly.** The 0.8 mm cup measures 0.800 mm and the 0.1 in box 2.540 mm in every STL, so the file does not thin a wall. The cup is exactly at the FDM minimum, on purpose. Right at sharp edges, ray casting reads almost no thickness (a ray that starts next to an edge leaves through the neighboring face), so the 1st percentile is reported. On the organic heads and the bear, up to 0.2% of the points read under 0.8 mm, at sharp creases and tips. CHAD does not warn about thin walls yet; that is on the roadmap ([CHAD_SCOPE.md](CHAD_SCOPE.md), printability checks). |
| **STEP** (ISO 10303-21 file format, AP214 and AP242) | A valid file of that schema with its unit, describing a closed solid. | **All 54 STEP files pass.** A different build of OpenCascade (7.8, Python) reads each one as a single valid closed solid with no open edges. The header names the schema (AP214 or AP242) and the unit. The volume matches the model to 1 part in 10<sup>12</sup> on simple parts and 3.5 in 10 million on organic ones. The size matches to 0.0000001 mm, and every hole is an exact cylinder of its design radius (largest error 0.00000000001 mm). Not yet opened in a commercial reader (see below). |
| **ISO/ASTM 52900:2021** (additive manufacturing vocabulary) and **ISO/ASTM 52902:2023** (test artifacts for measuring a printer's geometric capability) | 52902 defines test pieces and what to measure on them, to judge a printer. | These judge printers, not files, so they cannot be "passed" by software. The hole gauge and the L-bracket below follow the same idea (known holes and distances, measured after printing). A formal 52902 test print would be the next step to rate a specific printer. |

Sources (read 2026-11-06):

- STL specification: https://fabbers.com/tech/STL_Format
- Stratasys guide: https://www.secs.oakland.edu/~latcha/ME4999/Converting%20CAD%20To%20STL%20-%20EN%20FDM%20Best%20Practice.pdf
- ISO 2768-1 table: https://amesweb.info/fits-tolerances/iso-2768-linear-dimensions-tolerances.aspx
- Hubs wall thickness and accuracy: https://www.hubs.com/knowledge-base/dfm-tips-for-3d-printed-parts-with-thin-walls/
- ISO/ASTM 52902:2023: https://www.iso.org/standard/79683.html
- ISO/ASTM 52900:2021: https://www.boutique.afnor.org/en-gb/standard/iso-astm-529002021/additive-manufacturing-general-principles-fundamentals-and-vocabulary/xs132603/330601

The standards themselves (ISO 2768, the ISO/ASTM documents) are paid documents and were not read in full. The numbers above come from the public tables and summaries linked.

## Problems this check found, and what was fixed

The independent tools found six real problems in how CHAD wrote STL files. CHAD's own check had passed all of them. All six are fixed, and new automatic tests guard them (`tests/stl-mesh-quality.test.ts`).

1. **Triangles crossing through other triangles.**
   - Where: organic models (MeshLab: "self-intersecting faces"). The Easter Island head had 14 at the nostrils at Draft, and 28 with an older build.
   - Why it happened: a sharp spot thinner than the resolution, or the mesher putting a few triangles past a face's real border.
   - Effect: slicers usually print such a file anyway, but the file is not exactly the part.
   - Now: every export checks for crossings, with the same counts as MeshLab. It meshes the part again finer if any cross, and saves nothing if any remain.
2. **Joined organic bodies could not be saved at Fine.**
   - Where: an organic head with joined bodies. The joint edge lies up to 0.019 mm off its faces. This is the geometry kernel's own accuracy where two curved surfaces meet, and no finer mesh can change it.
   - What went wrong: the exporter counted that as mesh error. It meshed ever finer (1.26 million triangles, almost 3 minutes) and then refused to save.
   - Now: the joint is measured against the model's own edge, and its accuracy is shown as a **Note** in the Export STL panel. It would be a problem only if it ever went over the 0.005 in (0.127 mm) promise.
   - A correction found later the same night: the first version of this fix took the edge's tolerance (0.036 mm) as the joint's distance from its faces. Part of that tolerance is only a mismatch inside the model's bookkeeping (the edge's curve drawn on the face versus its curve in space). So the app allowed too much, and the independent check found gaps of up to 0.018 mm next to the joints that the app had excused. Now each mesh corner's real distance to the surface is measured (0.019 mm at most on that head), and only that is allowed for.
3. **Extra fine never finished on that head.**
   - What went wrong: the way long thin triangles were split never made them shorter. The part was meshed again and again until the geometry engine ran out of memory.
   - Now: it splits the longest side first, a standard method from mesh refinement (Rivara). The head now saves at Extra fine in two passes, in about 3 minutes (see problem 5 for why it takes two).
4. **Crossing triangles at points where a surface comes to a tip.**
   - Where: the drill point of a tapped hole (23 to 221 crossing triangles in an earlier build) and the tips of organic lofts.
   - What went wrong: halfway between the tip and another point was worked out in a way that lands on the far side of the tip.
   - Now: tips are handled on their own.
5. **A few triangles were up to 9% over the setting, in the middle of a triangle or partway along a side.**
   - Where: organic faces. Part 12 at Extra fine was 0.00503 mm from the true surface (setting 0.005), and the Easter Island head up to 0.0546 mm at Draft (setting 0.05). Still far inside the 0.127 mm promise, but over what the panel said.
   - What went wrong: each triangle was measured only at the middle of its sides and its center. On organic surfaces the curvature changes inside a triangle, so the largest gap can sit elsewhere, for example at 3/8 of a side.
   - Now: every triangle on a curved face is measured at 12 points (a 4 × 4 grid inside it). A smooth curve is fitted through them, and the difference between that curve and a simpler one is added as a safety margin, so a gap between the points is not missed. The face's border lines are measured the same way against their exact edge curves. This found real gaps of up to 0.0059 mm on the head's border lines at Extra fine. That is why that part now needs a second, finer pass.
6. **A part made of separate bodies was saved without a word.**
   - Where: a mirrored feature that does not touch the original part (found when one of the test parts was built that way by mistake).
   - Effect: the file is valid, but the slicer prints two objects, and one may be in the air.
   - Now: the Export STL panel shows a Note: "This part is N separate bodies that do not touch each other..."

Smaller fixes:

- The inch file now holds exactly the same triangles as the mm file. Before, the safety margin for number rounding depended on the unit, so a few triangles differed.
- The distance-to-surface steps can no longer overshoot on unevenly built surfaces.
- In the checker itself: the wall measurement and the surface comparison now work in pieces (they needed more than 13 GB and 9 GB of memory on the ring and the head). The model volume used as the reference is now worked out 1,000 times more tightly. The old reference was 2 parts per million low on part 13, while the STEP file itself was right.
- One test part was wrong, not the app: the mirrored boss of part 11 was first mirrored about a plane that put the copy in the air. The checker caught it (2 bodies), the part was fixed, and that is how problem 6 was found.

## What software cannot prove (and how to close the gap)

Everything above is about the files. These things cannot be shown by software, so they are still open:

1. **A real print.**
   - How close a print comes to the file depends on the printer, the filament and the slicer settings.
   - The files are exact enough that any error you measure comes from the printer (see the standards table).
   - The test below closes this.
2. **A real import into commercial CAM or CAD software.**
   - The STEP files are read correctly by a second, different OpenCascade, and their text follows ISO 10303-21.
   - A strict commercial reader could still object to something OpenCascade accepts. One known candidate: curves stored one turn past their surface on about 1 in 12 organic head builds in the first check (they read back correctly in OpenCascade, and none occurred in the 2026-11-10 check).
   - Opening the L-bracket and the head STEP files in such a program once closes this.
3. **Other slicers.**
   - Only PrusaSlicer 2.7 was run here. Bambu Studio and OrcaSlicer are built from the same code family, and Cura is separate.
   - The files are plain, valid STL, so any of them should read them. Check the size the first time (step 3 below).
4. **Organic accuracy at joints.**
   - Where two organic bodies are joined, the model itself is exact only to its joint tolerance (0.019 mm on the hard-seam head; under 0.001 mm on the heads as built today).
   - The file follows the model there, and the panel says so in a Note. That is under 1/6 of the 0.005 in (0.127 mm) promise.

## The real print test

This needs about 2 hours of printing and a pair of calipers. It checks the two things software cannot: your printer, and the whole path from CHAD to a real part.

**Files** (make them with `npm run verify:print:export`, which writes them to `verify/print/out/<part>/`; or build the parts in CHAD and use Export STL at Fine):

- `06-hole-gauge-fine-mm-binary.stl`: a 90 × 20 × 10 mm bar with holes Ø1, Ø2, Ø3.4 (M3 clearance), Ø6.6 (M6 clearance), Ø12, and an M6 counterbore (Ø11 × 6 deep over Ø6.6).
- `05-l-bracket-fine-mm-binary.stl`: the demo L-bracket, 100 × 60 × 58 mm, with four Ø6.6 holes, a Ø22 hole in the wall and an R6 inside round.
- The matching `.step` files, to try in a CAM or CAD program.

**Steps**

1. Open your slicer and drag in `06-hole-gauge-fine-mm-binary.stl`.
2. If the slicer offers to **repair** the file, say no, and note it. It should not need repair.
3. **Check the size** the slicer shows: **90.0 × 20.0 × 10.0 mm**. If it shows about 3.5 × 0.8 × 0.4, the file was read as inches: stop and check the slicer's unit setting.
4. Print it flat as it comes in (holes pointing up). Use normal settings: 0.2 mm layers, 3 walls (perimeters), 20% infill, no supports.
5. Do the same with `05-l-bracket-fine-mm-binary.stl`. The size is **100.0 × 60.0 × 58.0 mm**. Print it as it comes in, with the base on the bed and the wall standing up, no supports. The top of the Ø22 hole is a small overhang and may droop slightly; that is normal.
6. Let the parts cool for 10 minutes, then measure with calipers. Write the numbers in the "You measured" column.

| Part | What to measure | Designed (mm) | You measured |
|---|---|---|---|
| Hole gauge | Length | 90.00 | |
| Hole gauge | Width | 20.00 | |
| Hole gauge | Height | 10.00 | |
| Hole gauge | Ø12 hole (inside jaws) | 12.00 | |
| Hole gauge | Ø6.6 hole | 6.60 | |
| Hole gauge | Ø3.4 hole | 3.40 | |
| Hole gauge | Ø2 and Ø1 holes: does a 2 mm / 1 mm drill bit shank go through? | yes / yes | |
| Hole gauge | Counterbore: Ø and depth | 11.00 and 6.00 | |
| Hole gauge | Centers of the Ø6.6 and Ø12 holes (hole edges outside-to-outside, minus half of each hole) | 18.00 | |
| L-bracket | Length × depth × height | 100.00 × 60.00 × 58.00 | |
| L-bracket | Base thickness; wall thickness | 8.00; 8.00 | |
| L-bracket | Mounting hole centers, left to right; front to back | 80.00; 30.00 | |
| L-bracket | Ø6.6 holes | 6.60 | |
| L-bracket | Ø22 wall hole; bed to bottom of that hole | 22.00; 22.00 | |
| L-bracket | Does an M6 screw pass the Ø6.6 holes? Does an M6 socket head sit in the counterbore, flush or below? | yes; yes | |

**What is normal for an FDM printer**

- Outside sizes within about ±0.1 to 0.2 mm (Hubs).
- Holes usually come out a little **small**, because the plastic squeezes inward. One published example: a 10 mm hole measured 9.8 mm (Kingroon, about OrcaSlicer's X-Y Hole Compensation setting).
- Small holes (Ø1, Ø2) may close up or need a drill. That is the printer and the nozzle size (0.4 mm), not the file.

**What would point to CHAD instead**

- A size off by a factor, for example 25.4 times.
- A missing or extra feature.
- A slicer repair prompt.
- Errors much bigger than ±0.3 mm on outside sizes.

If anything like that happens, please open an issue with what you saw.

## How to run this check again

On a Linux machine (one time, about 5 minutes):

```
verify/print/setup.sh
```

Then, from the repository folder:

```
npm run verify:print
```

This exports the 21 parts (about 17 minutes), then checks every file (about 1.5 hours), and writes `verify/print/out/RESULTS.md`.

- To check only some parts, add their numbers, for example `VERIFY_PARTS=05,06 npm run verify:print:export` and then `verify/print/.venv/bin/python verify/print/check_parts.py --parts 05,06`.
- Run the export and the check one after the other, not at the same time: together they need more than 16 GB of memory.
- This is not part of `npm test`, because it needs the outside tools. The STL problems it found are guarded in `npm test` by `tests/stl-mesh-quality.test.ts` and `tests/export.test.ts`.
