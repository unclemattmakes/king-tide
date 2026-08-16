# Credits & third-party content

Everything third-party or AI-generated that ships in the game, with license
and source. The in-game CREDITS screen renders the same data (the soundtrack
list is generated from `src/engine/audio/soundtrack.generated.ts`, which is
built from the `credits.json` sidecar that lives next to the source audio —
see `tools/convert-music.mjs`). Licensing scheme for the project itself:
code is [MIT](LICENSE), first-party content is
[CONTENT-LICENSE.md](CONTENT-LICENSE.md).

## Soundtrack

Fourteen tracks by independent artists via the
[Free Music Archive](https://freemusicarchive.org). Each track remains © its
artist and is used under the license listed. Our only modification:
transcoded mp3 → Opus for streaming. Verified against the source pages
2026-08-12.

| Track | Artist | License | Source |
|---|---|---|---|
| Suddenly It Occurs To Me There's No Ocean Here | Artificial Intelligence | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Artificial_Intelligence_in_Texas_1163/the-ai-in-texas-anthology-1985-2020/suddenly-it-occurs-to-me-theres-no-ocean-here/) |
| Rad Racer | Atomicos | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Atomicos/Surf_Music_Month_Challenge/08_Rad_Racer) |
| Tidalwave | Avantist | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [FMA](https://freemusicarchive.org/music/avantist/avantist/tidalwave/) |
| 900 Turbo | Blue Wave Theory | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Blue_Wave_Theory/Superstorm/900-turbo) |
| Frisbeat | Blue Wave Theory | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Blue_Wave_Theory/Superstorm/frisbeat) |
| Get Your Kicks on Future 86 | Blue Wave Theory | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Blue_Wave_Theory/Superstorm/get-your-kicks-on-future-86-1/) |
| Road Hazard | Blue Wave Theory | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Blue_Wave_Theory/Surf_Music_Month_Challenge/Blue_Wave_Theory_-_Road_Hazard) |
| Hawaii 5-0 (CB 203) | Checkie Brown | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [FMA](https://freemusicarchive.org/music/Checkie_Brown_1005/checkie-brown-elevator-2/hawaii-5-0-cb-203/) |
| Beach Party | Crowander | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | [FMA](https://freemusicarchive.org/music/crowander/from-the-garage-funkrock/beach-party) |
| Whisky | Crowander | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | [FMA](https://freemusicarchive.org/music/crowander/from-the-garage-funkrock/whisky) |
| Western ShowDown | HoliznaCC0 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | [FMA](https://freemusicarchive.org/music/holiznacc0/left-overs/western-showdown/) |
| Twango | Mr Smith | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [FMA](https://freemusicarchive.org/music/mr-smith/streamliner/twango/) |
| Bum Lyfe | Untimely Dosage | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [FMA](https://freemusicarchive.org/music/the-what-now/smells-like-the-bronx-in-here-the-lamaas-collection/bum-lyfe/) |
| Sunny Positive Surf Rock (Sandy Shores) | Vlad Annenkov | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [FMA](https://freemusicarchive.org/music/vlad-annenkov/single/sunny-positive-surf-rock-sandy-shoresmp3/) |

Two standing constraints we honour:

- **NonCommercial (3 tracks — Checkie Brown, Crowander ×2):** valid only while
  the game has zero monetization (no sales, ads, or sponsorship). If that ever
  changes, replace these tracks first.
- **ShareAlike (7 tracks — the 6 CC BY-SA *plus* Checkie Brown's CC BY-NC-SA):**
  promotional **videos** with these tracks baked into the audio are adaptations
  under CC 4.0's synch clause and must themselves ship under the same licence —
  BY-SA for six of them, and BY-**NC**-SA for "Hawaii 5-0", which additionally
  forces that video non-commercial. In-game playback and the CDN-served files
  are fine.

## Brush textures

The hand-painted surface look builds on the **Brushstroke Tools** oil-paint
brush styles by **Simon Thommes / Blender Studio** (Project Gold),
© Blender Foundation, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) —
[studio.blender.org](https://studio.blender.org/tools/addons/brushstroke_tools).
Modified for this game: the scanned brush maps were sliced, recentred, and
baked into the tiling brush-stroke texture used by the painterly materials
(see `tools/blender/brush_stamps/README.md`).

## 3D props & rider

- **Quaternius** ([quaternius.com](https://quaternius.com)) — environment/prop
  models from the Pirate, Stylized Nature, Toon Shooter, Downtown City,
  Textured Buildings, Cyberpunk, Crops, Cute Fish, Animated Fish, and Ships
  packs, all released **CC0 1.0** (public domain). Conditioned (rescaled,
  restyled, vertex-colored) through the pipeline in
  `tools/blender/condition_ai_mesh.py`; per-prop lineage in
  `specs/props/cc0/quaternius.json`. No attribution required — credited with
  gratitude.
- **Rider mannequin** — the on-bike rider mesh + riding pose derive from the
  Quaternius **Universal Animation Library** (`UAL1_Standard.glb`, UE-mannequin
  skeleton, **CC0**): [quaternius.com/packs/universalanimationlibrary.html](https://quaternius.com/packs/universalanimationlibrary.html).

## AI-generated content (disclosure)

Some placeholder props were machine-generated and carry **no copyright
claim** (raw AI output has no human author):

- **Concept images** — SDXL base 1.0 (CreativeML Open RAIL++-M) via local
  ComfyUI, plus Midjourney for track mood plates (not shipped in the repo).
- **Meshes** — *none ship.* A set of props was once generated with local
  **Tencent Hunyuan3D-2** from those concepts and hand-conditioned; all of it
  was **retired in 2026-08** and replaced with CC0 equivalents, because that
  model's licence forbids distributing its outputs into the EU, UK and South
  Korea — incompatible with a worldwide-playable game. No `ai/*` prop is
  referenced by any track, and the meshes are gone from the asset CDN.

The generation prompts and seeds remain in `specs/props/ai/*.json` as a record
of how that work was done. They are text, written by a human, and unaffected by
the model licence — but nothing built from them ships.

## Fonts

**Lilita One** and **Nunito**, both under the
[SIL Open Font License 1.1](https://openfontlicense.org/), loaded from Google
Fonts (nothing bundled in the repo).

## Sound effects

None to credit — all SFX are procedurally synthesised via Web Audio.
