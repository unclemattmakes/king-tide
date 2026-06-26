import { waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'
import { skipWebKitLinux } from './helpers/platform-skips'

// King-tide (Sandbar): the mean water level breathes up and down across the
// race, exposing low-water reef routes and drowning them at high water. The
// runtime drives BOTH `waveField.baseY` (sim buoyancy) and the water mesh Y
// (the shader sea level) from one tide clock, so reading the live `'water'`
// mesh's Y is a faithful probe of the whole coupling. `?tide=<amp>,<periodS>`
// overrides the authored curve so the test can pick a fast period and frozen
// extremes without editing JSON.
//
// Headed/real-GPU only (the project default): the water shader throttles under
// headless SwiftShader. Assertions are on the tide scalar (cheap, GPU-speed-
// independent); the screenshots are visual proof of route exposure.
test.describe('king tide', () => {
  skipWebKitLinux(test)

  const readWaterY = () => {
    const scene = (
      window as unknown as { __scene?: { traverse: (cb: (o: unknown) => void) => void } }
    ).__scene
    if (!scene) return null
    let y: number | null = null
    scene.traverse((o) => {
      const obj = o as { name?: string; position?: { y: number } }
      if (obj.name === 'water' && obj.position) y = obj.position.y
    })
    return y
  }

  // The terrain shader's waterline anchor (wet band + tide-mark trio + underwater
  // tint) is a uniform stashed on the material's userData — reading it proves the
  // painted shoreline follows the tide, not just the water mesh.
  const readTerrainWaterLevel = () => {
    const scene = (
      window as unknown as { __scene?: { traverse: (cb: (o: unknown) => void) => void } }
    ).__scene
    if (!scene) return null
    let v: number | null = null
    scene.traverse((o) => {
      const mat = (o as { material?: unknown }).material
      const mats = Array.isArray(mat) ? mat : [mat]
      for (const m of mats) {
        const u = (m as { userData?: { terrainWaterLevelUniform?: { value: number } } } | undefined)
          ?.userData?.terrainWaterLevelUniform
        if (u && typeof u.value === 'number') v = u.value
      }
    })
    return v
  }

  test('tide swings the live sea level up and down over the race', async ({ page }) => {
    test.setTimeout(120_000)
    // amplitude 3 m, fast 8 s period so a ~12 s sample covers >1 full cycle.
    await page.goto('/?autostart=1&track=sandbar&skipintro=1&tt=1&tide=3,8')
    await waitFullyBooted(page, { timeout: 20_000 })

    const series = await page.evaluate(
      async (probes) => {
        const readW = new Function(`return (${probes.w})()`) as () => number | null
        const readT = new Function(`return (${probes.t})()`) as () => number | null
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
        const out: { waterY: number; terrainWL: number }[] = []
        for (let i = 0; i < 60; i++) {
          const w = readW()
          const t = readT()
          if (typeof w === 'number' && typeof t === 'number') out.push({ waterY: w, terrainWL: t })
          await wait(200)
        }
        return out
      },
      { w: readWaterY.toString(), t: readTerrainWaterLevel.toString() },
    )

    expect(series.length).toBeGreaterThan(20)
    const waterYs = series.map((s) => s.waterY)
    const minY = Math.min(...waterYs)
    const maxY = Math.max(...waterYs)
    // Mean is -1.5, amplitude 3 → swings toward -4.5 (low) and +1.5 (high).
    // Generous bounds absorb sampling phase, but still prove a real ±3 breath
    // reaches the render (a still sea would sit flat at -1.5).
    expect(minY).toBeLessThan(-3.5)
    expect(maxY).toBeGreaterThan(0.5)
    expect(maxY - minY).toBeGreaterThan(4)
    // The terrain waterline anchor tracks the same swing (Stage 2): the painted
    // shoreline follows the tide, in lockstep with the water mesh.
    const terrainWLs = series.map((s) => s.terrainWL)
    expect(Math.min(...terrainWLs)).toBeLessThan(-3.5)
    expect(Math.max(...terrainWLs)).toBeGreaterThan(0.5)
    // Water mesh Y and terrain anchor are driven from the same tide scalar, so
    // each paired sample should agree to within a hair.
    expect(Math.max(...series.map((s) => Math.abs(s.waterY - s.terrainWL)))).toBeLessThan(0.01)
    // The console-errors fixture auto-asserts no console.error / pageerror on
    // teardown, so a shader/runtime fault during the swing fails the test too.
  })

  test('low vs high tide expose different waterlines on Sandbar', async ({ page }) => {
    test.setTimeout(120_000)
    // A huge period freezes the tide at the requested phase for a clean,
    // comparable still: phase 0.75 = full LOW tide, 0.25 = full HIGH tide.
    const shoot = async (phase: number, label: string) => {
      await page.goto(`/?autostart=1&track=sandbar&skipintro=1&tt=1&tide=3,100000,${phase}`)
      await waitFullyBooted(page, { timeout: 20_000 })
      // Let the surface settle and the chase cam frame the lagoon.
      await page.waitForTimeout(2500)
      const waterY = await page.evaluate(
        (probe) => (new Function(`return (${probe})()`) as () => number | null)(),
        readWaterY.toString(),
      )
      await page.screenshot({ path: `artifacts/king-tide/${label}.png` })
      return waterY
    }

    const lowY = await shoot(0.75, 'low-tide')
    const highY = await shoot(0.25, 'high-tide')
    expect(lowY).not.toBeNull()
    expect(highY).not.toBeNull()
    expect(lowY as number).toBeLessThan(-3.5) // ≈ -4.5
    expect(highY as number).toBeGreaterThan(0.5) // ≈ +1.5
    expect((highY as number) - (lowY as number)).toBeGreaterThan(4)
  })

  // The intertidal demo buoy cluster (sandbar.json `waveRiderBuoys` near the
  // start straight, x≈84 z≈108, terrain ≈ -2.8): floats at high/mean tide,
  // strands on the exposed sand at low tide. Parks the camera on it for a clean
  // framed capture (the forward chase cam never frames it well).
  test('beaching demo cluster: floats at high tide, strands at low', async ({ page }) => {
    test.setTimeout(120_000)
    const shoot = async (phase: number, label: string) => {
      await page.goto(`/?autostart=1&track=sandbar&skipintro=1&tt=1&tide=3,100000,${phase}`)
      await waitFullyBooted(page, { timeout: 20_000 })
      await page.evaluate(() => {
        const hv = (window as unknown as { __hover?: { setCameraPose?: (p: unknown) => void } })
          .__hover
        hv?.setCameraPose?.({ pos: { x: 70, y: 3.5, z: 94 }, target: { x: 84, y: -1.8, z: 109 } })
      })
      await page.waitForTimeout(2200)
      await page.screenshot({ path: `artifacts/king-tide/beach-${label}.png` })
    }
    await shoot(0.75, 'low') // low tide → buoys beached on sand
    await shoot(0.25, 'high') // high tide → buoys floating
  })
})
