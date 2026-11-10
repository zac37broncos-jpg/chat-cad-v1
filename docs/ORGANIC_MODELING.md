# Organic models and whole-model builds

Goal: when someone asks the chat for a whole object ("make an
Easter Island head", "a 6 inch figurine"), the AI should produce a smooth,
detailed, well proportioned model, quicker than modelling it by hand, without
ever cutting corners, and every step must stay an editable, named feature in
the tree. No mesh blobs.

## What was added

### Sketch splines (`kind: 'spline'`)
- A spline passes exactly through its points (like a mainstream CAD spline through
  fit points). Open splines are clamped cubic B-splines (The NURBS Book A9.1:
  chord-length parameters, knots by averaging). Closed splines are periodic
  cubic interpolants, C2 all the way round including the seam, written out as
  an unclamped B-spline over one period.
- `uniform: true` uses equal parameter steps instead of chord length, so
  generated sections with the same point count share one knot vector.
- `src/sketch/spline.ts` computes poles and knots in plain TypeScript; the
  kernel hands the very same poles/knots to OpenCascade (`Geom_BSplineCurve`),
  so the sketcher, the AI and the solid all use one curve (test: the two agree
  to 1e-9 mm at 51 points).
- A closed spline is a profile on its own; an open spline chains with lines,
  arcs and other splines at its end points. Extrude, revolve, sweep (profile or
  path), loft and rib accept them.
- Splines are not solver geometry yet: the constraint solver leaves them
  exactly as given and refuses relations/dimensions on them with a clear
  message. No mouse spline tool yet (sketcher follow-up); the chat creates them.
- AI entity shortcuts: `spline {points, closed}` and `oval {cx, cy, rx, ry,
  squareness, rotation}` (a closed uniform 24-point spline on an ellipse or
  superellipse; keeps parameter expressions, so an oval follows its parameters).

### Loft tips
`loft` takes optional `start_point` / `end_point`: the loft closes to a point
before the first / after the last section (domes, the crown of a head, a nose
tip, a tail). `start_tip` / `end_tip`: `point` (default, cone-like) or `round`
(a dome: the surface leaves the tip square to the body, smooth through the
pole).

### Exact smooth loft (`src/kernel/features/smoothLoft.ts`)
When every profile is one closed spline with equal parameter steps
(`uniform: true`, what ovals, loft_sections and profile_body make) with the
same point count, or every profile is one circle (tubes), the loft surface is
built directly instead of with OpenCascade's ThruSections:
- each section's poles are one row of a B-spline surface (periodic cubic for
  splines, the exact rational circle for circles), so every section lies
  exactly on the surface (test: section points within 1e-5 mm);
- rows are joined by shape-preserving cubic Hermite spans (Fritsch-Carlson
  slopes, chord-length spacing, C1 knots): the body never swings past its
  sections. A global C2 fit rippled +-1.6% along a straight tube ending in a
  dome; ThruSections next to a tip point overshot by up to 40% and took 28 s
  to integrate. Now a 19-section head integrates in about 1 s;
- round tips get end derivatives in the plane square to the body, so domes
  are smooth through the pole; loft_sections and tube add two dome sections
  (30 and 60 degrees round an ellipse) so the end is a true dome;
- two circles give an exact truncated cone (test).
Other profiles (lines, arcs, chord-length splines, mixed kinds) still use
ThruSections. Seam edges of closed faces are flagged in the mesh and not drawn.

### profile_body (`src/ai/organicTools.ts`)
Sculpt a body from its silhouettes: stations along an axis (Z upright, Y
front-to-back, X sideways), each giving the world extents there (x width,
y front/back, z bottom/top); a station may give only some values. Each value
is interpolated with monotone cubic (PCHIP, no overshoot) through the stations
that give it; sections are sampled evenly (`detail`, default 14) plus one at
every station, as 24-point superellipses (squareness per station,
front_squareness / bottom_squareness for the lower half). Ends flat, round
(two dome sections and a round tip) or point. Expands to ordinary named
section sketches and one loft.

### view_model (`src/render/snapshot.ts`)
The chat Claude can look at the part: an offscreen renderer draws the current
mesh from named views (front, right, three_quarter, ...) and the MCP server
returns them as real images. The prompt tells Claude to look after every
build stage and fix what is off before finishing.

### Organic shorthand tools (`src/ai/organicTools.ts`)
They only save typing; they expand into ordinary named features:
- `loft_sections {name, plane, sections:[{offset, oval | points}], start_point?, end_point?, operation?}`
  makes `<name> Section 1..n` sketches and the loft `<name>`.
- `tube {name, path:[[x,y,z],...], radius | radii, ends, start_end, finish_end, operation?}`
  makes one circle sketch square to the path at every path point (placed with
  an explicit sketch frame, rotation-minimizing so the loft does not twist),
  optional domed cap sections, and one smooth loft. For limbs, fingers,
  horns, tails, handles.

### build_model (`src/ai/batchTool.json`, `buildModel` in `src/ai/executor.ts`)
- Runs many tool calls in one request; each step goes through the normal tool
  path, so it makes the same named, editable features.
- Steps refer to earlier features by name (every tool now accepts a feature's
  exact name wherever it takes an id, `src/ai/refs.ts`).
- Fillet/chamfer edges and faces can be picked by feature: `{feature: name}`
  (all edges/faces that feature made) or `{between: [A, B]}` (edges where A
  meets B). No index lookups needed, and they become the usual persistent
  references.
- The part regenerates only when a step needs edges/faces, and once at the
  end. The report lists every new feature with ok/error, size and center, plus
  exact mass properties. It stops at the first failing step (what ran stays).

### Speed (kernel)
- Incremental regeneration (`RegenOptions.cache`, used by the worker): the
  unchanged start of the history (same units, parameters and feature JSON) is
  reused, so adding a feature only computes that feature.
- Worker caches mesh and mass per resulting shape, so the viewport and the chat
  asking for the same model compute them once. Chat regenerations skip the
  display mesh.
- Display meshing tolerance scales with part size (0.01 mm for small parts, up
  to 0.2 mm, about 1/4000 of the size): large organic parts meshed in seconds
  otherwise.
- MCP tool calls from the in-app chat get 15 minutes (per-server `timeout` in the generated MCP config, plus `MCP_TOOL_TIMEOUT`; the env var alone was not honoured, calls stopped at 60 s);
  Claude Code's default is 60 s, too short for a big build stage.

### Exactness fix
OpenCascade's volume integration is unreliable on "surfaces of linear
extrusion" of B-spline curves (0.25% off on a plain spline prism while
reporting an error of 1e-17; worse and up to 20 s per face once trimmed). So an
extrude whose profile has spline edges is built as a straight loft through
three equal copies of the profile (`splinePrism` in regen.ts): the same exact
geometry, but the side faces are true B-spline surfaces, which integrate
exactly and fast. Test: spline prism volume = Green's-theorem area x depth.

### Prompt (`bridge/system-prompt.md`)
Whole objects: plan like an expert who knows the subject (real proportions,
signature details, size, orientation with the face toward -Y, named regions
from big to small), then build in a few large `build_model` stages (main
masses, carved/added details, blends) and check each report before the next.
Quality first, never boxy: lofted sections for bodies, tubes for limbs,
revolved spline profiles for turned parts, smooth cuts for recesses, mirrors
for pairs, fillet blends where parts meet.

## Round 2: references and good parts (2026-11-04)

Review of round 1: the smoothness was right, but the Easter Island head
was not obviously a moai, and the bear could be better.
The chat must use references for subjects like these, and every part it makes
must be a good part: printable and ready for CAM software.

### Reference library (`src/ai/references.ts`, tool `get_reference`)
- Each entry is a reference sheet: real proportions, the signature details a
  viewer recognizes the subject by, and the common mistakes that make a model
  look wrong; plus the modelling technique.
- Subjects people ask for often have a worked example: a hand-built, checked
  `build_model` step list (`src/ai/references/moai.json`,
  `cartoon-bear.json`, inches) scaled to the requested height and units
  (`scaleSteps` scales numbers under length keys only).
- General guides: figure proportions, printable/machinable parts.
- Other subjects: in Claude Code mode the AI may use WebSearch and WebFetch
  (read-only; `bridge/hub.mjs`) to research the subject and write its own
  reference sheet before modelling.
- Prompt: reference first, then plan, build in stages, view_model and
  compare with the reference sheet detail by detail, then the quality check.

### Checked booleans (`checkedBool` in `src/kernel/regen.ts`)
OpenCascade sometimes returns a wrong boolean with no error. Found while
building the bear: the head and body (same axis, both seams on +X) came back
as two unjoined solids, and the next feature then dropped the head entirely.
Every add/cut on the part body is now verified:
- the volume it changed must equal the tool's volume outside (add) or inside
  (cut) the body, measured by a separate intersection. The change is
  integrated only over the faces that differ between the body before and
  after (shared faces cancel exactly), against a fixed plane, with
  Gauss-Kronrod; a near miss is re-measured at 1e-8. Whole-body integration
  is not good enough here: on the moai it varied by 5e-4 of the volume
  between precisions, which looked like a 40 mm^3 error on a 517 mm^3 eye
  socket that was actually cut correctly;
- the cut or added piece must leave some of its own faces in the result, and
  the result must have no edge with only one face (a hole in the skin);
- extra solids are allowed only where a piece really does not touch the
  body. Separate bodies, cuts that split the part and hidden hollows are valid
  modelling (mainstream CAD allows multibody parts), so they are not errors: the
  feature gets a note (warning badge in the tree, `message` in the chat's
  reports) and the part quality check fails until they are fixed.
Kernel failures raise `BooleanFailure`. Smooth lofts then rebuild with the
seam elsewhere (the surface is identical, only where its closed direction
starts moves) and try again; mirrors and patterns of lofts try the same
variants. Each loft's starting seam is stored in the document when the loft is
made (`seam`, a fraction of a turn: the golden-ratio sequence 0, 0.618, 0.236,
... by how many lofts the part already has; `src/core/loftSeam.ts`), so the
same steps always build the same faces. Documents saved before 2026-11-06 have
no `seam` and keep the old seam from a hash of the loft's id.

### Part quality check (`src/kernel/quality.ts`, tool `check_part`)
Runs at the end of every `build_model` and on demand. Problems: not exactly
one solid, hidden hollows, invalid or open B-rep, STL mesh not watertight
(same meshing as the export, vertices welded), STEP export not reading back as
the same solid. Warnings: very short edges or sliver faces, loose
tolerances, no flat base or centre of mass outside it, large overhangs.

### STEP export fix (`stepReady` in `src/kernel/query.ts`)
A closed organic face running from pole to pole (an ear with two round ends)
with several holes cut in it is legal in OpenCascade, but STEP describes its
outer boundary only by vertex loops and importers rebuilt the wrong region
(the moai's ears came back as three solids). Such faces are split along their
middle ring for export only: same surface, one extra edge.
