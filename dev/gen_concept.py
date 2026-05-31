"""Generate bike concept variations via ComfyUI/SDXL (txt2img).

Usage: python dev/gen_concept.py <out_dir> <stem> <seed1> [seed2 ...]
Override the subject with $CONCEPT_POS (per-bike prompts); $CONCEPT_NEG_EXTRA
appends to the negative.
"""
import os
import sys

_WT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_WT, "tools"))
import comfyui_gen as cg  # noqa: E402
import make_level_props as mlp  # noqa: E402

# Design direction (Matt, 2026-05-31): hover JET-SKI, a mix of Wave Race jet
# skis and JetMoto hover-sleds -- NOT a motocross bike. Long straddle hull,
# central handlebar column, rear jet propulsion, wheel-less hover.
POS = os.environ.get("CONCEPT_POS") or (
    "a single futuristic hover jet-ski racer, personal watercraft styling crossed "
    "with a JetMoto hover-sled and a Wave Race jet ski, LONG LOW NARROW slender "
    "torpedo hull, lean streamlined fuselage that is much longer than it is wide, "
    "central handlebar column, low straddle racing seat saddle, rear jet turbine "
    "propulsion nozzle, compact tight side fairings, levitating just above the "
    "ground on a glowing repulsor underside, no wheels, orange and teal racing "
    "livery with white panels and bold number 21, three-quarter front view, "
    "slight high angle, full vehicle centered in frame, hovering in empty studio "
    "space, studio product photography, plain solid white background, soft even "
    "studio lighting, sharp focus, sleek sci-fi industrial design concept render, "
    "game asset reference"
)
NEG = (cg.DEFAULT_NEG + ", wheels, wheel, tires, tire, spokes, rim, motorcycle, "
       "dirt bike, motocross, kickstand, water, sea, ocean, waves, splash, spray, "
       "ground, floor, road, shadow, rider, person, wings, delta wings, wide wings, "
       "airplane, jet fighter, spaceship, manta ray, wingspan, fins sticking out, "
       "wide body"
       + os.environ.get("CONCEPT_NEG_EXTRA", ""))


def main():
    out_dir, stem = sys.argv[1], sys.argv[2]
    seeds = [int(s) for s in sys.argv[3:]] or [12345]
    os.makedirs(out_dir, exist_ok=True)
    mlp.hunyuan_stop()      # free VRAM for SDXL
    mlp.comfy_up()          # ensure ComfyUI is serving
    for seed in seeds:
        out = os.path.join(out_dir, f"{stem}_s{seed}.png")
        cg.generate(POS, out, neg=NEG, width=1024, height=768, steps=30,
                    cfg=7.0, seed=seed)
        print(f"[concept] saved {out}")


if __name__ == "__main__":
    main()
