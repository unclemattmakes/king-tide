"""Throwaway inspector: report COLOR_0 type + A/G channel ranges across prop GLBs.

Tells us which props carry baked edge-wear convexity (A varies below 1) vs ship
flat (A==1 everywhere → edge-wear is a silent no-op) vs lack alpha (VEC3).

    python tools/blender/_inspect_color0.py "public/assets/props/**/*.glb"
"""
from __future__ import annotations

import glob
import json
import struct
import sys

_JSON, _BIN = 0x4E4F534A, 0x004E4942
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
    norm = a.get("normalized", False)
    ct = a["componentType"]
    rows = [struct.unpack_from(fmt, binbuf, base + i * stride) for i in range(a["count"])]
    if norm and ct in (5121, 5123):
        maxv = 255.0 if ct == 5121 else 65535.0
        rows = [tuple(c / maxv for c in r) for r in rows]
    return rows, a["type"], ct, norm


def inspect(path: str) -> None:
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        print(f"  {path}: not a GLB")
        return
    off, chunks = 12, {}
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        chunks[ctype] = (off, clen)
        off += clen
    joff, jlen = chunks[_JSON]
    boff, _ = chunks[_BIN]
    gltf = json.loads(data[joff:joff + jlen])
    binbuf = data[boff:]

    rel = path.replace("\\", "/").split("props/")[-1]
    prims = 0
    has_c0 = False
    types = set()
    a_lo, a_hi, g_lo, g_hi = 1e9, -1e9, 1e9, -1e9
    nverts = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            prims += 1
            at = prim["attributes"]
            if "COLOR_0" not in at:
                continue
            has_c0 = True
            rows, typ, ct, norm = _read(gltf, binbuf, at["COLOR_0"])
            types.add(typ)
            nverts += len(rows)
            for r in rows:
                g = r[1]
                g_lo, g_hi = min(g_lo, g), max(g_hi, g)
                if len(r) >= 4:
                    a = r[3]
                    a_lo, a_hi = min(a_lo, a), max(a_hi, a)
    if not has_c0:
        print(f"  {rel:38s} NO COLOR_0  ({prims} prims)")
        return
    tstr = "/".join(sorted(types))
    if a_lo > a_hi:  # no VEC4 prim
        print(f"  {rel:38s} {tstr:10s} G[{g_lo:.2f},{g_hi:.2f}]  (no alpha)")
        return
    worn = "EDGE-WEAR" if a_lo < 0.98 else "flat A=1 "
    print(f"  {rel:38s} {tstr:10s} A[{a_lo:.3f},{a_hi:.3f}] {worn} G[{g_lo:.2f},{g_hi:.2f}]  {nverts}v")


def main() -> None:
    args = sys.argv[1:] or ["public/assets/props/**/*.glb"]
    paths = []
    for a in args:
        paths += sorted(glob.glob(a, recursive=True)) or [a]
    for p in paths:
        inspect(p)


if __name__ == "__main__":
    main()
