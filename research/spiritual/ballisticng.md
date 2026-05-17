# BallisticNG — Spiritual Successor Reference

## 1. Studio & lineage

BallisticNG is built by **Neognosis**, a tiny UK indie outfit fronted by lead
developer/composer **Adam Chivers** (handle "Vonsnake"), with Aidan Lee handling
Linux/macOS porting and additional support. Development began around 2014; the
title spent years in Steam Early Access before its **1.0 release in December
2018**. By the time of the Arcadex Machina interview (July 2020) Chivers had
been working on the project for roughly eight years.

Neognosis frames the game explicitly as a **"love letter to WipEout 2097"** —
the PS1 era specifically, not the slicker WipEout HD/Fury. The visual style
leans hard into deliberate PSX-era artefacts: vertex jitter, affine texture
warping, low-resolution dithered framebuffer, optional CRT scanline and curvature
shaders. The game ships separate emulations of PS1 rasterisation, texture
mapping and dithering with tweakable CRT parameters, so players can dial in
"new game running on a CRT in 1996" or push it up to a modern presentation.

Inside the dev community (r/wipeout, r/racinggames, ResetEra threads)
BallisticNG is the consensus *good* WipEout successor — the small-team triumph
held up as a direct contrast to **Pacer** (R8 Games, 2020), which despite
ex-Psygnosis-Leeds talent shipped to mixed reviews, stuttering UE4 perf, and
near-abandonment within months of launch. The repeated talking point: "Stay
away from Pacer. BallisticNG exists and costs so little cash."

## 2. Lap length / race duration

Speed classes scale both ship top speed and the lap count per race:

| Class | Equivalent in WipEout | Laps |
|---|---|---|
| Toxic | (slowest, training) | 2 |
| Apex | Flash | 3 |
| Halberd | Rapier | 4 |
| Spectre | Phantom | 5 |
| Zen | Super-Phantom | 5 |

Concrete ship speed numbers for the G-TEK across classes: Toxic 268, Apex 354,
Halberd 428, Spectre 494, Zen 555 (internal units). Track lengths vary widely
across the 52 hand-crafted base tracks plus 5–6 per DLC; competitive Time Trial
laps on Ishtar Citadel at Zen sit around the **19 second** range, while
typical Spectre/Zen race laps run roughly **40–60 seconds**. A full race
therefore lands in the **2.5–5 minute** range for higher classes, with Toxic
tutorials closer to 90 seconds. Tournaments string 3–4 tracks back-to-back, so
a sitting is typically 15–25 minutes.

## 3. Race structure & signature mechanics

Anti-grav hover ships, twin **airbrakes** (one per side) plus a discrete
**side-shift** — holding the opposite airbrake to your steering input strafes
the ship sideways, the key technique for clearing 90° bends without scrubbing
speed. Pickup-based weapons: rockets, twin cannon, instant-kill **plasma**,
track-spanning **tremor** shockwave, stationary mine drops, plus shield/turbo
defensives. Speed pads, weapon pads, recharge zones on every track.

**Modes:** Race, Team Race, Tournament, Time Trial, Speed Lap, Eliminator
(last-place purge each lap), Knockout (last-place ship explodes each lap),
Survival (auto-accelerating, shield drains on wall hits), Upsurge (energy-zone
chase), Rush Hour, Stunt. Multiplayer (online direct-IP or Steam, plus
two-player splitscreen) supports Knockout, Rush Hour, Upsurge, Eliminator and
a multiplayer-only Team Race; lobby cap is **8 ships** on track.

**Campaign:** ~98 events across 10 blocks. Season One runs at Toxic, Season Two
at Halberd, Season Three at Spectre, Season Four unlocks Zen via custom
tournaments. Each DLC adds a new campaign chunk (Neon Nights 48 events; Outer
Reaches and Maceno Island similar scope).

## 4. Differences from / similarities to WipEout

Similarities are intentional and total: ship feel, side-shift technique,
weapon roster, speed-class progression, AGL fictional league framing, even
livery and HUD layout all read as direct homage to 2097/Wip3out. Chivers has
never disguised this.

The big *divergence* is the **modding scene**. BallisticNG shipped Unity-based
tools and Steam Workshop integration early; the Workshop now hosts hundreds of
custom tracks (many are loving recreations of Wipeout, F-Zero GX, Extreme-G,
and Rollcage circuits), custom ships, custom liveries, code mods written
against a native C# library, custom HUDs, custom gamemodes, and full custom
campaigns. The "SWAGL" community league runs entirely on user content. This
is unheard-of in the genre — neither WipEout nor F-Zero ever exposed authoring
tools, and Redout/Pacer/Antigraviator shipped closed.

## 5. What players love

- **Steam: "Overwhelmingly Positive,"** ~95% of ~1,900+ reviews positive at
  time of writing (frequently quoted as 97%).
- "It feels exactly like 2097/Wip3out" — the single most repeated praise
  across Steam, Reddit, NeoGAF.
- **Soundtrack** by Vonsnake himself plus rotating community contributors;
  drum-and-bass / electronic in clear CoLD SToRAGE lineage.
- **Modding community size and quality** — workshop content rivals official
  content in volume.
- **Pricing** — base game ~$10 USD (often $5–6 on sale); Neon Nights DLC was
  *given away free* to existing owners; subsequent DLC (Outer Reaches, Maceno
  Island) is a few dollars each.
- **Tiny-team responsiveness** — patches and community-requested features
  continue years post-launch (1.4.1.x branch still receiving updates in 2025).
- VR support, splitscreen, direct-IP multiplayer (no Steam required for LAN).

## 6. What players criticise

- **AI is punishing** at Spectre/Zen and was perceived as ramped up in later
  patches vs. earlier balance; tip threads warn new players not to race AI
  until they can clear a track wall-free.
- **Side-shift learning curve** — the unusual control scheme gatekeeps casual
  players to lower classes; SuperJump dubbed it "the Dark Souls of racing
  games" half-jokingly.
- **Small online population** outside scheduled SWAGL events and Discord-
  arranged lobbies — finding random pickup races is hit-and-miss.
- **Presentation** isn't AAA — menus, livery editor UX, photo-mode polish all
  show the tiny-team origins, even if in-race feel is immaculate.
- Some players felt the handling is *harder* than the WipEout 2097 it
  emulates (more wall-bouncing at speed).

## 7. Most-requested features

- More official campaign content (community gobbles DLC fast).
- Better multiplayer matchmaking / public lobby browser with population hints,
  instead of direct-IP and scheduled events.
- More accessible tutorialisation of side-shift for newcomers.
- Polished livery/ship customisation UI.
- Console parity content (NX Switch port was announced; PC remains the lead
  platform).

## 8. Reception numbers

- **Steam:** Overwhelmingly Positive, ~95–97% of ~1.9k+ reviews.
- **Metacritic:** no aggregated PC score — too small for press coverage; Switch
  NX Edition picked up scattered indie-press reviews.
- **Concurrent players:** small, typically 10–40 CCU on SteamCharts with peaks
  on patch days; this is the genre norm and not a quality signal.
- **Content scale vs. team size:** 52 base tracks, 16 ships, 98 campaign
  events, 4 DLC expansions, full mod toolchain — shipped by effectively two
  people. Held up as the canonical case study for "small team nails a niche
  genre revival by being precise about what fans actually want."

The lesson for a hover-bike racer: BallisticNG won by being narrow and
authentic (one aesthetic target, one control idiom, executed exactly) and by
turning its players into a content engine via first-class mod tools. Pacer
tried to be everything (UE4 polish, ex-Psygnosis pedigree, narrative campaign,
console parity) and shipped less of each.

## Sources

- [BallisticNG vs. Wipeout — Pixel Fix (Substack)](https://pixelfix.substack.com/p/big-read-ballisticng-vs-wipeout)
- [Full interview with Vonsnake — Arcadex Machina](https://arcadestrikerblog.wordpress.com/2020/07/16/full-interview-with-vonsnake-ballisticng-lead-developer/)
- [BallisticNG Wiki — Gamemodes (Miraheze)](https://ballisticng.miraheze.org/wiki/Gamemodes)
- [BallisticNG Wiki — Tracks (Miraheze)](https://ballisticng.miraheze.org/wiki/Tracks)
- [Singleplayer Tournaments — Fandom Wiki](https://ballisticng-archive.fandom.com/wiki/Singleplayer_Tournaments)
- [Game Guide — Fandom Wiki](https://ballisticng-archive.fandom.com/wiki/Game_Guide)
- [Ship top speeds — Steam Community](https://steamcommunity.com/app/473770/discussions/0/343788552542447197/)
- [What's up with the AI? — Steam Community](https://steamcommunity.com/app/473770/discussions/0/3561682880003557749/)
- [Tips for noobs — Steam Community](https://steamcommunity.com/app/473770/discussions/0/3774483849431673847/)
- [The Official Pilot's Guide — Steam Guides](https://steamcommunity.com/sharedfiles/filedetails/?id=700708563)
- [Meet the Dark Souls of Racing Games: BallisticNG — SuperJump](https://www.superjumpmagazine.com/meet-the-dark-souls-of-racing-games-ballisticng/)
- [BallisticNG Review — Gaming Pastime](https://gamingpastime.com/ballisticng-review/)
- [BallisticNG — PCGamingWiki](https://www.pcgamingwiki.com/wiki/BallisticNG)
- [BallisticNG — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/BallisticNG)
- [4 WipEout Alternatives While You Wait For PACER — GameGrin](https://www.gamegrin.com/articles/4-wipeout-alternatives-while-you-wait-for-pacer/)
- [5 Best WipEout and F-Zero Alternatives — RacingGames.gg](https://racinggames.gg/article/the-5-best-wipeout-and-f-zero-alternatives)
- [Wipeout "Love Letter" BallisticNG — Nintendo Life](https://www.nintendolife.com/news/2021/03/wipeout_love_letter_ballisticng_is_speeding_onto_switch)
- [Neognosis Games — studio site](https://neognosis.games/)
- [BallisticNG — Neon Nights (Steam)](https://store.steampowered.com/app/1090110/BallisticNG__Neon_Nights/)
- [BallisticNG — Maceno Island (Steam)](https://store.steampowered.com/app/1596120/BallisticNG__Maceno_Island/)
- [BallisticNG Documentation — Custom Campaigns](https://ballisticng-documentation.readthedocs.io/en/latest/ingame/custom_campaigns.html)
- [BallisticNG Speedrun Leaderboards](https://www.speedrun.com/ballisticng/levels)
