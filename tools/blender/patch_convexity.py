"""Patch per-vertex edge-wear convexity into already-conditioned prop GLBs'
COLOR_0.A, in place — the way to add the edge-wear channel to the EXISTING prop
library without re-conditioning from source (which risks the keep_material
texture).

Mirrors ``condition_ai_mesh._edge_convexity``: for each vertex, average
``dot(normalized incident-edge dir, vertex normal)`` — convex verts trend
negative — and store ``A = 1 - convex-edge-strength`` (1 = flat, <1 = convex
ridge). The painterly-vinyl material reads ``(1 - A)`` to drybrush raised edges.

ONLY the COLOR_0 alpha component is rewritten (same accessor layout, in place),
so POSITION/NORMAL/UVs, material, embedded texture, collider, and extras are all
left byte-for-byte untouched. Pure Python — no Blender, no deps.

Run:
    python tools/blender/patch_convexity.py public/assets/props/cc0/cliff_1.glb
    python tools/blender/patch_convexity.py public/assets/props/**/*.glb
"""
from __future__ import annotations

import glob
import json
import math
import struct
import sys

GAIN = 1.6
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


def _vertex_normals(pos, tris):
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
    return [tuple(v) for v in nrm]


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
            neigh = [set() for _ in pos]
            for a, b, c in tris:
                neigh[a].update((b, c))
                neigh[b].update((a, c))
                neigh[c].update((a, b))
            nrm = _read(gltf, binbuf, at["NORMAL"]) if "NORMAL" in at else _vertex_normals(pos, tris)
            conv = _convexity(pos, nrm, neigh)
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
