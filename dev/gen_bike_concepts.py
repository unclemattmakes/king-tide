"""Batch-generate per-class bike concepts via ComfyUI/SDXL (one VRAM session).

DESIGN content is from docs/bike-art-direction.md (the "hover-moto" thesis:
Wave Race jetski x Jet Moto dirt-bike; maintained-salvage; locked
livery/chassis/glow). FRAMING is a clean studio product shot, NOT the doc's
"concept art / cel shading" wording -- that produced painterly multi-view
sheets with motion streaks + cast shadows, which are poor image->3D inputs.
The game's toy/cel register is applied in-engine by materials, so the Hunyuan
input just needs a clean solid single form.

Writes to <content>/concept-art/hoverbikes/<id>-gen/<id>_v3_s<seed>.png.
Usage: python dev/gen_bike_concepts.py [bike1 ...]   (default: all five)
"""
import os
import sys

_WT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_WT, "tools"))
import comfyui_gen as cg  # noqa: E402
import make_level_props as mlp  # noqa: E402

# Clean product-shot framing + the load-bearing design keywords from the doc.
STYLE = (
    "a single futuristic hover racing bike, hover-moto: a Wave Race stand-up "
    "jetski fused with a Jet Moto dirt-bike and lifted off the water, planing "
    "hull/ski prow, straddle riding seat, sport fairing and tail, vertical "
    "wave-reading fin, twin rear thruster pods, centre exhaust, NO WHEELS, "
    "maintained-salvage repainted plating, bold flat color blocking, strong "
    "readable silhouette, rounded-but-faceted forms, stylized game asset, "
    "three-quarter front view, full vehicle centered in frame, hovering, plain "
    "solid white background, clean even studio product lighting, sharp focus"
)

NEG = (
    "concept art sheet, turnaround, multiple views, multiple angles, grid, inset "
    "thumbnail, side panels, motion blur, speed lines, cast shadow, drop shadow, "
    "reflection, water, sea, ocean, waves, splash, rider, person, pilot, wheels, "
    "wheel, tires, car, truck, motorcycle, fighter jet, airplane, wings, mech, "
    "robot legs, text, watermark, logo, signature, painterly, sketch, lowres, "
    "blurry, deformed, cluttered background"
)

# Per-bike design blocks (from the doc, hex stripped -- color words carry it).
BIKES = {
    "cruiser": (
        "heavy long low wide hover cruiser, drowned-world muscle bike, big slab "
        "spray-cutting nose, oversized twin thruster cowls, broad full fairing, "
        "deep marine intakes, thick repainted steel-blue armor plating with rivets, "
        "near-black chassis, glowing cyan thruster throats, planted stable "
        "heavyweight stance, steel blue body, near-black metal, cyan glow"),
    "racer": (
        "balanced sport hover-bike, clean aerodynamic fairing, single bold gold "
        "livery stripe, neatly faired mid-mounted twin thrusters, modest swept fin, "
        "aggressive-but-friendly rake, well-maintained orange-red bodywork, "
        "graphite chassis, warm gold thruster glow, orange-red body, graphite "
        "metal, gold glow"),
    "stunt": (
        "compact agile freestyle hover trick-bike, short tall twitchy proportions, "
        "steep rake weight-forward, tall expressive wave-reading fin, stubby "
        "aggressive fairing, exposed flickable frame, knobbly grips, forest-green "
        "bodywork, dark green-black chassis, bright lime edge-glow, forest green "
        "body, dark metal, lime glow"),
    "scout": (
        "heavy armored low-slung expedition hover-scout, ground-hugging skirted "
        "hull, wide armored shoulders, biggest twin thrusters, blunt purposeful "
        "prow with a powered headlamp, bolted shield-plating, mismatched patched "
        "panels kept battle-ready, rugged utility kit, burnt-orange bodywork, "
        "graphite chassis, ice-cyan running lights, burnt orange body, graphite "
        "metal, ice cyan glow"),
    "sparrow": (
        "tiny lean lightweight hover sport-bike, cafe-racer of the sea, "
        "stripped-to-essentials exposed lightweight frame, minimal aero cowl, "
        "slender twin thrusters, delicate swept-back wing-like fin, high taut "
        "springy stance, bare honest panels, single mustard-gold livery wrap, "
        "mustard gold body, charcoal metal, pale gold glow"),
}

SEEDS = [5, 21, 44, 77]


def main():
    want = sys.argv[1:] or list(BIKES.keys())
    content = os.environ.get("HOVERBIKE_CONTENT_ROOT", r"C:\project-content\hoverbike")
    mlp.hunyuan_stop()
    mlp.comfy_up()
    for bike in want:
        pos = STYLE + ", " + BIKES[bike]
        out_dir = os.path.join(content, "concept-art", "hoverbikes", f"{bike}-gen")
        os.makedirs(out_dir, exist_ok=True)
        for seed in SEEDS:
            out = os.path.join(out_dir, f"{bike}_v3_s{seed}.png")
            cg.generate(pos, out, neg=NEG, width=1024, height=768, steps=30,
                        cfg=7.0, seed=seed)
            print(f"[concept] {bike} saved {out}")


if __name__ == "__main__":
    main()
