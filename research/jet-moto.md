# Jet Moto 1 & 2 — Design Reference

SingleTrac's Jet Moto (Sony, 1996) and Jet Moto 2 (1997) are the closest direct
ancestors of what we're building: a PS1-era hoverbike arcade racer with multi-
terrain tracks, weight-classed bikes, and a signature grappling-pole mechanic.
This doc captures what's reusable and what to avoid.

## 1. Track length, lap count, race duration

Neither game documents physical track length in meters — courses are openly
"impressionistic" terrain rather than measured circuits. What we do know:

- **Laps per race:** Standard 3 laps per course in both games. Series races
  use placement points across a championship.
- **Field size:** 20 racers on the grid (the "motocross-style" pack start was
  a deliberate differentiator from Wipeout/Ridge Racer's smaller fields).
  Greatest Hits / Championship Edition re-release of JM2 cut this to fewer
  competitors but ran at 30 fps instead of the original ~20 fps.
- **Course types:** Conventional loops plus "Suicide" courses (e.g. Suicide
  Swamp) — point-to-point tracks with a center start grid; racers run to one
  checkpoint, U-turn, then to the other, repeating until lap count is met.
- **Typical lap time:** Speedrun footage of JM2 Championship Edition shows a
  full 10-race season completed in ~27:32 (world-record pace), which puts
  averaged per-race times around 2:30-3:00 and individual laps in the
  50-70 second range on shorter courses. Casual playthroughs are longer:
  Suicide Swamp and the snow/mountain courses regularly run 90-120 s per
  lap, so a full 3-lap race lands in the 4-6 minute bracket. Variance
  across the roster is high — desert and city tracks are notably faster
  than swamp/snow.

**JM1 tracks (10):** Joyride, Black Water Falls, Suicide Swamp (amateur tier);
Ice Crusher, Cliffdiver, Hammerhead, Cypress Run, Willpower, Snow Blind,
Nightmare (unlocks).
**JM2:** Ten brand-new tracks plus returning JM1 courses as unlocks; themes
include earthquake-damaged cities, desert canyons, ice mountains, and a
roller-coaster-style course — each with a distinct visual identity rather
than JM1's three shared biomes.

## 2. Race structure & signature mechanics

- **Magnetic grapple:** The franchise's signature. Red energy poles are
  placed at the apex of tight turns; holding the grapple button inside
  range locks a magnetic tether between bike and pole, slingshotting the
  rider through the corner without scrubbing speed. Also used to swing
  over chasms too wide to jump. This is what made Jet Moto feel different
  from every other PS1 racer — corners are a button-timing skill check, not
  a steering one.
- **Terrain variety per course:** Mud (slows and grabs), water (slippery,
  surface ripple), snow (long air, low traction), ice, asphalt, and dirt
  all coexist within single tracks. Bike physics respond differently to
  each — water in particular makes the bike slide noticeably.
- **Weight classes:** 20 racers across 4 sponsor teams (Mountain Dew, K2,
  Axiom, Butterfinger), 5 racers per team. Bikes vary in mass, lift,
  acceleration, and maneuverability. Heavier bikes win contact (you can
  knock lighter racers off) at the cost of cornering and acceleration —
  classic rock/paper/scissors tradeoff.
- **Limited turbo boosts** layered on top of the grapple for tactical use.

## 3. Major changes Jet Moto 1 -> Jet Moto 2

This is the headline diff for our design reference:

- **Controls / physics overhauled.** JM1's controls were widely panned as
  slippery and hard to turn; GameSpot's contemporary review said "it's a
  struggle to turn fast and accurately, and crashing is frequent." JM2
  rebalanced bike handling to be tighter and faster, and reviewers
  uniformly cited this as the biggest improvement.
- **Roster halved, tracks doubled.** JM1's 20 racers were cut to 10 + 1
  unlock. In exchange, JM2 added ten all-new tracks (plus JM1's tracks
  as unlocks) and gave each track a unique visual theme instead of
  recycling swamp/snow/beach biomes.
- **AI got worse, paradoxically.** Instead of building proper AI,
  developers used recorded "ghost" runs for opponents. Result: AI is
  near-perfect on its line, so any player mistake drops you several
  positions. This reads as rubber-banding even though it isn't.
- **Sponsor product placement increased**, not decreased. IGN specifically
  flagged JM2's product placement as excessive.
- **Soundtrack swapped.** JM1 leaned heavily on Rob Zombie / White Zombie's
  "Thunder Kiss '65" (plus surf-rock instrumentals — the surf guitar got
  cited by Electric Playground as one of 1996's best game soundtracks).
  JM2 swapped in Reverend Horton Heat's psychobilly catalog ("Big Sky,"
  "Five-O Ford," "Big Red Rocket of Love") and other licensed rock.
- **Modes** were expanded with stunt and time-trial-flavored variants,
  and a later Championship Edition re-release added more competitors and
  a 30 fps render mode.
- **Verdict at the time:** "Jet Moto 1.5" — clear improvement but not a
  generational leap. GameRankings settled at ~70%.

## 4. What players love (retrospective sentiment)

- **The grapple.** Universally cited as the one thing no other racer does.
  Mastering the timing produces a uniquely satisfying corner exit.
- **The soundtrack.** Surf-rock instrumentals + licensed alt-rock are
  routinely called out as a top-tier PS1 OST; fans report still listening
  to it decades later (one ResetEra post: "listening to the Jet Moto
  soundtrack on a walkman while tubing on a lake").
- **Multi-terrain physics.** Water/mud/snow each feeling distinct, with
  bikes plowing wakes through water, was a real wow moment in 1996.
- **Sense of weight and danger.** Heavy bikes that can body-check
  lightweight rivals, plus the cliff-edge tracks (Cliffdiver, Hammerhead),
  made races feel high-stakes.
- **Pack racing.** A 20-rider grid was rare for PS1 racers and gives the
  game a chaotic identity.
- **Comic-book character bios, sponsor team identity, the 90s extreme-sport
  vibe.** Cited frequently in nostalgia threads.

## 5. What players hate / criticize

- **JM1 controls** — slippery, twitchy, "have to feather the brake just
  to keep pointed." Number one complaint.
- **Brutal difficulty in both games.** JM1 punishes mistakes hard; JM2's
  ghost-recording AI means a single missed grapple ends your podium chance.
- **Camera issues** — pop-in, awkward low-angle chase cam on cliff jumps.
- **JM2's "not enough new" feel** — IGN's "Jet Moto 1.5" framing recurs.
- **Sponsor saturation** in JM2 specifically.
- **Jet Moto 3 (1999, by 989 Studios)** is widely seen as a failure: bikes
  too fast, floaty handling, sloppy/rushed (similar fate to Twisted Metal
  3/4 under 989). Sold OK at launch but no legs.
- **Cancellation of every follow-up.** Jet Moto 2124 (PS1) and Jet Moto:
  SOLAR (PS2, RedZone Interactive) were both cancelled — SOLAR footage
  finally surfaced on YouTube in 2022. Series has been dormant since 1999.

## 6. What fans want from a modern revival

Recurring asks across NeoGAF, ResetEra, CBR, PSX Extreme, and Medium
retrospectives:

- **Keep the grapple.** This is non-negotiable; it's the franchise.
- **Tighten the controls to modern standards** but keep the *sense* of
  mass — a 250kg heavy bike should still feel different from a sport bike.
- **Bring back true multi-terrain physics.** Water wakes, snow plumes, mud
  that grabs. Most modern arcade racers normalize surfaces; fans want the
  opposite.
- **Long, varied courses** with environmental hazards (cliff drops,
  collapsing bridges, suicide point-to-point variants) over short F1-style
  circuits.
- **Strong licensed soundtrack** in the surf-rock / psychobilly / alt-rock
  vein. "Music made the game" comes up a lot.
- **20+ racer pack starts.** The chaos is part of the identity.
- **Sponsor teams with personality** — bring back the "comic book bios"
  flavor, but lighter on product placement.
- **Real AI**, not ghost recordings. Catch-up mechanics OK if not
  obviously rubber-banded.
- **Indie-scale revival is acceptable.** Many posts explicitly say "even
  a small team could do this." That's relevant to our scope.

## Takeaways for our build

- The grapple is the single most-copyable mechanic. Worth a prototype.
- Lean into per-surface physics distinctions — that's what hover racers
  *should* do and most modern ones don't.
- Race length target: 3 laps, 4-6 minute total race, individual lap
  60-90 s. That's the JM sweet spot.
- Avoid JM2's ghost-recording AI mistake. Build proper opponent AI.
- 20-bike grid is a stretch goal but a strong identity hook if achievable.

## Sources

- [Jet Moto (video game) — Wikipedia](https://en.wikipedia.org/wiki/Jet_Moto_(video_game))
- [Jet Moto 2 — Wikipedia](https://en.wikipedia.org/wiki/Jet_Moto_2)
- [Jet Moto — Wikipedia (series)](https://en.wikipedia.org/wiki/Jet_Moto)
- [Jet Moto 3 — Wikipedia](https://en.wikipedia.org/wiki/Jet_Moto_3)
- [Jet Moto Wiki (Fandom)](https://jetmoto.fandom.com/wiki/Jet_Moto)
- [Jet Moto 2 Wiki (Fandom)](https://jetmoto.fandom.com/wiki/Jet_Moto_2)
- [Jet Moto Series Wiki (Fandom)](https://jetmoto.fandom.com/wiki/Jet_Moto_(Series))
- [Jet Moto Review — GameSpot](https://www.gamespot.com/reviews/jet-moto-review/1900-2547973/)
- [Jet Moto 2 Review — GameSpot](https://www.gamespot.com/reviews/jet-moto-2-review/1900-2547965/)
- [Jet Moto 1 Soundtrack — RacingSoundtracks](https://racingsoundtracks.com/game/jet-moto-1)
- [Jet Moto 2 Soundtrack — RacingSoundtracks](https://racingsoundtracks.com/game/jet-moto-2)
- [Jet Moto Series — Speedrun.com](https://www.speedrun.com/series/jet_moto)
- [Jet Moto 2 Championship Edition WR — YouTube](https://www.youtube.com/watch?v=mp5-aJHaEoQ)
- [What Happened to Jet Moto? — Medium / Retro Game Dad](https://medium.com/retro-game-dad/what-happened-to-jet-moto-bf998c1b0dc3)
- [Is the Time Right for a New Jet Moto? — CBR](https://www.cbr.com/jet-moto-playstation-reboot/)
- [Anyone else miss Jet Moto? — ResetEra](https://www.resetera.com/threads/anyone-else-miss-jet-moto.1239882/)
- [Would you be interested in a new Jet Moto? — NeoGAF](https://www.neogaf.com/threads/would-you-be-interested-in-a-new-jet-moto.1666044/)
- [Jet Moto retrospective — NeoGAF](https://www.neogaf.com/threads/jet-moto-was-the-first-cool-playstation-game-i-ever-played-and-i-dont-feel-like-enough-people-talk-about-it-compared-to-other-retro-3d-racers.1522428/)
- [A PS1 Classic Franchise That Deserves Revival — PSX Extreme](https://psxextreme.com/topic/a-ps1-classic-franchise-that-deserves-revival-jet-moto/)
- [Jet Moto (Video Game) — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/JetMoto)
- [Jet Moto Trivia — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Trivia/JetMoto)
- [Retro Game Geek-Out: Jet Moto — Uncommon Geek](https://uncommongeek.com/2016/06/20/retro-game-geek-out-jet-moto/)
- [Jet Moto Series Overview — RetroNews](https://www.retronews.com/jet-moto-series-overview-the-best-and-worst-of-playstation-futuristic-racer/)
- [Jet Moto Review — Infinity Retro](https://infinityretro.com/jet-moto-review/)
- [Jet Moto 1 & 2 fan page — Angelfire](https://www.angelfire.com/in/psxzone/jm1and2.html)
- [Jet Moto FAQ by RGibson — GameFAQs](https://gamefaqs.gamespot.com/ps/197684-jet-moto/faqs/10935)
- [Jet Moto 2 Guide by CaMacKid — GameFAQs](https://gamefaqs.gamespot.com/ps/197685-jet-moto-2/faqs/81188)
