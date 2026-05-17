# Redout 2 (2022) — Spiritual Successor Reference

Research for hoverbike racer design. Focus on Redout 2 (34BigThings / Saber
Interactive, 2022), referencing the original Redout (2016) where useful.

## 1. Studio & lineage

- **34BigThings** is an indie studio based in Turin, Italy, founded in 2013.
  Acquired by Saber Interactive (Embracer Group) in 2021; Redout 2 shipped
  under Saber's publishing umbrella in June 2022.
- The original **Redout (2016)** was openly pitched as a spiritual sequel to
  **F-Zero** and WipEout. The studio's ModDB announcement literally titled the
  reveal "Introducing Red:OuT, a spiritual sequel to F-Zero." It became the
  community pick for "the closest thing to a new F-Zero on PC" after Nintendo
  shelved the series post-F-Zero GX.
- Redout 2 explicitly markets itself as "the fastest racing game in the
  universe" and pulls closer to F-Zero's pure-racing purity (no combat) than
  WipEout's weapon-based combat racing.

## 2. Lap length / race duration

- **Top speed**: documented at 1000+ km/h sustained, with leaderboard runs
  pushing 1250 km/h+ on Asera-class events. Time-attack guides on Steam
  reference "Can't finish <1250 km/h" challenges, indicating speed targets
  are baked into event design rather than a soft cap.
- **Race format**: 3 speed classes (plus a final "invitation" class) and 36
  unique tracks, each playable in reverse (=72 layouts). Races are typically
  3 laps; lap times sit in roughly the **30-60 second range** at the highest
  speed class — typical events finish in **90 seconds to ~3 minutes**.
- **Speedrun benchmark**: the "All Boss" world record (Sep 2025) is 47:19.323
  IGT — i.e., chaining all boss-track gauntlets back to back fits inside an
  hour. Boss races concatenate multiple tracks without loading screens.
- **Career scale**: 250+ events across 10 locations / 36 tracks.

## 3. Race structure & signature mechanics

- **Six-axis "fly the ship" controls**: left stick steers (yaw), right stick
  controls **strafe** (horizontal lean, pushes the craft sideways) and
  **pitch** (vertical lean, used to hug terrain on inclines/drops). Both
  shoulder buttons handle the two boost modes.
- **Strafe ≠ WipEout airbrakes**: WipEout airbrakes add rotational force;
  Redout 2 strafe translates the craft laterally. Tight corners are taken
  by *counter-strafing* (push opposite the turn) to widen the line while
  losing minimal speed — a manual drift system.
- **Pitch matters**: track terrain has steep grades; failing to pitch into
  the slope causes the underside to scrape and take damage.
- **Boost / heat / overheat death loop**:
  - Standard boost and **hyperboost** both heat the ship.
  - At max heat, you can keep boosting but each frame drains hull HP — you
    can literally explode your own ship by over-boosting.
  - Coasting (no boost, no collisions) cools and self-repairs.
  - On-track boost pads are *free* (no heat cost) — encourages racing-line
    optimization over throttle abuse.
- **No combat weapons**. There are *passive ship modules* (active/passive
  power-ups equipped pre-race: turbos, repair fields, magnetic stabilizers,
  etc.) but no missiles or mines fired at rivals. Closer to F-Zero than
  WipEout.
- **Event types**: Arena Race, Time Attack, **Last Man Standing** (last-place
  elimination, speed ramps each lap), **Speed** (drop below threshold = your
  craft is destroyed, à la *Speed* the movie), **Boss Race** (multi-track
  gauntlet, no loading), Endurance.
- **Career**: 250+ events gated by tier progression in three speed classes;
  AI difficulty and assists are auto-tuned to player performance after a
  mandatory tutorial.

## 4. Differences from F-Zero / WipEout

| Element | F-Zero GX | WipEout (HD/Omega) | Redout 2 |
|---|---|---|---|
| Combat | Side-attacks only | Missiles, mines, EMPs | None (passive modules only) |
| Steering | Stick + airbrake triggers | Stick + airbrake triggers | Stick + strafe + pitch (6-axis) |
| Boost cost | Hull energy | Energy / shield pool | Heat (overheat = self-destruct) |
| Top speed | ~1500 km/h (in-fiction) | ~800 km/h | 1000–1250+ km/h (real) |
| Lap count | 3 | 3 | 3 typical |
| Track count | 26 (GX) | ~24 (Omega Collection) | 36 (×2 reverse) |
| Track style | Twisting tubes, loops | Banked, sweeping | Vertical roller-coaster, big elevation |

Kept from the genre: anti-grav physics, extreme speed, soundtrack-driven
arcade feel, championship grind. Changed: control system is the most
demanding in the genre by consensus; no weapon meta-game; heat replaces
shield as the resource.

## 5. What players love

- **Pure speed**. Universally cited as the fastest-feeling racing game
  available. "Hypnotic" speed is the recurring adjective in reviews
  (autoevolution, Eurogamer, TheSixthAxis).
- **Soundtrack**. 42 original + 9 licensed EDM tracks (~3 hours); features
  Zardonic, Dance With The Dead, Technical Hitch, U-Recken, and Giorgio
  Moroder. Original Redout's OST is more highly regarded (more synthwave /
  personality); Redout 2 leans generic-EDM but is still praised in reviews.
- **Track design**. 36 tracks with reversibility, dramatic vertical
  rollercoaster geometry, plus boss tracks that chain segments seamlessly.
- **Value for money**. ~$30 base for 250+ events; reviewers consistently
  call out the content-per-dollar ratio.
- **High skill ceiling**. Once mastered, the strafe/pitch system feels
  uniquely expressive — community sentiment frames it as a "fighting-game
  for racers" depth curve.

## 6. What players criticize

- **Brutal difficulty curve**. Recurring across Metacritic user reviews,
  Steam reviews, and pretty much every professional review. Several
  reviewers reported failing the **tutorials**, particularly the third
  tutorial level. The Metacritic critic average is 70 partly for this.
- **Controls are overwhelming**. The dual-stick six-axis scheme has no
  precedent and the in-game tutorials are widely judged inadequate.
- **AI rubber-banding**. Confirmed via data-mining — "DT_AIDifficultyTuning"
  exists in game files. Rivals can close large gaps in seconds and the AI
  selectively boosts on certain track sections to catch up.
- **Career grind**. 250 events is a lot; some events require very specific
  ship tuning. Players reported re-running the same tier repeatedly to
  unlock the next class.
- **Launch performance & multiplayer**. Online lobbies were unstable at
  launch ("matches that can barely hold themselves together"). PC port had
  perf hitching on mid-range hardware initially; patched over time.
- **DLC integration**. Unlike Redout 1, DLC tracks (Summer Pack, Winter
  Pack) are *not* woven into the main career list — they sit in a separate
  bucket, so people pay for tracks they rarely use.

## 7. Most-requested features

From Steam/Reddit/Metacritic user discussion:

- **Better tutorials** / a proper practice mode that teaches
  counter-strafing and pitch-on-terrain explicitly.
- **DLC events folded into the main career list**, as Redout 1 did.
- **More accessible difficulty options** (separate AI aggression slider
  from rubber-band tuning).
- **Track editor / community tracks**.
- **More cockpit-camera options** and FOV tuning at extreme speeds.
- **Stable, populated online multiplayer** with cross-play.
- **Photo mode** and replay sharing.

## 8. Reception numbers

- **Metacritic critic**: ~70/100 ("Fair"), 46 reviews, recommended by 49%
  of critics.
- **OpenCritic**: similar mid-70s mixed reception.
- **Steam (lifetime)**: 82% positive of ~1,110 reviews ("Very Positive"
  tier). Recent-30-day window has trended ~90% positive — sentiment has
  improved post-launch as patches landed.
- **Sales**: ~$1M revenue and ~50,000 copies on Steam in the first month —
  reportedly ~100× the first-month revenue of the original Redout.
- **Platforms**: PC (Steam, EGS), PS4, PS5, Xbox One, Xbox Series, Switch.

## Summary (2 sentences)

Redout 2 is the most extreme anti-grav racer on the market: 1000+ km/h
"fly-the-ship" controls with strafe + pitch + heat-managed boost replace
WipEout's weapons and F-Zero's simpler stick steering, but the punishing
learning curve, divisive AI rubber-banding, and underbaked tutorials kept
critic scores in the 70s despite a "Very Positive" Steam aggregate. For a
hoverbike racer, the lessons are clear — players will tolerate a deep
control scheme **if** the onboarding teaches it well, AI difficulty must
scale without slingshot rubber-banding, and a strong EDM soundtrack plus
high content count (36+ tracks, 250+ events) is real currency with the
spiritual-successor audience.

## Sources

- [Redout 2 Steam page](https://store.steampowered.com/app/1799930/Redout_2/)
- [Redout 2 on Metacritic](https://www.metacritic.com/game/redout-2/)
- [Redout 2 on OpenCritic](https://opencritic.com/game/13256/redout-2)
- [Redout 2 sales (GameSensor)](https://gamesensor.info/news/redout_2)
- [Redout 2 Review - racinggames.gg](https://racinggames.gg/article/redout-2-review-a-worthy-spiritual-successor-to-wipeout)
- [Redout 2 Review - TheSixthAxis](https://www.thesixthaxis.com/2022/06/17/redout-2-review/)
- [Redout 2 Review - DualShockers](https://www.dualshockers.com/redout-2-review-total-wipe-out/)
- [Redout 2 Review - Hey Poor Player](https://www.heypoorplayer.com/2022/06/17/redout-2-review-pc/)
- [Redout 2 Review - Checkpoint Gaming](https://checkpointgaming.net/reviews/2022/07/redout-2-review-too-fast-too-furious/)
- [Redout 2 Review - autoevolution](https://www.autoevolution.com/news/redout-2-is-all-about-hypnotising-speed-you-ll-be-glued-to-your-screen-for-days-191314.html)
- [Redout 2 Review - cogconnected](https://cogconnected.com/review/redout-2-review-the-fast-the-furious-and-frustrating/)
- [Redout 2 Review - wccftech (rubberband AI)](https://wccftech.com/review/redout-2-difficulty-or-rubberband-ai-at-its-worst/)
- [Redout 2 Trophy Guide - PowerPyx](https://www.powerpyx.com/redout-2-trophy-guide-roadmap/)
- [Redout 2 - Speedrun.com](https://www.speedrun.com/redout_2)
- [Redout (Wikipedia)](https://en.wikipedia.org/wiki/Redout_(video_game))
- [Introducing Red:OuT - ModDB](https://www.moddb.com/games/redout/news/introducing-redout-a-spiritual-sequel-to-f-zero)
- [Redout 2 Compendium of Conditions (Steam guide)](https://steamcommunity.com/sharedfiles/filedetails/?id=2821997445)
- [Temperature - Redout Wiki](https://redout.fandom.com/wiki/Temperature)
- [Redout 2 Winter Pack - Hey Poor Player](https://www.heypoorplayer.com/2023/02/10/redout-2-winter-dlc-goes-live-with-three-new-tracks/)
- [10 New Things You Need To Know - GamingBolt](https://gamingbolt.com/redout-2-10-new-things-you-need-to-know)
