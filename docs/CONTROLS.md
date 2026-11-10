# CHAD controls

CHAD uses the mouse and keyboard conventions common to professional CAD programs, so people coming from other CAD tools feel at home. Two other mouse layouts (right button rotates, or Shift + middle button rotates) are in **Options** (gear icon, top left).

## Mouse (default layout: middle button rotates)
| Action | Mouse |
|---|---|
| Rotate | Middle-drag |
| Rotate about a point | Middle-click the point, then middle-drag |
| Pan | Ctrl + middle-drag |
| Zoom | Shift + middle-drag, or the wheel (zooms at the pointer) |
| Roll (rotate in the screen plane) | Alt + middle-drag |
| Zoom to fit | Double-click the middle button |
| Select | Left-click; Ctrl-click adds/removes |
| Context menu | Right-click a face, edge, plane, empty space or tree item |
| Laptop trackpad (any preset) | Alt+drag rotate, Alt+Shift+drag pan, Alt+Ctrl+drag zoom |

Roll the wheel toward you to zoom in. Tick "Reverse mouse wheel zoom direction" in Options to flip it.

View changes (standard views, Normal To, Zoom to Fit, Previous View) turn smoothly. Untick "Animate view changes" in Options to make them instant. While you drag the view the pointer shows what the drag does (rotate, pan or zoom).

## Keyboard
| Key | Does |
|---|---|
| Ctrl+1 … Ctrl+7 | Front, Back, Left, Right, Top, Bottom, Isometric |
| Ctrl+8 | Normal To the selected plane / flat face / sketch (nothing selected: nearest standard view; again: flips) |
| Shift+1 … Shift+8 | Same as Ctrl+1…8 (fallback) |
| Space | View orientation menu |
| F | Zoom to fit |
| Z / Shift+Z | Zoom out / in |
| Arrow keys | Rotate 15° (Shift: 90°) |
| Ctrl+arrow keys | Pan |
| Alt+Left / Alt+Right | Roll 15° |
| Ctrl+Shift+Z | Previous view |
| S | Shortcut bar at the pointer |
| W | Search all commands |
| Enter | OK in the open panel, otherwise repeat the last command |
| Esc | Cancel the open panel / clear the selection |
| Delete | Delete the features selected in the tree |
| F2 | Rename the selected tree item |
| Ctrl+Z / Ctrl+Y | Undo / Redo (the status bar says which step; waits until an open feature panel is closed with OK or Cancel). The last 200 steps are kept (fewer only for a very large part, never fewer than 20); a whole Claude request or sketch edit counts as one step |
| Ctrl+B or Ctrl+Q | Rebuild |
| Ctrl+S / Ctrl+O | Save / Open a part file |

Chrome keeps Ctrl+N, Ctrl+T and Ctrl+W for itself, so use the New button. The desktop app version (later) will free those keys.

## In a sketch
These single-letter sketch keys are CHAD's own. View keys above keep working.

| Key / mouse | Does |
|---|---|
| L / R / C / A / P | Line, Corner Rectangle, Circle, 3-Point Arc, Point |
| (panel) Slot | Straight Slot: click one end center, the other end center, then the width |
| (panel) Polygon | Click the center, then a corner; sides in the panel (default 6), inscribed in a construction circle |
| A (while drawing a line chain) | Next segment is a tangent arc (A again: back to line) |
| D | Dimension (move the cursor to pick horizontal / vertical / aligned, or the angle side) |
| M / X / O | Trim (click, or drag across), Extend, Offset Entities |
| Q | Toggle construction for the selection |
| S | Shortcut bar with the sketch tools |
| Esc | End the current tool, then clear the selection |
| Enter | Repeat the last tool |
| Delete | Delete the selection |
| Hold Ctrl while drawing | No automatic relations (snaps off) |
| Drag geometry | Move it within its relations |
| Drag on empty space | Box select: left-to-right = window, right-to-left = crossing |
| Double-click a dimension | Change its value (numbers or expressions like `W/2`) |
| ✓ / ✗ (top right) | Exit keeping changes (one undo step) / discard all changes |

## Menus
Right-click menus and the Space orientation menu: Up/Down arrows move between items, Home/End jump to the ends, Enter runs the item, Esc closes.

## Status bar
- Pointing at a button shows what it does.
- Selecting one face or edge shows its exact length, radius or area; two selections show the minimum distance between them (full details in **Measure**).

## Feature tree
- Pointing at a feature lights its faces in the view (orange); a selected feature shows its faces in blue. Pointing at a sketch lights its lines.
- Clicking a face in the view marks the feature that made it in the tree (blue edge on the left) and scrolls the tree to it.
- Hover Front/Top/Right Plane to see it in the view; click to select it, then **Sketch**. Reference planes (Plane1...) work the same way: select one in the tree and click **Sketch**, or right-click it, Sketch.
- A sketch used by a feature sits under that feature (click the arrow to expand).
- Double-click a feature to edit it. Right-click for Edit Feature, Edit Sketch, Hide/Show Sketch, Suppress, Rename, Roll Back, Delete.
- Drag the blue rollback bar up to see the part as it was earlier. New features go in at the bar. Double-click the bar to roll to the end.

## Features
Extrude and Extruded Cut (the end conditions professional CAD users expect):
- **From**: Sketch Plane, or Offset (start a set distance away from the sketch plane; ⇅ flips the side).
- **Direction 1** end condition: Blind, Through All, Through All - Both, Up To Next, Up To Vertex, Up To Surface, Offset From Surface, Mid Plane, with a reverse button.
  - Up To Next: ends at the nearest face of the part, ahead of the sketch, that the whole profile runs into (e.g. a cut from the top of a hollow part goes through the first wall only). The reverse button picks the way it goes.
  - Up To Vertex: click near the end of an edge in the view (the end nearest your click is used), or pick a reference point in the box. The extrude ends on the plane through that vertex, parallel to the sketch.
  - Up To Surface / Offset From Surface: click a flat face or a plane in the view, or pick Front/Top/Right or a reference plane in the box. Tilted planes work (the end face lies exactly on the plane); the plane must not cut through the sketch profile. Offset From Surface stops short of it by the offset; Reverse offset goes past it. Up To Surface also takes a curved face (cylinder, fillet, spline surface); the face must cover the whole profile. Offset From Surface needs a flat face or plane.
  - With Up To Vertex / Surface the direction comes from where the target is, so the reverse button is off.
- **Drag arrows**: with Blind or Mid Plane, a blue arrow sits at the end of each direction in the view. Drag it to set the depth; a ruler appears beside it and the value snaps to the ruler ticks while the pointer is over the ruler.
- **Draft** (◿ button): tapers the sides by the angle, inward unless Draft outward is ticked. Not with Mid Plane. Direction 2 has its own Draft button and angle.
- **Flip side to cut** (cuts only): removes everything outside the profile instead of inside it, down to the cut's depth.
- **Direction 2**: the other way from the start, with the same end conditions as Direction 1 except Through All - Both and Mid Plane. Its vertex or surface must be on the Direction 2 side. Click its Vertex or Face/Plane box to send view clicks there.
- **Thin Feature**: One-Direction, Mid-Plane or Two-Direction wall from the sketch curves (open or closed; an open sketch turns it on by itself). ⇅ flips the side; for a closed loop the wall goes inside, flipped goes outside. **Cap ends** (closed sketches, bosses) closes both ends with the Cap Thickness, inside the extrude's depth, making a hollow part. **Auto-fillet corners** (open sketches) rounds every corner where two lines meet; the radius is the inside radius of the bend.
- The yellow (boss) or orange (cut) see-through preview updates as you type. The model is shown as it was before the feature while you edit it, so clicks land on what is there.

Fillet, Chamfer, Hole, patterns, Mirror, Shell, Draft, Rib, Sweep, Loft, Plane, Axis, Point (Features tab):
- The pink box in the panel is the active selection box. Click edges or faces in the view to add them; click again to remove. Click another box to make it active. Edges or faces you selected before starting the command are used straight away.
- Pick features, sketches and planes in the small tree at the top left of the view. For a pattern or mirror you can also click a face of the feature you want to copy.
- Hole: pick the face the holes start on, then click on that face where each hole goes (or type the coordinates; they are world X/Y/Z on that face).
- The view shows the part as it was before the feature, so you pick on what is there; the preview shows the result (fillet and chamfer faces in yellow, shell walls and drafted faces drawn through the part).
