"""Upgrade a prop GLB's VEC3 ``COLOR_0`` to VEC4 with baked edge-wear convexity.

A handful of older conditioned props (``cc0/anchor``, ``cc0/house_1..3``) carry a
VEC3 ``COLOR_0`` — no alpha channel — so ``patch_convexity.py`` skips them and they
can never show edge wear (the vinyl material reads ``1 − A``; TSL pads a missing
``.a`` to 1.0 → edge mask 0). This widens the channel to VEC4 and stamps
``A = 1 − welded-convexity`` (same measure as ``patch_convexity`` /
``vertex_attrs.welded_convexity``), so they pick up the drybrush like every other
prop.

Surgical, no Blender, no source mesh: the RGB values, POSITION, NORMAL, UVs,
material, texture, collider, and extras are all preserved. Each ``COLOR_0`` here
lives in its own tightly-packed FLOAT bufferView, so we read the RGB, append a
fresh VEC4 (R, G, B, 1−conv) block to the buffer, and re-point the accessor at
it — existing offsets never move. The old VEC3 bufferView is left orphaned
(harmless dead bytes).

Only handles non-interleaved FLOAT (componentType 5126) VEC3 COLOR_0 — the shape
Blender's glTF exporter emits. Anything else is skipped with a notice.

Run:
    python tools/blender/upgrade_vec3_color0.py public/assets/props/cc0/house_1.glb
    python tools/blender/upgrade_vec3_color0.py public/assets/props/cc0/{anchor,house_1,house_2,house_3}.glb
"""
from __future__ import annotations

import glob
import json
import struct
import sys

from patch_convexity import _JSON, _read, _welded_convexity  # noqa: E402


def _pad4(b: bytes, fill: bytes) -> bytes:
    return b + fill * ((4 - len(b) % 4) % 4)


def upgrade(path: str) -> None:
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        print(f"  - {path}: not a GLB")
        return
    off, chunks = 12, []
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunks.append((ctype, off + 8, clen))
        off += 8 + clen
    json_c = next((c for c in chunks if c[0] == _JSON), None)
    bin_c = next((c for c in chunks if c[0] == 0x004E4942), None)
    if json_c is None or bin_c is None:
        print(f"  - {path}: missing JSON/BIN chunk")
        return
    gltf = json.loads(data[json_c[1]:json_c[1] + json_c[2]])
    binbuf = data[bin_c[1]:bin_c[1] + bin_c[2]]
    buf = gltf["buffers"][0]
    buflen = buf["byteLength"]
    if buflen % 4 != 0:
        print(f"  - {path}: buffer not 4-aligned ({buflen}) — skipped")
        return

    new_blocks = bytearray()
    upgrades: list[tuple[int, dict]] = []
    skipped = 0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            if "COLOR_0" not in at or "POSITION" not in at or "indices" not in prim:
                continue
            ci = at["COLOR_0"]
            ca = gltf["accessors"][ci]
            if ca["type"] != "VEC3":
                continue  # already VEC4 (or scalar) — nothing to widen
            if ca["componentType"] != 5126:
                print(f"  - {path}: COLOR_0 componentType {ca['componentType']} not FLOAT — skipped")
                skipped += 1
                continue
            rgb = _read(gltf, binbuf, ci)
            pos = _read(gltf, binbuf, at["POSITION"])
            idx = [v[0] for v in _read(gltf, binbuf, prim["indices"])]
            tris = [(idx[t], idx[t + 1], idx[t + 2]) for t in range(0, len(idx) - 2, 3)]
            conv = _welded_convexity(pos, tris)
            block = bytearray()
            for i in range(ca["count"]):
                r, g, b = rgb[i][0], rgb[i][1], rgb[i][2]
                block += struct.pack("<4f", r, g, b, 1.0 - conv[i])
            # New bufferView appended after the existing buffer; offsets never move.
            new_bv = {
                "buffer": 0,
                "byteOffset": buflen + len(new_blocks),
                "byteLength": len(block),
                "target": 34962,  # ARRAY_BUFFER
            }
            new_blocks += block
            upgrades.append((ci, new_bv))

    if not upgrades:
        msg = "no VEC3 FLOAT COLOR_0 to upgrade" if not skipped else "nothing upgraded"
        print(f"  - {path}: {msg}")
        return

    for ci, new_bv in upgrades:
        gltf["bufferViews"].append(new_bv)
        a = gltf["accessors"][ci]
        a["type"] = "VEC4"
        a["bufferView"] = len(gltf["bufferViews"]) - 1
        a["byteOffset"] = 0

    new_bin = bytearray(binbuf[:buflen]) + new_blocks
    buf["byteLength"] = len(new_bin)

    new_json = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    new_bin = _pad4(bytes(new_bin), b"\x00")
    total = 12 + 8 + len(new_json) + 8 + len(new_bin)
    out = bytearray(b"glTF")
    out += struct.pack("<II", 2, total)
    out += struct.pack("<I", len(new_json)) + b"JSON" + new_json
    out += struct.pack("<I", len(new_bin)) + b"BIN\x00" + new_bin
    open(path, "wb").write(out)
    print(f"  OK {path}: upgraded {len(upgrades)} COLOR_0 prim(s) VEC3 -> VEC4 + edge-wear")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        raise SystemExit("usage: upgrade_vec3_color0.py <glb> [<glb> ...]")
    paths: list[str] = []
    for a in args:
        paths += glob.glob(a, recursive=True) or [a]
    for p in paths:
        upgrade(p)


if __name__ == "__main__":
    main()
