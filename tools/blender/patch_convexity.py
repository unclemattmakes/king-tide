"""Patch per-vertex edge-wear convexity into already-conditioned prop GLBs'
COLOR_0.A, in place — the way to add (or refresh) the edge-wear channel on the
EXISTING prop library without re-conditioning from source (which risks the
keep_material texture).

For each vertex, average ``dot(normalized incident-edge dir, vertex normal)`` —
convex verts trend negative — and store ``A = 1 - convex-edge-strength`` (1 = flat,
<1 = convex ridge). The painterly-vinyl material reads ``(1 - A)`` to drybrush
raised edges.

WELDED CONVEXITY. Hard-surface game-kit props (Quaternius crates, barrels,
containers, fences…) ship with the vertices SPLIT along every hard edge, so a
naive per-primitive neighbour graph only ever connects coplanar in-face verts —
whose incident edges are perpendicular to the face normal — and convexity reads
~0 everywhere (the prop stays flat A=1, no wear). We therefore weld vertices by
position first: dedupe coincident verts, recompute a SMOOTH per-position normal
from the incident faces, build the neighbour graph in welded space, compute one
convexity per unique position, and map ``A = 1 - conv`` back onto every original
(split) vertex sharing that position. This lights up the corners/edges of
hard-surface props while leaving genuinely-smooth forms (a featureless sphere)
correctly at ~0. Same algorithm as the source bake
(``vertex_attrs.welded_convexity``, used by ``condition_ai_mesh`` + the runtime
primitive stamp ``edge-wear-convexity.ts``) — kept standalone (pure Python, no
Blender) so it can run over shipped GLBs.

ONLY the COLOR_0 alpha component is rewritten (same accessor layout, in place),
so POSITION/NORMAL/UVs, material, embedded texture, collider, and extras are all
left byte-for-byte untouched. Pure Python — no Blender, no deps.

Run:
    python tools/blender/patch_convexity.py public/assets/props/cc0/cliff_1.glb
    python tools/blender/patch_convexity.py "public/assets/props/**/*.glb"
"""
from __future__ import annotations

import glob
import json
import math
import struct
import sys

GAIN = 1.6
# Position-weld grid (metres). Coincident split verts share an EXACT position so
# any precision merges them; this only bounds how close two DISTINCT verts may be
# before they fold together — 0.01 mm is far below any real game-prop feature.
WELD_DECIMALS = 5
_JSON, _BIN = 0x4E4F534A, 0x004E4942
# glTF componentType -> (struct char, byte size)
_CT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
       5125: ("I", 4), 5126: ("f", 4)}
_COMPS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _acc(gltf, idx):
    a = gltf["accessors"][idx]
    bv = gltf["bufferViews"][a["bufferView"]]
    comps = _COMPS[a["type"]]
    chr_, sz = _CT[a["componentType"]]
    stride = bv.get("byteStride") or comps * sz
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    return a, base, comps, chr_, sz, stride


def _read(gltf, binbuf, idx):
    a, base, comps, chr_, _sz, stride = _acc(gltf, idx)
    fmt = "<%d%s" % (comps, chr_)
    return [struct.unpack_from(fmt, binbuf, base + i * stride) for i in range(a["count"])]


def _weld(pos):
    """Group vertices by quantized position. Returns ``(uniq_pos, orig2uniq)``
    where ``orig2uniq[i]`` is the unique-position index of original vert ``i``."""
    key_to_uniq: dict = {}
    uniq_pos: list = []
    orig2uniq = [0] * len(pos)
    for i, p in enumerate(pos):
        key = (round(p[0], WELD_DECIMALS), round(p[1], WELD_DECIMALS), round(p[2], WELD_DECIMALS))
        u = key_to_uniq.get(key)
        if u is None:
            u = len(uniq_pos)
            key_to_uniq[key] = u
            uniq_pos.append(p)
        orig2uniq[i] = u
    return uniq_pos, orig2uniq


def _smooth_normals(pos, tris):
    """Area-weighted (un-normalized) vertex normals from incident face normals —
    the SMOOTH normal a welded mesh would carry, which is what convexity wants
    (the GLB's per-split-vert hard normal would defeat the measure)."""
    nrm = [[0.0, 0.0, 0.0] for _ in pos]
    for a, b, c in tris:
        ax, ay, az = pos[a]
        ux, uy, uz = pos[b][0] - ax, pos[b][1] - ay, pos[b][2] - az
        vx, vy, vz = pos[c][0] - ax, pos[c][1] - ay, pos[c][2] - az
        fx, fy, fz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        for k in (a, b, c):
            nrm[k][0] += fx
            nrm[k][1] += fy
            nrm[k][2] += fz
    return nrm


def _convexity(pos, nrm, neigh):
    out = [0.0] * len(pos)
    for i, ns in enumerate(neigh):
        if not ns:
            continue
        nx, ny, nz = nrm[i]
        nl = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        nx, ny, nz = nx / nl, ny / nl, nz / nl
        px, py, pz = pos[i]
        acc, cnt = 0.0, 0
        for j in ns:
            dx, dy, dz = pos[j][0] - px, pos[j][1] - py, pos[j][2] - pz
            dl = math.sqrt(dx * dx + dy * dy + dz * dz)
            if dl < 1e-9:
                continue
            acc += (dx * nx + dy * ny + dz * nz) / dl
            cnt += 1
        if cnt:
            out[i] = max(0.0, min(1.0, -(acc / cnt) * GAIN))
    return out


def _welded_convexity(pos, tris):
    """Per-ORIGINAL-vertex convexity computed on the position-welded mesh, so
    hard-edge corners (split into several coincident verts) read convex. Returns
    a list index-aligned with ``pos``."""
    uniq_pos, orig2uniq = _weld(pos)
    utris = [(orig2uniq[a], orig2uniq[b], orig2uniq[c]) for a, b, c in tris]
    unrm = _smooth_normals(uniq_pos, utris)
    uneigh = [set() for _ in uniq_pos]
    for a, b, c in utris:
        uneigh[a].update((b, c))
        uneigh[b].update((a, c))
        uneigh[c].update((a, b))
    uconv = _convexity(uniq_pos, unrm, uneigh)
    return [uconv[orig2uniq[i]] for i in range(len(pos))]


def patch(path: str) -> None:
    data = bytearray(open(path, "rb").read())
    if data[:4] != b"glTF":
        print(f"  - {path}: not a GLB")
        return
    off, chunks = 12, {}
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        chunks[ctype] = (off, clen)
        off += clen
    joff, jlen = chunks[_JSON]
    boff, _blen = chunks[_BIN]
    gltf = json.loads(bytes(data[joff:joff + jlen]))
    binbuf = bytes(data)[boff:]  # accessor offsets are relative to the buffer (BIN)

    total, lo, hi = 0, 1.0, 0.0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            if "POSITION" not in at or "COLOR_0" not in at or "indices" not in prim:
                continue
            ca, cbase, ccomps, cchr, csz, cstride = _acc(gltf, at["COLOR_0"])
            if ccomps != 4:
                print(f"  - {path}: COLOR_0 is VEC{ccomps} (no alpha) - skipped")
                continue
            pos = _read(gltf, binbuf, at["POSITION"])
            idx = [v[0] for v in _read(gltf, binbuf, prim["indices"])]
            tris = [(idx[t], idx[t + 1], idx[t + 2]) for t in range(0, len(idx) - 2, 3)]
            conv = _welded_convexity(pos, tris)
            cct = ca["componentType"]
            maxv = {5121: 255.0, 5123: 65535.0}.get(cct)
            for i in range(len(pos)):
                a_val = 1.0 - conv[i]
                lo, hi = min(lo, a_val), max(hi, a_val)
                aoff = boff + cbase + i * cstride + 3 * csz  # alpha = 4th component
                if maxv:
                    struct.pack_into("<" + cchr, data, aoff, int(round(a_val * maxv)))
                elif cct == 5126:
                    struct.pack_into("<f", data, aoff, a_val)
            total += len(pos)
    if total:
        open(path, "wb").write(data)
        print(f"  OK {path}: {total} verts, A range [{lo:.3f}, {hi:.3f}]")
    else:
        print(f"  - {path}: no patchable primitive (needs POSITION+indices+VEC4 COLOR_0)")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        raise SystemExit("usage: patch_convexity.py <glb> [<glb> ...]")
    paths = []
    for a in args:
        paths += glob.glob(a, recursive=True) or [a]
    for p in paths:
        patch(p)


if __name__ == "__main__":
    main()
