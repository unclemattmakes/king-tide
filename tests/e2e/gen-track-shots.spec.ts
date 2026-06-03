/**
 * In-engine track screenshot sweep — the "un-blind Claude" harness.
 *
 * The Claude Preview MCP can't screenshot the WebGPU canvas reliably (a
 * backgrounded tab pauses requestAnimationFrame, so the sim freezes and
 * the frame is stale). This spec captures the *real* in-game look the
 * same way `gen-bike-thumbs` does: headed Chromium on the real GPU
 * (see playwright.config.ts — headed by default), driving an autopilot
 * lap and grabbing frames along the way.
 *
 * It maps directly onto the "block it out → play (even on autopilot) →
 * revise → detail" flow: this is the *play* step, captured to disk so a
 * concept plate and the in-game frame can be put side by side.
 *
 * Gated on `TRACK_SHOTS=1` so `pnpm e2e` stays fast. Invoke via
 * `pnpm gen:track-shots [id[,id2,...]]` (defaults to `sandbar`).
 *
 * Env knobs (all optional):
 *   TRACK_SHOTS_IDS       comma-separated track ids        (default "sandbar")
 *   TRACK_SHOTS_COUNT     frames per track                 (default 12)
 *   TRACK_SHOTS_INTERVAL  ms between frames                (default 1500)
 *   TRACK_SHOTS_WARMUP    ms to wait before first frame    (default 4000)
 *   TRACK_SHOTS_HUD       "1" keeps the DOM HUD overlays   (default hidden)
 *   TRACK_SHOTS_POSES     JSON [{label,pos,target}] → fixed-camera shots
 *   TRACK_SHOTS_POSE_FRAMES  frames per pose for a fixed-camera time-lapse (default 1)
 *
 * Output: test-results/track-shots/<id>/NN.jpg (gitignored) plus an
 * index.json per track listing each frame's player position + race
 * progress so frames can be mapped back to track beats.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const SHOT_W = 1280
const SHOT_H = 720

const IDS = (process.env.TRACK_SHOTS_IDS ?? 'sandbar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const COUNT = Number(process.env.TRACK_SHOTS_COUNT ?? 16)
const INTERVAL = Number(process.env.TRACK_SHOTS_INTERVAL ?? 1600)
const WARMUP = Number(process.env.TRACK_SHOTS_WARMUP ?? 6000)
const KEEP_HUD = process.env.TRACK_SHOTS_HUD === '1'
// The next-checkpoint direction arrow is guidance UI, not world art, so
// it's hidden by default for a clean art read. TRACK_SHOTS_ARROW=1 keeps
// it (e.g. to verify the arrow's own art pass).
const KEEP_ARROW = process.env.TRACK_SHOTS_ARROW === '1'
// Posed-camera mode: when TRACK_SHOTS_POSES is a JSON array of
// {label,pos:[x,y,z],target:[x,y,z]}, the harness parks the camera at each
// pose via __hover.setCameraPose and captures one frame per pose instead of
// the autopilot chase sweep — for framing set-pieces the chase cam can't see
// (e.g. the Sandbar marina, which sits behind the start line). Coords are
// three.js world space; convert Blender (bx,by,bz) via (bx, bz, -by).
type PosedShot = { label: string; pos: [number, number, number]; target: [number, number, number] }
const POSES: PosedShot[] | null = process.env.TRACK_SHOTS_POSES
  ? (JSON.parse(process.env.TRACK_SHOTS_POSES) as PosedShot[])
  : null
// Frames captured per pose. Default 1 (a single still per pose — the
// historical behaviour). Set >1 for a fixed-camera time-lapse: the engine
// holds the pose while the sim keeps running, so successive frames show the
// world evolve in place (clouds drifting, water moving). Frames are spaced
// TRACK_SHOTS_INTERVAL ms apart and named pose-<label>-NN.jpg.
const POSE_FRAMES = Math.max(1, Number(process.env.TRACK_SHOTS_POSE_FRAMES ?? 1))

// The DOM overlays that sit on top of the WebGPU canvas. Hidden for a
// clean art read unless TRACK_SHOTS_HUD=1. (Element ids are in index.html.)
const HUD_HIDE_SELECTOR = [
  '#hud', // dev diagnostics (top-left)
  '#hud-scaffold', // gameplay HUD layer (wave-pump / boost / drift / tuck / ...)
  '#race-timer', // top-center lap/time card
  '#race-banner', // 3-2-1-GO countdown banner
  '#race-gap', // gap toast
  '#race-minimap', // bottom-right minimap
  '#race-intro-ui', // pre-race splash card
  '#race-intro-skip', // "press any key" prompt
  '#hud-positions',
  '#devsettings-toggle',
  '#water-debug-toggle',
  '#garage-toggle',
  '#loading-screen',
].join(',')

const OUT_ROOT = path.resolve(process.cwd(), 'test-results', 'track-shots')

test.describe('track screenshot sweep', () => {
  test.skip(process.env.TRACK_SHOTS !== '1', 'gated on TRACK_SHOTS=1 — use pnpm gen:track-shots')

  for (const id of IDS) {
    test(`${id} sweep`, async ({ page }) => {
      // Generous — a cold WebGPU boot + the capture window. Posed mode adds
      // a 700 ms settle per pose plus POSE_FRAMES×INTERVAL of time-lapse.
      const posedTime = POSES ? POSES.length * (700 + POSE_FRAMES * INTERVAL) : 0
      const sweepTime = COUNT * INTERVAL
      test.setTimeout(WARMUP + Math.max(sweepTime, posedTime) + 60_000)

      const outDir = path.join(OUT_ROOT, id)
      mkdirSync(outDir, { recursive: true })

      await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
      await page.goto(`/?autostart=1&track=${id}`)
      await waitForReady(page)

      const backend = await page.evaluate(() => window.__hover!.backend())
      console.log(`track-shots:${id}:backend=${backend}`)
      expect(['webgpu', 'webgl2']).toContain(backend)

      // Hand the player bike to the AI so the camera flies the racing
      // line through every beat without scripted input.
      await page.evaluate((keepArrow) => {
        if (!window.__hover!.isAutoPlay()) window.__hover!.toggleAutoPlay()
        // Hide the direction arrow for clean art frames unless asked to keep it.
        if (!keepArrow && window.__hover!.isDirectionArrowOn()) {
          window.__hover!.toggleDirectionArrow()
        }
      }, KEEP_ARROW)

      // Skip the pre-race intro splash so the warmup window isn't eaten by
      // the title card. Enter is the documented skip key (index.html
      // #race-intro-skip). Harmless if the intro already finished.
      await page.keyboard.press('Enter')

      if (!KEEP_HUD) {
        await page.addStyleTag({ content: `${HUD_HIDE_SELECTOR}{display:none!important}` })
      }

      // Clear the start countdown + let the field settle before capture.
      await page.waitForTimeout(WARMUP)

      const frames: Array<Record<string, unknown>> = []
      if (POSES) {
        // Posed mode: park the camera at each authored pose. With
        // POSE_FRAMES=1 (default) grab a single still (pose-<label>.jpg);
        // with POSE_FRAMES>1 hold the fixed pose and grab a time-lapse
        // sequence (pose-<label>-NN.jpg) spaced INTERVAL ms apart while the
        // sim keeps running — the way to watch clouds/water drift in place.
        // The autopilot warmup above first lets the field clear the start
        // area so set-pieces aren't blocked by the grid.
        for (const shot of POSES) {
          await page.evaluate((s) => {
            window.__hover!.setCameraPose({
              pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
              target: { x: s.target[0], y: s.target[1], z: s.target[2] },
            })
          }, shot)
          await page.waitForTimeout(700)
          const label = shot.label.replace(/[^a-z0-9_-]/gi, '_')
          for (let j = 0; j < POSE_FRAMES; j++) {
            const name =
              POSE_FRAMES > 1
                ? `pose-${label}-${String(j).padStart(2, '0')}.jpg`
                : `pose-${label}.jpg`
            await page.screenshot({
              path: path.join(outDir, name),
              type: 'jpeg',
              quality: 90,
              clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H },
            })
            frames.push({ frame: name, pos: shot.pos, target: shot.target })
            if (j < POSE_FRAMES - 1) await page.waitForTimeout(INTERVAL)
          }
        }
        await page.evaluate(() => window.__hover!.setCameraPose(null))
      } else {
        for (let i = 0; i < COUNT; i++) {
          const name = `${String(i).padStart(2, '0')}.jpg`
          await page.screenshot({
            path: path.join(outDir, name),
            type: 'jpeg',
            quality: 90,
            clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H },
          })
          const meta = await page.evaluate(() => {
            const p = window.__hover!.player()
            const r = window.__hover!.race()
            return {
              fps: window.__hover!.fps(),
              speed: p?.speed ?? null,
              pos: p?.position ?? null,
              lap: r?.lap ?? null,
              checkpointsCrossed: r?.checkpointsCrossed ?? null,
              nextCheckpoint: r?.nextCheckpoint ?? null,
            }
          })
          frames.push({ frame: name, ...meta })
          if (i < COUNT - 1) await page.waitForTimeout(INTERVAL)
        }
      }

      const mode = POSES ? (POSE_FRAMES > 1 ? 'posed-timelapse' : 'posed') : 'sweep'
      writeFileSync(
        path.join(outDir, 'index.json'),
        `${JSON.stringify({ id, backend, mode, frames }, null, 2)}\n`,
      )

      const errored = await page.evaluate(() => window.__hover!.qa?.consoleHasErrors() ?? false)
      console.log(
        `track-shots:${id}:wrote ${frames.length} frames to ${outDir} (mode=${mode} consoleErrors=${errored})`,
      )
    })
  }
})
