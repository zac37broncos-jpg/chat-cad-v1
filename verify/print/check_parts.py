#!/usr/bin/env python3
"""
Independent printability and precision check of CHAD's exported files.

Reads verify/print/out/manifest.json (written by generate.verify.ts: the hand-calculated volume,
bounding box, holes and walls of each test part) and judges every exported STL and STEP file with
tools that share no code with CHAD:

  STL   own byte-level parser (numpy), trimesh, Manifold (Google's manifold3d), MeshLab
        (pymeshlab: topology and self-intersections), ADMesh, PrusaSlicer (--info and a real slice
        to G-code).
  STEP  OpenCascade 7.8 for Python (cadquery-ocp: a different build and version from the app's
        WebAssembly kernel) for validity, volume, size and exact hole cylinders, plus an own text
        parser of the ISO 10303-21 file (schema, unit, precision, cylinder radii) with no CAD
        library at all.

Precision is measured, not assumed: the STL surface is compared both ways with the exact B-rep read
from the STEP file (one-sided and two-sided Hausdorff distance), holes are cut with a plane and
measured, and walls are measured by ray casting.

Usage:  python verify/print/check_parts.py [--out verify/print/out] [--parts 05,14] [--no-slice]
Writes: <out>/results.json and <out>/RESULTS.md
"""
from __future__ import annotations

import argparse, json, math, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

import numpy as np
import trimesh
import manifold3d

IN = 25.4
PROMISE_MM = 0.005 * IN  # the project's accuracy promise: 0.005 in = 0.127 mm
FDM_NOZZLE = 0.4
FDM_MIN_WALL = 0.8  # two perimeters of a 0.4 mm nozzle (common FDM design guide value)

# ============================================================== STL: raw bytes

def parse_stl_bytes(path: Path):
    """Own STL reader: returns (triangles[n,3,3] float64 of the float32 values, normals[n,3], header, fmt)."""
    b = path.read_bytes()
    problems = []
    is_ascii = b[:6].lower() == b'solid ' and b'facet' in b[:1000]
    if not is_ascii:
        if len(b) < 84:
            raise ValueError('shorter than an STL header')
        n = int.from_bytes(b[80:84], 'little')
        if len(b) != 84 + 50 * n:
            problems.append(f'file size {len(b)} != 84 + 50 x {n}')
        rec = np.frombuffer(b, dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]), count=n, offset=84)
        tris = rec['v'].astype(np.float64)
        normals = rec['n'].astype(np.float64)
        if np.any(rec['a'] != 0):
            problems.append('non-zero attribute bytes')
        header = b[:80].split(b'\0')[0].decode('latin1').strip()
        if header.lower().startswith('solid'):
            problems.append('binary header starts with "solid" (readers may take it for ASCII)')
        fmt = 'binary'
    else:
        text = b.decode('ascii')
        nums = re.findall(r'facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)\s+outer\s+loop\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+endloop\s+endfacet', text)
        if text.count('endfacet') != len(nums):
            problems.append('malformed facets')
        a = np.array(nums, dtype=np.float64).reshape(-1, 12)
        a = a.astype(np.float32).astype(np.float64)  # what a reader storing float32 gets
        normals = a[:, :3]
        tris = a[:, 3:].reshape(-1, 3, 3)
        header = text.split('\n', 1)[0].strip()
        if not text.rstrip().split('\n')[-1].startswith('endsolid'):
            problems.append('no endsolid line')
        fmt = 'ascii'
    if not np.all(np.isfinite(tris)) or not np.all(np.isfinite(normals)):
        problems.append('non-finite numbers')
    return tris, normals, header, fmt, problems


def weld(tris):
    """Indexed mesh by exact float32 coordinates (what slicers do)."""
    flat = tris.reshape(-1, 3)
    uniq, inv = np.unique(flat, axis=0, return_inverse=True)
    return uniq, inv.reshape(-1, 3)


def own_topology(V, F):
    """Own edge bookkeeping: open, non-manifold and wrongly oriented edges; Euler genus; pieces."""
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    key = np.sort(e, axis=1)
    _, idx, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    open_edges = int(np.sum(cnt == 1))
    nonmanifold = int(np.sum(cnt > 2))
    # Orientation: each undirected edge used exactly once in each direction.
    d, dcnt = np.unique(e, axis=0, return_counts=True)
    dirset = {tuple(x): c for x, c in zip(map(tuple, d), dcnt)}
    flipped = 0
    for (a, b), c in dirset.items():
        if c != 1 or dirset.get((b, a)) != 1:
            flipped += 1
    flipped //= 1
    degenerate = int(np.sum((F[:, 0] == F[:, 1]) | (F[:, 1] == F[:, 2]) | (F[:, 2] == F[:, 0])))
    E = len(cnt)
    chi = len(V) - E + len(F)
    return dict(open_edges=open_edges, nonmanifold_edges=nonmanifold, misoriented_directed_edges=flipped, repeated_corner_triangles=degenerate, euler=chi)


def signed_volume(tris):
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0)


# ============================================================== external tools

def run(cmd, timeout=900):
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout)
    return p.returncode, p.stdout + p.stderr, time.time() - t0


def admesh_check(path):
    code, out, _ = run(['admesh', str(path)])
    keys = ['Number of parts', 'Degenerate facets', 'Edges fixed', 'Facets removed', 'Facets added', 'Facets reversed', 'Backwards edges', 'Normals fixed']
    res = {}
    for k in keys:
        m = re.search(re.escape(k) + r'\s*:\s*(\d+)', out)
        res[k] = int(m.group(1)) if m else None
    m = re.search(r'Total disconnected facets\s*:\s*(\d+)\s+(\d+)', out)
    res['Disconnected facets'] = int(m.group(1)) if m else None
    m = re.search(r'Volume\s*:\s*([-\d.]+)', out)
    res['volume'] = float(m.group(1)) if m else None
    res['clean'] = code == 0 and res['Number of parts'] == 1 and all(res[k] == 0 for k in keys[1:]) and res['Disconnected facets'] == 0
    return res


def prusa_info(path):
    code, out, _ = run(['prusa-slicer', '--info', str(path)])
    res = {}
    for k, v in re.findall(r'^(\w+) = (.*)$', out, re.M):
        res[k] = v.strip()
    res['ok'] = code == 0 and res.get('manifold') == 'yes' and res.get('number_of_parts', '').strip() == '1'
    return res


PRUSA_SETTINGS = ['--nozzle-diameter', '0.4', '--layer-height', '0.2', '--first-layer-height', '0.2', '--perimeters', '2',
                  '--fill-density', '20%', '--bed-shape', '0x0,300x0,300x300,0x300', '--max-print-height', '300', '--center', '150,150',
                  '--filament-diameter', '1.75', '--temperature', '215', '--bed-temperature', '60', '--gcode-comments']


def prusa_slice(path, height_mm):
    """Slice with PrusaSlicer, then read back from the G-code: layers, top Z, external perimeter extents."""
    with tempfile.TemporaryDirectory() as td:
        g = Path(td) / 'out.gcode'
        code, out, secs = run(['prusa-slicer', '--export-gcode', *PRUSA_SETTINGS, '--output', str(g), str(path)])
        res = {'exit': code, 'seconds': round(secs, 1)}
        warn = [l for l in out.splitlines() if re.search(r'warn|error|repair|empty|failed', l, re.I)]
        res['messages'] = warn[:10]
        if code != 0 or not g.exists():
            res['ok'] = False
            res['log'] = out[-2000:]
            return res
        z = 0.0
        layers = set()
        typ = None
        ext = []
        xs, ys = [], []
        last = [0.0, 0.0]
        absolute_e = True
        for line in g.open():
            if line.startswith(';TYPE:'):
                typ = line[6:].strip()
                continue
            if line.startswith('M83'):
                absolute_e = False
            if not (line.startswith('G1') or line.startswith('G0')):
                continue
            mx = re.search(r'X(-?[\d.]+)', line); my = re.search(r'Y(-?[\d.]+)', line)
            mz = re.search(r'Z(-?[\d.]+)', line); me = re.search(r'E(-?[\d.]+)', line)
            if mz:
                z = float(mz.group(1))
            x = float(mx.group(1)) if mx else last[0]
            y = float(my.group(1)) if my else last[1]
            if me and float(me.group(1)) > 0 and (mx or my):
                layers.add(round(z, 4))
                if typ == 'External perimeter':
                    ext.append((last[0], last[1], z)); ext.append((x, y, z))
                xs += [x]; ys += [y]
            last = [x, y]
        res['layers'] = len(layers)
        res['top_z'] = max(layers) if layers else None
        m = re.search(r'; external perimeters extrusion width = ([\d.]+)mm', g.read_text())
        w = float(m.group(1)) if m else None
        res['external_perimeter_width'] = w
        if ext:
            a = np.array(ext)
            res['external_perimeter_extent_xy'] = [round(float(a[:, 0].max() - a[:, 0].min()), 4), round(float(a[:, 1].max() - a[:, 1].min()), 4)]
        txt = g.read_text()
        m = re.search(r'; filament used \[mm\] = ([\d.]+)', txt)
        res['filament_mm'] = float(m.group(1)) if m else None
        m = re.search(r'; estimated printing time \(normal mode\) = (.*)', txt)
        res['print_time'] = m.group(1).strip() if m else None
        res['ok'] = code == 0 and res['layers'] > 0 and res['top_z'] is not None and abs(res['top_z'] - height_mm) <= 0.2 + 1e-6
        return res


def meshlab_check(V, F):
    import pymeshlab
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=V, face_matrix=F.astype(np.int32)))
    topo = ms.get_topological_measures()
    geo = ms.get_geometric_measures()
    ms.compute_selection_by_self_intersections_per_face()
    selfx = int(ms.current_mesh().selected_face_number())
    return {
        'boundary_edges': int(topo['boundary_edges']), 'non_two_manifold_edges': int(topo['non_two_manifold_edges']),
        'non_two_manifold_vertices': int(topo['non_two_manifold_vertices']), 'connected_components': int(topo['connected_components_number']),
        'genus': int(topo['genus']) if topo.get('is_mesh_two_manifold') else None, 'holes': int(topo['number_holes']) if topo.get('number_holes', -1) >= 0 else None,
        'self_intersecting_faces': selfx, 'volume': float(geo.get('mesh_volume', float('nan'))), 'area': float(geo['surface_area']),
    }


def manifold_check(V, F):
    m = manifold3d.Mesh(vert_properties=V.astype(np.float32), tri_verts=F.astype(np.uint32))
    M = manifold3d.Manifold(m)
    st = M.status()
    return {'status': str(st).split('.')[-1], 'genus': int(M.genus()) if str(st).endswith('NoError') else None,
            'volume': float(M.volume()) if str(st).endswith('NoError') else None}


# ============================================================== STEP (OpenCascade for Python, and plain text)

def step_text_facts(path: Path):
    """No CAD library: ISO 10303-21 header, schema, unit, declared precision, cylinder radii, point extents."""
    t = path.read_text(errors='replace')
    res = {'iso_10303_21': t.startswith('ISO-10303-21;') and t.rstrip().endswith('END-ISO-10303-21;')}
    m = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", t)
    res['schema'] = m.group(1) if m else None
    # Length unit: SI millimetre, or a conversion-based INCH.
    if re.search(r"CONVERSION_BASED_UNIT\s*\(\s*'INCH'", t, re.I):
        res['unit'] = 'in'
    elif re.search(r"SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)", t):
        res['unit'] = 'mm'
    else:
        res['unit'] = None
    m = re.search(r"UNCERTAINTY_MEASURE_WITH_UNIT\s*\(\s*LENGTH_MEASURE\s*\(\s*([-\dEe.+]+)\s*\)", t)
    res['uncertainty'] = float(m.group(1)) if m else None
    ents = dict(re.findall(r'^#(\d+)\s*=\s*(.*?);\s*$', t, re.M | re.S))
    res['entities'] = len(ents)
    res['cylinder_radii'] = sorted(float(x) for x in re.findall(r"CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#\d+\s*,\s*([-\dEe.+]+)\s*\)", t))
    pts = np.array([[float(a), float(b), float(c)] for a, b, c in re.findall(r"CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-\dEe.+]+)\s*,\s*([-\dEe.+]+)\s*,\s*([-\dEe.+]+)\s*\)\s*\)", t)])
    vp = re.findall(r"VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)", t)
    vpts = []
    for ref in vp:
        e = ents.get(ref, '')
        m = re.search(r"\(\s*([-\dEe.+]+)\s*,\s*([-\dEe.+]+)\s*,\s*([-\dEe.+]+)\s*\)", e)
        if m:
            vpts.append([float(m.group(1)), float(m.group(2)), float(m.group(3))])
    res['vertex_count'] = len(vpts)
    if vpts:
        a = np.array(vpts)
        res['vertex_extent_min'] = a.min(0).tolist(); res['vertex_extent_max'] = a.max(0).tolist()
    res['manifold_solid_breps'] = len(re.findall(r'MANIFOLD_SOLID_BREP', t))
    m = re.search(r"PRODUCT\s*\(\s*'([^']*)'", t)
    res['product'] = m.group(1) if m else None
    return res


def _cast(T, name):
    """TopoDS.Face_s in OCP 7.x, TopoDS.Face in OCP 8."""
    return getattr(T, name + '_s', None) or getattr(T, name)


def occ():
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopExp import TopExp_Explorer, TopExp
    from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX, TopAbs_SHELL
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Sphere, GeomAbs_Torus, GeomAbs_BSplineSurface, GeomAbs_BezierSurface, GeomAbs_SurfaceOfRevolution, GeomAbs_SurfaceOfExtrusion, GeomAbs_OffsetSurface
    from OCP.TopoDS import TopoDS
    return locals()


def read_step_occ(path: Path):
    O = occ()
    r = O['STEPControl_Reader']()
    st = r.ReadFile(str(path))
    if st != O['IFSelect_RetDone']:
        raise RuntimeError(f'STEP read status {st}')
    r.TransferRoots()
    return r.OneShape()


def unique_subshapes(shape, kind):
    """Distinct sub-shapes (IsSame: same TShape and location), like TopExp::MapShapes."""
    O = occ()
    buckets = {}
    out = []
    ex = O['TopExp_Explorer'](shape, kind)
    while ex.More():
        c = ex.Current()
        b = buckets.setdefault(hash(c), [])
        if not any(c.IsSame(x) for x in b):
            b.append(c); out.append(c)
        ex.Next()
    return out


def count(shape, kind):
    return len(unique_subshapes(shape, kind))


def step_occ_facts(shape):
    O = occ()
    res = {}
    res['solids'] = count(shape, O['TopAbs_SOLID'])
    res['shells'] = count(shape, O['TopAbs_SHELL'])
    res['faces'] = count(shape, O['TopAbs_FACE'])
    res['edges'] = count(shape, O['TopAbs_EDGE'])
    res['vertices'] = count(shape, O['TopAbs_VERTEX'])
    res['valid'] = bool(O['BRepCheck_Analyzer'](shape).IsValid())
    # Free (open) edges: an edge used by only one face.
    # Each non-degenerate edge must be used twice by the faces (two faces, or a seam twice in one face).
    from OCP.BRep import BRep_Tool
    uses = {}
    for f in unique_subshapes(shape, O['TopAbs_FACE']):
        ex = O['TopExp_Explorer'](f, O['TopAbs_EDGE'])
        while ex.More():
            e = ex.Current()
            if not BRep_Tool.Degenerated_s(_cast(O['TopoDS'], 'Edge')(e)):
                b = uses.setdefault(hash(e), [])
                for item in b:
                    if item[0].IsSame(e):
                        item[1] += 1; break
                else:
                    b.append([e, 1])
            ex.Next()
    res['free_edges'] = sum(1 for b in uses.values() for _, n in b if n < 2)
    res['overused_edges'] = sum(1 for b in uses.values() for _, n in b if n > 2)
    # Gauss-Kronrod: OpenCascade's plain volume integration converges to a wrong value on some trimmed
    # B-spline faces (the Easter Island head: 2.9 mm³ low, the same at 1e-9 and 1e-12, while Gauss-Kronrod
    # agreed with the model to 4e-9 and with the extrapolated STL volumes). Both are recorded.
    p = O['GProp_GProps']()
    O['BRepGProp'].VolumePropertiesGK_s(shape, p, 1e-9, False, True, False, False, False)
    res['volume'] = p.Mass()
    pp = O['GProp_GProps']()
    O['BRepGProp'].VolumeProperties_s(shape, pp, 1e-9, False, False)
    res['volume_plain'] = pp.Mass()
    pa = O['GProp_GProps']()
    O['BRepGProp'].SurfaceProperties_s(shape, pa, 1e-9, False)
    res['area'] = pa.Mass()
    b = O['Bnd_Box']()
    O['BRepBndLib'].AddOptimal_s(shape, b, False, False)
    lo, hi = b.CornerMin(), b.CornerMax()
    res['box'] = {'min': [lo.X(), lo.Y(), lo.Z()], 'max': [hi.X(), hi.Y(), hi.Z()]}
    kinds = {O['GeomAbs_Plane']: 'plane', O['GeomAbs_Cylinder']: 'cylinder', O['GeomAbs_Cone']: 'cone', O['GeomAbs_Sphere']: 'sphere', O['GeomAbs_Torus']: 'torus',
             O['GeomAbs_BSplineSurface']: 'bspline', O['GeomAbs_BezierSurface']: 'bezier', O['GeomAbs_SurfaceOfRevolution']: 'revolution', O['GeomAbs_SurfaceOfExtrusion']: 'extrusion', O['GeomAbs_OffsetSurface']: 'offset'}
    types = {}
    cyl = []
    ex = O['TopExp_Explorer'](shape, O['TopAbs_FACE'])
    while ex.More():
        f = _cast(O['TopoDS'], 'Face')(ex.Current())
        ad = O['BRepAdaptor_Surface'](f)
        k = kinds.get(ad.GetType(), 'other')
        types[k] = types.get(k, 0) + 1
        if k == 'cylinder':
            c = ad.Cylinder()
            ax = c.Axis()
            loc, d = ax.Location(), ax.Direction()
            cyl.append({'r': c.Radius(), 'loc': [loc.X(), loc.Y(), loc.Z()], 'dir': [d.X(), d.Y(), d.Z()]})
        ex.Next()
    res['surface_types'] = types
    res['cylinders'] = cyl
    return res


def match_hole_cylinders(holes, cyl):
    """Each designed hole must have a cylinder face with its exact radius on its exact axis."""
    out = []
    for h in holes:
        r = h['diameter'] / 2
        a = np.array(h['axis'], float); a /= np.linalg.norm(a)
        P = np.array(h['point'], float)
        best = None
        for c in cyl:
            d = np.array(c['dir']); d /= np.linalg.norm(d)
            if abs(abs(d @ a) - 1) > 1e-9:
                continue
            v = np.array(c['loc']) - P
            off = np.linalg.norm(v - (v @ a) * a)  # distance between the parallel axes
            err = abs(c['r'] - r)
            if off < 1e-6 and (best is None or err < best):
                best = err
        out.append({'label': h['label'], 'diameter': h['diameter'], 'radius_error': best})
    return out


# ============================================================== precision: STL vs exact B-rep

def reference_mesh(shape, deflection):
    """Fine triangulation of the exact B-rep (its nodes lie ON the exact surface)."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopoDS import TopoDS
    BRepMesh_IncrementalMesh(shape, deflection, False, 0.05, True)
    Vs, Fs = [], []
    off = 0
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        f = _cast(TopoDS, 'Face')(ex.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(f, loc)
        if tri is not None:
            tr = loc.Transformation()
            nodes = np.array([[p.X(), p.Y(), p.Z()] for p in (tri.Node(i).Transformed(tr) for i in range(1, tri.NbNodes() + 1))])
            tris = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)]) - 1
            if f.Orientation() == TopAbs_REVERSED:
                tris = tris[:, [0, 2, 1]]
            Vs.append(nodes); Fs.append(tris + off); off += len(nodes)
        ex.Next()
    return np.vstack(Vs), np.vstack(Fs)


def exact_distances(shape, pts, nearest=False):
    """Exact distance from each point to the B-rep's faces (BRepExtrema), slow: use for a few thousand points."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.gp import gp_Pnt
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound
    # The skin only (faces), so the distance is to the surface, not 0 inside the solid.
    comp = TopoDS_Compound(); bld = BRep_Builder(); bld.MakeCompound(comp)
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        bld.Add(comp, ex.Current()); ex.Next()
    d = BRepExtrema_DistShapeShape()
    d.LoadS1(comp)
    out = np.empty(len(pts))
    near = np.full((len(pts), 3), np.nan)
    for i, p in enumerate(pts):
        d.LoadS2(BRepBuilderAPI_MakeVertex(gp_Pnt(*map(float, p))).Vertex())
        d.Perform()
        out[i] = d.Value() if d.IsDone() else np.nan
        if nearest and d.IsDone() and d.NbSolution() > 0:
            q = d.PointOnShape1(1)
            near[i] = [q.X(), q.Y(), q.Z()]
    return (out, near) if nearest else out


def closest_dist(mesh, pts, chunk=20000):
    """trimesh closest-point distances in chunks (one big call takes many GB of memory)."""
    out = np.empty(len(pts))
    for i in range(0, len(pts), chunk):
        _, d, _ = trimesh.proximity.closest_point(mesh, pts[i:i + chunk])
        out[i:i + chunk] = d
    return out


def deviation(stl_mesh: trimesh.Trimesh, shape, nominal, rng):
    """Two-sided deviation between the STL and the exact surface, mm.

    STL -> exact: points on the STL triangles (corners, edge midpoints, centroids and random points);
    the worst candidates found against a very fine reference mesh are re-measured exactly with BRepExtrema.
    exact -> STL: the reference mesh's nodes lie on the exact surface; their distance to the STL triangles
    (trimesh closest point, exact for triangles).
    """
    # The reference mesh only picks candidates; every number reported is measured exactly. It lies
    # within ref_defl of the exact surface, so a sample's true distance is at most its distance to the
    # reference plus ref_defl: every sample that could be over the limit by that bound is measured
    # exactly, so no sample can hide a larger gap. (A reference at 1/10 of Extra fine, 0.0005 mm, took
    # over 9 GB on the 6 in head; 1/5 with this guarantee is as strict and fits.)
    ref_defl = max(nominal / 5, 0.001)
    RV, RF = reference_mesh(shape, ref_defl)
    ref = trimesh.Trimesh(RV, RF, process=False)
    T = stl_mesh.triangles
    n = len(T)
    k = min(60000, 8 * n)
    idx = rng.integers(0, n, k)
    w = rng.dirichlet([1, 1, 1], k)
    samples = np.vstack([
        stl_mesh.vertices,
        T.mean(axis=1),
        (T[:, 0] + T[:, 1]) / 2, (T[:, 1] + T[:, 2]) / 2, (T[:, 2] + T[:, 0]) / 2,
        np.einsum('ij,ijk->ik', w, T[idx]),
    ])
    if len(samples) > 400000:
        samples = samples[rng.choice(len(samples), 400000, replace=False)]
    d_ref = closest_dist(ref, samples)
    CAP = 20000
    LIMIT = nominal * 1.001 + 1e-5  # the verdict's limit (BRepExtrema's own precision)
    over_pts = []  # every exactly measured point over the limit, with its gap: (where on the exact surface or STL, gap)
    def exact_where_needed(bound, measure, where):
        """Measure exactly the worst 800, then every candidate whose bound is over the larger of the limit
        and the worst exact value found (at most CAP). Returns (max exact, measured, still open)."""
        order = np.argsort(bound)[::-1]
        done = np.zeros(len(bound), bool)
        def run(ii):
            vals = measure(ii)
            bad = np.isfinite(vals) & (vals > LIMIT)
            for p, g in zip(where(ii[bad]), vals[bad]):
                over_pts.append((p, float(g)))
            return float(np.nanmax(vals))
        first = order[:800]
        best = run(first); done[first] = True
        need = np.where(~done & (bound > max(nominal, best)))[0]
        need = need[np.argsort(bound[need])[::-1]]
        if len(need):
            take = need[:CAP]
            best = max(best, run(take)); done[take] = True
        still = int(np.sum(~done & (bound > max(nominal, best))))
        return best, int(done.sum()), still
    stl_to_exact, n1, open1 = exact_where_needed(d_ref + ref_defl, lambda ii: exact_distances(shape, samples[ii]), lambda ii: samples[ii])
    # Reverse direction: points of the exact surface to the STL. The reference mesh's nodes lie on
    # B-rep edges for many faces (a cylinder's nodes are all on its two circles, which the STL's flat
    # faces also contain), so they would miss the sag between the edges: sample the reference
    # triangles' interiors instead, then move the candidates exactly onto the surface.
    rs, _ = trimesh.sample.sample_surface(ref, 200000, seed=int(rng.integers(1 << 30)))
    rs = np.vstack([rs, RV if len(RV) <= 100000 else RV[rng.choice(len(RV), 100000, replace=False)]])
    d_back = closest_dist(stl_mesh, rs)
    back_on = {}
    def back_exact(ii):
        _, on_surface = exact_distances(shape, rs[ii], nearest=True)
        ok = np.all(np.isfinite(on_surface), axis=1)
        out = np.full(len(ii), np.nan); out[ok] = closest_dist(stl_mesh, on_surface[ok])
        for i, p in zip(ii, on_surface): back_on[int(i)] = p
        return out
    exact_to_stl, n2, open2 = exact_where_needed(d_back + ref_defl, back_exact, lambda ii: np.array([back_on[int(i)] for i in ii]).reshape(-1, 3))
    joints = joint_attribution(shape, stl_mesh, over_pts, nominal) if over_pts else None
    return {
        'reference_deflection': ref_defl, 'reference_triangles': int(len(RF)), 'samples': int(len(samples)),
        'stl_to_exact_max': stl_to_exact, 'stl_to_exact_p99': float(np.percentile(d_ref, 99)),
        'exact_to_stl_max': exact_to_stl, 'exact_to_stl_p99': float(np.percentile(d_back, 99)),
        'hausdorff': max(stl_to_exact, exact_to_stl),
        'exactly_measured': [n1, n2], 'unresolved_over_limit': [open1, open2],
        'over_limit': len(over_pts), 'joints': joints,
    }


def joint_gaps(shape):
    """How far each edge's 3D curve lies from the surfaces of its faces (21 points along it), mm: the
    model's own accuracy there. Where two organic bodies were joined, the kernel's intersection curve is
    an approximation (0.036 mm on the hard-seam head); elsewhere it is about 1e-7. Measured here, not read
    from the file: STEP does not store each edge's tolerance."""
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopoDS import TopoDS
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, m)
    out = []
    for i in range(1, m.Extent() + 1):
        e = _cast(TopoDS, 'Edge')(m.FindKey(i))
        if BRep_Tool.Degenerated_s(e):
            continue
        c = BRepAdaptor_Curve(e)
        pts = [c.Value(c.FirstParameter() + (c.LastParameter() - c.FirstParameter()) * k / 20) for k in range(21)]
        gap = 0.0
        for f in m.FindFromIndex(i):
            surf = BRep_Tool.Surface_s(_cast(TopoDS, 'Face')(f))
            for p in pts:
                pr = GeomAPI_ProjectPointOnSurf(p, surf)
                if pr.NbPoints() > 0:
                    gap = max(gap, pr.LowerDistance())
        out.append((e, gap))
    return out


def joint_attribution(shape, stl_mesh, over_pts, nominal):
    """Where bodies were joined, the model's joint edge lies off its faces (the kernel's intersection
    curves are approximations; the app reports it as a Note, "the model itself is exact to ... mm"), and
    the file's corners on that edge follow it. A triangle with such a corner is off the surface by up to
    that corner's own gap plus the setting, and no finer mesh changes that. So an over-limit point is put
    down to a joint only when a file corner whose triangles reach the point (the point is within that
    corner's longest triangle side) is itself off the surface of the face the point lies on (and belongs
    to that face: on it or on its border edges) by at least the excess over the setting. The corner's gap is measured to
    that face's SURFACE (a point-to-surface projection): a distance to the face as a shape would include
    its border edges, and a corner on the joint edge would read 0. Every other over-limit point stays a
    failure."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopoDS import TopoDS
    from OCP.BRep import BRep_Tool
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    faces = unique_subshapes(shape, TopAbs_FACE)
    dists = []
    for f in faces:
        d = BRepExtrema_DistShapeShape(); d.LoadS1(f); dists.append(d)
    surfs = [BRep_Tool.Surface_s(_cast(TopoDS, 'Face')(f)) for f in faces]
    def own_face(p):
        v = BRepBuilderAPI_MakeVertex(gp_Pnt(*map(float, p))).Vertex()
        best, bi = math.inf, -1
        for i, d in enumerate(dists):
            d.LoadS2(v); d.Perform()
            if d.IsDone() and d.Value() < best:
                best, bi = d.Value(), i
        return bi
    def to_surface(q, i):
        pr = GeomAPI_ProjectPointOnSurf(gp_Pnt(*map(float, q)), surfs[i])
        return pr.LowerDistance() if pr.NbPoints() > 0 else 0.0
    # One ring: each file corner's longest incident triangle side (its triangles reach that far).
    ring = np.zeros(len(stl_mesh.vertices))
    for e, l in zip(stl_mesh.edges_unique, stl_mesh.edges_unique_length):
        ring[e[0]] = max(ring[e[0]], l); ring[e[1]] = max(ring[e[1]], l)
    tree = stl_mesh.kdtree
    gap_memo = {}
    def corner_gap(c, fi):
        """Gap of file corner c to face fi's surface, if c belongs to that face (on it or its border), else 0."""
        key = (int(c), fi)
        if key not in gap_memo:
            q = stl_mesh.vertices[c]
            d = dists[fi]; d.LoadS2(BRepBuilderAPI_MakeVertex(gp_Pnt(*map(float, q))).Vertex()); d.Perform()
            gap_memo[key] = to_surface(q, fi) if d.IsDone() and d.Value() <= 1e-6 else 0.0
        return gap_memo[key]
    at_joint, worst_away, worst_corner = 0, 0.0, 0.0
    for p, g in over_pts:
        fi = own_face(p)
        excess = g - nominal
        ok = False
        if fi >= 0:
            # Corners whose triangles reach p (|p - c| <= the corner's longest side), nearest first.
            # (the 64 nearest corners; looking at fewer can only excuse less)
            for c in tree.query(p, k=min(64, len(stl_mesh.vertices)))[1]:
                if np.linalg.norm(stl_mesh.vertices[c] - p) > ring[c]:
                    continue
                cg = corner_gap(c, fi)
                if excess <= cg + 1e-6:
                    ok = True; worst_corner = max(worst_corner, cg); break
        if ok:
            at_joint += 1
        else:
            worst_away = max(worst_away, g)
    edge_gaps = [g for _, g in joint_gaps(shape)]
    return {'largest_corner_gap': worst_corner, 'largest_step_edge_gap': max(edge_gaps, default=0.0),
            'over_limit_at_joints': at_joint, 'over_limit_elsewhere': len(over_pts) - at_joint, 'largest_elsewhere': worst_away}


def measure_holes(mesh: trimesh.Trimesh, holes):
    """Cut the STL across each hole at mid-depth and measure the loop around the hole axis."""
    out = []
    for h in holes:
        a = np.array(h['axis'], float); a /= np.linalg.norm(a)
        P = np.array(h['point'], float)
        mid = P + a * ((h['from'] + h['to']) / 2 - P @ a)
        sec = mesh.section(plane_origin=mid, plane_normal=a)
        res = {'label': h['label'], 'design_diameter': h['diameter']}
        if sec is None:
            res['error'] = 'no section'; out.append(res); continue
        best = None
        for ent in sec.entities:
            pts = sec.vertices[ent.points]
            v = pts - mid
            v = v - np.outer(v @ a, a)
            r = np.linalg.norm(v, axis=1)
            if r.max() > 0.75 * h['diameter'] or r.min() < 0.25 * h['diameter'] / 2:
                continue
            # The loop must go around the axis (winding), not be a nearby outline.
            ang = np.unwrap(np.arctan2(*(np.stack([v @ np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]), v @ np.cross(a, np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]))]))))
            if abs(ang[-1] - ang[0]) < 1.9 * math.pi:
                continue
            # Inscribed radius: the closest the polygon's edges come to the axis (not just its corners).
            p2 = np.stack([v @ np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]), v @ np.cross(a, np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]))], 1)
            q0, q1 = p2, np.roll(p2, -1, axis=0)
            seg = q1 - q0
            t = np.clip(-(q0 * seg).sum(1) / np.maximum((seg * seg).sum(1), 1e-30), 0, 1)
            closest = np.linalg.norm(q0 + seg * t[:, None], axis=1)
            # Least-squares (Kasa) circle fit.
            A = np.c_[2 * p2, np.ones(len(p2))]
            sol, *_ = np.linalg.lstsq(A, (p2 ** 2).sum(1), rcond=None)
            rfit = math.sqrt(sol[2] + sol[0] ** 2 + sol[1] ** 2)
            cand = {'inscribed_diameter': 2 * float(closest.min()), 'circumscribed_diameter': 2 * float(r.max()), 'fitted_diameter': 2 * rfit, 'center_offset': float(math.hypot(sol[0], sol[1])), 'segments': int(len(p2))}
            if best is None or abs(cand['fitted_diameter'] - h['diameter']) < abs(best['fitted_diameter'] - h['diameter']):
                best = cand
        if best is None:
            res['error'] = 'hole loop not found'
        else:
            res.update(best)
            res['worst_error'] = max(abs(best['inscribed_diameter'] - h['diameter']), abs(best['circumscribed_diameter'] - h['diameter'])) / 2
        out.append(res)
    return out


def wall_thickness(mesh: trimesh.Trimesh, rng, n=6000):
    """Local wall thickness by ray casting from points on the surface straight inward (along -normal)."""
    pts, fi = trimesh.sample.sample_surface_even(mesh, n, seed=int(rng.integers(1 << 30)))
    nrm = mesh.face_normals[fi]
    origins = pts - nrm * 1e-4
    th = np.full(len(pts), np.nan)
    # In chunks: trimesh's numpy ray caster gathers every triangle whose box a ray passes, which on a
    # torus (rays crossing the whole ring) took over 13 GB for all rays at once. Same rays, same results.
    for k in range(0, len(pts), 250):
        o, d = origins[k:k + 250], -nrm[k:k + 250]
        locs, ray_idx, _ = mesh.ray.intersects_location(o, d, multiple_hits=False)
        th[k + ray_idx] = np.linalg.norm(locs - o[ray_idx], axis=1) + 1e-4
    th = th[np.isfinite(th)]
    return {'rays': int(len(th)), 'min': float(th.min()), 'p1': float(np.percentile(th, 1)), 'p5': float(np.percentile(th, 5)), 'median': float(np.median(th)),
            'below_fdm_min_wall_fraction': float(np.mean(th < FDM_MIN_WALL)), 'below_nozzle_fraction': float(np.mean(th < FDM_NOZZLE))}


def overhangs(mesh: trimesh.Trimesh):
    """Downward-facing area steeper than 45° from vertical (needs support on FDM), excluding the bed face."""
    n = mesh.face_normals
    A = mesh.area_faces
    zmin = mesh.bounds[0][2]
    on_bed = np.all(np.abs(mesh.triangles[:, :, 2] - zmin) < 1e-4, axis=1)
    down = (n[:, 2] < -math.cos(math.radians(45))) & ~on_bed
    return {'bed_contact_area': float(A[on_bed].sum()), 'overhang_area_over_45deg': float(A[down].sum()), 'overhang_fraction': float(A[down].sum() / A.sum())}


# ============================================================== per part

def box_err(a, b):
    return max(max(abs(x - y) for x, y in zip(a['min'], b['min'])), max(abs(x - y) for x, y in zip(a['max'], b['max'])))


def check_stl(path, part, shape, rng, full, slice_it):
    f = part['files_by_path'][path.name]
    unit_scale = IN if f['options']['unit'] == 'in' else 1.0  # file numbers x this = mm
    tris, normals, header, fmt, raw_problems = parse_stl_bytes(path)
    r = {'file': path.name, 'format': fmt, 'header': header, 'triangles': int(len(tris)), 'bytes': path.stat().st_size, 'raw_problems': raw_problems,
         'exporter': {k: f['report'][k] for k in ('measuredDeviation', 'linearDeflection', 'watertight', 'meshPasses') if k in f['report']}, 'ms': f['ms']}
    tris_mm = tris * unit_scale
    V, F = weld(tris_mm)
    # Stored normals agree with the winding (right-hand rule).
    cr = np.cross(tris_mm[:, 1] - tris_mm[:, 0], tris_mm[:, 2] - tris_mm[:, 0])
    area2 = np.linalg.norm(cr, axis=1)
    r['zero_area_triangles'] = int(np.sum(area2 <= 0))
    r['min_triangle_area'] = float(area2.min() / 2)
    good = area2 > 0
    cosang = np.einsum('ij,ij->i', normals[good], cr[good] / area2[good, None])
    r['normal_winding_min_cos'] = float(cosang.min())
    r['own'] = own_topology(V, F)
    vol = signed_volume(tris_mm)
    r['volume'] = vol
    lo, hi = V.min(0), V.max(0)
    r['box'] = {'min': lo.tolist(), 'max': hi.tolist()}
    if not full:
        return r
    tm = trimesh.Trimesh(V, F, process=False)
    bodies = tm.split(only_watertight=False)
    r['trimesh'] = {'is_watertight': bool(tm.is_watertight), 'is_winding_consistent': bool(tm.is_winding_consistent), 'is_volume': bool(tm.is_volume),
                    'bodies': len(bodies), 'euler': int(tm.euler_number), 'volume': float(tm.volume), 'area': float(tm.area)}
    r['manifold3d'] = manifold_check(V, F)
    r['meshlab'] = meshlab_check(V, F)
    r['admesh'] = admesh_check(path)
    r['prusa_info'] = prusa_info(path)
    if slice_it:
        r['prusa_slice'] = prusa_slice(path, hi[2] - lo[2]) if unit_scale == 1.0 else None
    if shape is not None:
        r['deviation'] = deviation(tm, shape, f['options']['linearDeflection'], rng)
    if part['expected']['holes']:
        r['holes'] = measure_holes(tm, part['expected']['holes'])
    r['walls'] = wall_thickness(tm, rng)
    r['overhangs'] = overhangs(tm)
    return r


def check_step(path, part):
    f = part['files_by_path'][path.name]
    r = {'file': path.name, 'bytes': path.stat().st_size, 'options': f['options'], 'exporter_ok': f['report']['ok'], 'exporter_problems': f['report']['problems']}
    r['text'] = step_text_facts(path)
    shape = read_step_occ(path)
    r['occ'] = step_occ_facts(shape)
    r['occ'].pop('cylinders_raw', None)
    if part['expected']['holes']:
        r['hole_cylinders'] = match_hole_cylinders(part['expected']['holes'], r['occ']['cylinders'])
        # The same, from the file's text alone (radius in the file's unit).
        s = IN if r['text']['unit'] == 'in' else 1.0
        radii = np.array(r['text']['cylinder_radii']) * s
        r['hole_radii_in_text'] = [{'label': h['label'], 'radius_error': float(np.min(np.abs(radii - h['diameter'] / 2))) if len(radii) else None} for h in part['expected']['holes']]
    del r['occ']['cylinders']
    return r, shape


def same_as_binary(d, part, res):
    """The Fine ASCII file holds the same triangles as the Fine binary one; the inch file is the mm one / 25.4."""
    def tris(key):
        f = part['files'].get(key)
        return parse_stl_bytes(d / f['file'])[0] if f else None
    b = tris('fine-mm-binary')
    res['same_triangles'] = {}
    for key, scale in (('fine-mm-ascii', 1.0), ('fine-in-binary', IN)):
        t = tris(key)
        if b is None or t is None:
            continue
        if t.shape != b.shape:
            res['same_triangles'][key] = {'same_count': False}
            continue
        # float32 values: ASCII must be bit-identical, inch must equal mm / 25.4 to float32 rounding.
        err = float(np.max(np.abs(t * scale - b)))
        res['same_triangles'][key] = {'same_count': True, 'max_difference_mm': err}


def verdicts(part, res):
    """Pass/fail lines with the numbers behind them. Every check is a hard rule unless marked info."""
    exp = part['expected']
    v = []
    def add(name, ok, detail, info=False):
        v.append({'check': name, 'ok': bool(ok), 'detail': detail, 'info': info})
    model_vol = part['model']['volume']
    if exp['volume']:
        rel = abs(model_vol - exp['volume']) / exp['volume']
        add('B-rep volume = hand calculation', rel < 1e-7, f'model {model_vol:.4f} mm³ vs hand {exp["volume"]:.4f} mm³ (rel {rel:.1e})')
    for s in res['step']:
        o, t = s['occ'], s['text']
        tag = s['file'].split(part['slug'] + '-')[1]
        add(f'STEP {tag}: one valid closed solid (OpenCascade 7.8, Python)', o['solids'] == 1 and o['valid'] and o['free_edges'] == 0 and o['overused_edges'] == 0, f"solids {o['solids']}, valid {o['valid']}, open edges {o['free_edges']}, edges used by 3+ faces {o['overused_edges']}")
        want_schema = 'AUTOMOTIVE_DESIGN' if s['options']['schema'] == 'AP214' else 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'
        add(f'STEP {tag}: header, schema and unit (text)', t['iso_10303_21'] and t['schema'] and t['schema'].upper().startswith(want_schema) and t['unit'] == s['options']['unit'] and t['manifold_solid_breps'] == 1,
            f"schema {t['schema']}, unit {t['unit']}, solids {t['manifold_solid_breps']}, precision {t['uncertainty']}")
        relv = abs(o['volume'] - model_vol) / model_vol
        add(f'STEP {tag}: volume = model', relv < 1e-6, f"{o['volume']:.4f} mm³ (rel {relv:.1e})")
        if exp['volume']:
            relh = abs(o['volume'] - exp['volume']) / exp['volume']
            add(f'STEP {tag}: volume = hand calculation', relh < 1e-6, f'rel {relh:.1e}')
        be = box_err(o['box'], part['model']['box'])
        add(f'STEP {tag}: size = model', be < 1e-4, f'max corner difference {be:.2e} mm')
        if exp['box']:
            bh = box_err(o['box'], exp['box'])
            add(f'STEP {tag}: size = hand calculation', bh < 1e-4, f'max corner difference {bh:.2e} mm')
        if 'hole_cylinders' in s:
            errs = [h['radius_error'] for h in s['hole_cylinders']]
            add(f'STEP {tag}: every hole is an exact cylinder of the design size, on its axis', all(e is not None and e < 1e-6 for e in errs), f'max radius error {max((e for e in errs if e is not None), default=float("nan")):.1e} mm, missing {sum(e is None for e in errs)}')
            terrs = [h['radius_error'] for h in s['hole_radii_in_text']]
            add(f'STEP {tag}: hole radii in the file text (no CAD library)', all(e is not None and e < 1e-6 for e in terrs), f'max {max((e for e in terrs if e is not None), default=float("nan")):.1e} mm')
    for key, r in res.get('same_triangles', {}).items():
        lim = 0.0 if key.endswith('ascii') else 2e-7 * max(1.0, max(abs(x) for x in part['model']['box']['max'] + part['model']['box']['min']))
        add(f'STL {key}: same triangles as the mm binary file' + (' (bit for bit)' if key.endswith('ascii') else ' (x 25.4, float rounding)'), r['same_count'] and r['max_difference_mm'] <= lim,
            f"same count {r['same_count']}, max difference {r.get('max_difference_mm', float('nan')):.2e} mm")
    for s in res['stl']:
        tag = s['file'].split(part['slug'] + '-')[1]
        own = s['own']
        add(f'STL {tag}: file well-formed (own parser)', not s['raw_problems'], '; '.join(s['raw_problems']) or f"{s['triangles']} triangles, {s['format']}")
        add(f'STL {tag}: closed, manifold, consistently oriented (own edge count)', own['open_edges'] == 0 and own['nonmanifold_edges'] == 0 and own['misoriented_directed_edges'] == 0 and own['repeated_corner_triangles'] == 0 and s['zero_area_triangles'] == 0,
            f"open {own['open_edges']}, non-manifold {own['nonmanifold_edges']}, misoriented {own['misoriented_directed_edges']}, degenerate {own['repeated_corner_triangles'] + s['zero_area_triangles']}")
        add(f'STL {tag}: stored normals match the winding', s['normal_winding_min_cos'] > 0.999, f"min cos {s['normal_winding_min_cos']:.6f}")
        add(f'STL {tag}: outward (positive volume)', s['volume'] > 0, f"{s['volume']:.4f} mm³")
        genus = (2 - own['euler']) / 2
        add(f'STL {tag}: through holes (Euler) = design', genus == exp['genus'], f'genus {genus:g}, design {exp["genus"]}')
        defl = s['exporter'].get('linearDeflection')
        if 'trimesh' in s:
            tmr, mf, ml, ad, pi = s['trimesh'], s['manifold3d'], s['meshlab'], s['admesh'], s['prusa_info']
            add(f'STL {tag}: trimesh watertight / winding / volume', tmr['is_watertight'] and tmr['is_winding_consistent'] and tmr['is_volume'] and tmr['bodies'] == 1, json.dumps({k: tmr[k] for k in ('is_watertight', 'is_winding_consistent', 'is_volume', 'bodies')}))
            add(f'STL {tag}: Manifold library accepts it as a solid', mf['status'] == 'NoError' and mf['genus'] == exp['genus'], f"status {mf['status']}, genus {mf['genus']}")
            add(f'STL {tag}: MeshLab: no boundary or non-manifold edges, no self-intersections', ml['boundary_edges'] == 0 and ml['non_two_manifold_edges'] == 0 and ml['non_two_manifold_vertices'] == 0 and ml['self_intersecting_faces'] == 0 and ml['connected_components'] == 1,
                f"boundary {ml['boundary_edges']}, non-manifold edges {ml['non_two_manifold_edges']}, vertices {ml['non_two_manifold_vertices']}, self-intersecting faces {ml['self_intersecting_faces']}, pieces {ml['connected_components']}")
            add(f'STL {tag}: ADMesh finds nothing to repair', ad['clean'], json.dumps({k: ad[k] for k in ad if k not in ('clean', 'volume')}))
            add(f'STL {tag}: PrusaSlicer reads it as manifold, one part', pi['ok'], f"manifold {pi.get('manifold')}, parts {pi.get('number_of_parts')}, size {pi.get('size_x')} x {pi.get('size_y')} x {pi.get('size_z')}")
            if s['file'].endswith('-in-binary.stl'):
                # The inch file holds inch numbers: a slicer shows it 25.4 x small. Check it is exactly that.
                sz = [float(pi.get(k, 'nan')) for k in ('size_x', 'size_y', 'size_z')]
                mb = part['model']['box']; want = [(mb['max'][k] - mb['min'][k]) / IN for k in range(3)]
                add(f'STL {tag}: inch numbers (slicer sees 1/25.4 size, as documented)', all(abs(a - b) <= 1e-4 * max(1, b) + defl / IN for a, b in zip(sz, want)), f'slicer size {sz}, part / 25.4 = {[round(x, 6) for x in want]}', info=True)
            if s.get('prusa_slice') is not None:
                ps = s['prusa_slice']
                add(f'STL {tag}: PrusaSlicer slices it to G-code', ps['ok'], f"layers {ps.get('layers')}, top Z {ps.get('top_z')}, {ps.get('print_time')}, filament {ps.get('filament_mm')} mm, messages {ps.get('messages')}")
        # Volume and size against the hand calculation, within what the chord tolerance allows.
        area = s.get('trimesh', {}).get('area')
        if exp['volume'] and area:
            dv = abs(s['volume'] - exp['volume'])
            add(f'STL {tag}: volume = hand calculation within area x tolerance', dv <= area * defl, f"{s['volume']:.3f} vs {exp['volume']:.3f} mm³: off {dv:.3f} mm³ = {100 * dv / exp['volume']:.4f}% (bound {area * defl:.1f} mm³)")
        mb = exp['box'] or part['model']['box']
        be = box_err(s['box'], mb)
        add(f'STL {tag}: size = {"hand calculation" if exp["box"] else "model"} within tolerance', be <= defl + 1e-4, f'max corner difference {be:.5f} mm (tolerance {defl} mm)')
        if 'deviation' in s:
            d = s['deviation']
            within = d['hausdorff'] <= defl * 1.001 + 1e-5
            unresolved = sum(d.get('unresolved_over_limit', [0, 0]))
            j = d.get('joints')
            joint_only = (not within) and j is not None and j['over_limit_elsewhere'] == 0
            detail = f"STL→exact {d['stl_to_exact_max']:.5f} mm, exact→STL {d['exact_to_stl_max']:.5f} mm; setting {defl} mm; promise {PROMISE_MM} mm"
            if unresolved:
                detail += f"; {unresolved} samples could not be ruled out (cap reached)"
            if joint_only:
                detail += (f"; all {j['over_limit_at_joints']} points over the setting are within one triangle of a file corner that is itself off the exact surface"
                           f" by at least the excess (largest {j['largest_corner_gap']:.4f} mm): the file follows the model's joint edge there, the model's own accuracy,"
                           f" as the app's Note says")
            elif j is not None and not within:
                detail += f"; {j['over_limit_elsewhere']} points over the setting away from joints (largest {j['largest_elsewhere']:.5f} mm)"
            add(f'STL {tag}: surface deviation (two-sided Hausdorff) within the setting' + (' (away from joints)' if joint_only else ''),
                (within or joint_only) and unresolved == 0, detail)
            add(f'STL {tag}: surface deviation within the 0.005 in promise', d['hausdorff'] <= PROMISE_MM, f"{d['hausdorff']:.5f} mm = {d['hausdorff'] / IN:.6f} in")
        if 'holes' in s:
            hs = s['holes']
            miss = [h['label'] for h in hs if 'error' in h]
            worst = max((h['worst_error'] for h in hs if 'worst_error' in h), default=0)
            add(f'STL {tag}: holes found and within tolerance (cut and measured)', not miss and worst <= defl + 1e-4, f'worst radial error {worst:.5f} mm; missing {miss}')
        if 'walls' in s and exp['minWall']:
            w = s['walls']
            add(f'STL {tag}: thinnest wall (ray cast, 1st percentile) vs design {exp["minWall"]:.3f} mm', w['p1'] >= exp['minWall'] - 0.02, f"min {w['min']:.3f}, p1 {w['p1']:.3f}, median {w['median']:.3f} mm", info=True)
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(Path(__file__).parent / 'out'))
    ap.add_argument('--parts', default='')
    ap.add_argument('--no-slice', action='store_true')
    ap.add_argument('--fast', action='store_true', help='full checks on the Fine mm STL only')
    ap.add_argument('--report-only', action='store_true', help='rebuild results.json and RESULTS.md from the parts already checked')
    a = ap.parse_args()
    out = Path(a.out)
    entries = []
    for d in sorted(out.iterdir()):
        mf = d / 'manifest-entry.json'
        if d.is_dir() and mf.exists():
            entries.append(json.loads(mf.read_text()))
    only = [x for x in a.parts.split(',') if x]
    if only:
        entries = [e for e in entries if any(e['slug'].startswith(o) for o in only)]
    rng = np.random.default_rng(20261106)
    if a.report_only:
        results = []
        for e in entries:
            f = out / e['slug'] / 'check-result.json'
            if not f.exists():
                continue
            res = json.loads(f.read_text())
            e['files_by_path'] = {x['file']: x for x in e['files'].values()}
            res['verdicts'] = verdicts(e, res)  # same rules as a full run, so a rule fix applies here too
            f.write_text(json.dumps(res, indent=1, default=float))
            results.append(res)
        tools = json.loads((out / 'tools.json').read_text()) if (out / 'tools.json').exists() else {}
        (out / 'results.json').write_text(json.dumps({'tools': tools, 'parts': results}, indent=1, default=float))
        write_markdown(out / 'RESULTS.md', tools, results)
        fails = sum(1 for r in results for x in r['verdicts'] if not x['ok'] and not x['info'])
        print(f'{len(results)} parts, {fails} failed checks')
        return 1 if fails else 0
    tools = {'python': sys.version.split()[0], 'numpy': np.__version__, 'trimesh': trimesh.__version__, 'manifold3d': getattr(manifold3d, '__version__', 'installed'),
             'admesh': run(['admesh', '--version'])[1].strip().splitlines()[0], 'prusa-slicer': run(['prusa-slicer', '--help'])[1].splitlines()[0]}
    try:
        from importlib.metadata import version; tools['OCP (OpenCascade for Python, cadquery-ocp)'] = version('cadquery-ocp')
    except Exception:
        tools['OCP (OpenCascade for Python, cadquery-ocp)'] = 'installed'
    try:
        from importlib.metadata import version; tools['pymeshlab'] = version('pymeshlab'); tools['manifold3d'] = version('manifold3d')
    except Exception:
        pass
    (out / 'tools.json').write_text(json.dumps(tools, indent=1))
    results = []
    for part in entries:
        t0 = time.time()
        part['files_by_path'] = {f['file']: f for f in part['files'].values()}
        d = out / part['slug']
        res = {'slug': part['slug'], 'title': part['title'], 'covers': part['covers'], 'step': [], 'stl': []}
        ref_shape = None
        for f in sorted(part['files'].values(), key=lambda f: f['file']):
            if f['kind'] != 'step':
                continue
            s, shape = check_step(d / f['file'], part)
            res['step'].append(s)
            if f['options']['unit'] == 'mm' and f['options']['schema'] == 'AP214':
                ref_shape = shape
        for f in sorted(part['files'].values(), key=lambda f: f['file']):
            if f['kind'] != 'stl':
                continue
            # Full checks on the mm binary files (what the app saves by default); the ASCII and inch
            # files get the file-level checks and are compared triangle by triangle with the mm binary one.
            full = (f['options']['format'] == 'binary' and f['options']['unit'] == 'mm') and (not a.fast or f['file'].endswith('fine-mm-binary.stl'))
            slice_it = not a.no_slice and f['file'].endswith('fine-mm-binary.stl')
            res['stl'].append(check_stl(d / f['file'], part, ref_shape if full and f['options']['unit'] == 'mm' and f['options']['format'] == 'binary' else None, rng, full, slice_it))
        same_as_binary(d, part, res)
        res['verdicts'] = verdicts(part, res)
        res['seconds'] = round(time.time() - t0, 1)
        bad = [x for x in res['verdicts'] if not x['ok'] and not x['info']]
        print(f"{part['slug']}: {len(res['verdicts']) - len(bad)}/{len(res['verdicts'])} passed ({res['seconds']} s)" + ''.join(f"\n   FAIL {x['check']}: {x['detail']}" for x in bad), flush=True)
        results.append(res)
        (d / 'check-result.json').write_text(json.dumps(res, indent=1, default=float))
    (out / 'results.json').write_text(json.dumps({'tools': tools, 'parts': results}, indent=1, default=float))
    write_markdown(out / 'RESULTS.md', tools, results)
    fails = sum(1 for r in results for x in r['verdicts'] if not x['ok'] and not x['info'])
    print(f'\n{fails} failed checks')
    return 1 if fails else 0


def write_markdown(path, tools, results):
    L = ['# Independent print verification: results', '', 'Written by `verify/print/check_parts.py`. Tools:', '']
    L += [f'- {k}: {v}' for k, v in tools.items()]
    L += ['', '| Part | Checks passed | Fine STL deviation (mm) | Worst hole error (mm) | Thinnest wall p1 (mm) | Slices |', '|---|---|---|---|---|---|']
    for r in results:
        hard = [x for x in r['verdicts'] if not x['info']]
        ok = sum(x['ok'] for x in hard)
        fine = next((s for s in r['stl'] if s['file'].endswith('fine-mm-binary.stl')), None)
        dev = f"{fine['deviation']['hausdorff']:.4f}" if fine and 'deviation' in fine else '-'
        hole = f"{max(h.get('worst_error', float('nan')) for h in fine['holes']):.4f}" if fine and fine.get('holes') else '-'
        wall = f"{fine['walls']['p1']:.3f}" if fine and 'walls' in fine else '-'
        sl = fine.get('prusa_slice') if fine else None
        sls = f"yes, {sl['layers']} layers, {sl['print_time']}" if sl and sl['ok'] else ('no' if sl else '-')
        L.append(f"| {r['title']} | {ok}/{len(hard)} | {dev} | {hole} | {wall} | {sls} |")
    for r in results:
        L += ['', f"## {r['title']}", '', f"Covers: {r['covers']}", '']
        for x in r['verdicts']:
            L.append(f"- {'PASS' if x['ok'] else ('note' if x['info'] else '**FAIL**')} {x['check']}: {x['detail']}")
    path.write_text('\n'.join(L) + '\n')


if __name__ == '__main__':
    sys.exit(main())
