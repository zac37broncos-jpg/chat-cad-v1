# Topological naming in CHAD

Fillets, chamfers, holes on faces, shells and drafts point at specific faces and edges of the part. When an earlier dimension changes, OpenCascade rebuilds the part and every face gets a new internal index, so a feature cannot store "edge 7". This note explains what CHAD stores instead.

## Face tags
Every face of the body carries one or more tags that say which feature and which sketch entity made it. Tags are recorded from the kernel's own history (Generated/Modified lists of the OCCT operations), never guessed from geometry.

| Made by | Tag |
| --- | --- |
| Extrude/revolve side face | `<feature>:side:<sketch entity id>` |
| Extrude start / end cap | `<feature>:start`, `<feature>:end` |
| Fillet / chamfer face | `<feature>:blend:<k>` (corner patches `<feature>:corner`) |
| Hole faces | `<feature>:<part>:<point>` with part = top, cbore, cbore-floor, csk, wall, drill-point, bottom |
| Shell inner faces | `<feature>:inner:<original tag>` |
| Rib faces | `<feature>:rib` |
| Pattern / mirror copies | `<original tag>#<pattern>.<instance>` |
| Anything without history | `<feature>:face<n>` (fallback, replaced as soon as history names it) |

A face keeps the tags of the faces it was modified from, so a side face that a later cut trims still answers to its original name. Booleans use `SimplifyResult` instead of a separate unify step so the history chain is never broken.

## References
- **FaceRef** = `{ tags, at }`: the face's tags plus a point on it when picked.
- **EdgeRef** = `{ a, b, at }`: the tags of the two faces the edge joins plus the edge midpoint.

Resolving a reference on the rebuilt part scores every candidate by how many tags it shares with the stored ones. If several candidates tie (for example a face that a cut split in two), the one nearest the stored `at` point wins. If nothing matches, or the tie cannot be broken, the feature reports an error ("reference no longer exists" / "ambiguous") and shows red in the tree. It never silently picks a different edge.

## Where the code lives
- `src/kernel/naming.ts`: tagging (`track`, `nameShape`), the topology list sent to the UI and AI, `faceRefFrom`/`edgeRefFrom`, `resolveFace`/`resolveEdge`.
- `src/kernel/features/*`: each modelling feature records its new faces' tags.
- Tests: `tests/features.test.ts` changes upstream dimensions and checks the fillet, chamfer and hole follow the right faces.
