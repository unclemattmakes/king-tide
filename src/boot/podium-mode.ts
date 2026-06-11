/**
 * 3D podium ceremony — the end-of-cup trophy presentation.
 *
 * Triggered by `?podium=1` once the final race of a championship finishes
 * (the finish screen's "PODIUM →" button navigates here). Reads the
 * completed cup from sessionStorage, ranks the field via `cupStandings`,
 * and stages a short Three.js ceremony: the top three riders on a podium,
 * a spinning trophy, confetti, and a scripted camera move — then slides
 * the full championship standings card in over the top and hands the
 * BACK TO MENU path back to `cup-progress` cleanup.
 *
 * Inspiration: Mario Kart 8's trophy ceremony + Jet Moto's season wrap —
 * the spectacle is the 3D reveal, the data is the standings card.
 *
 * Self-contained like the bike viewer: its own renderer + scene, no race
 * subsystems. Resilient to missing bike GLBs (falls back to a primitive
 * stand-in) so the ceremony always renders something.
 */

import * as THREE from 'three'
import { assetUrl } from '@/engine/asset-url'
import { clearCupProgress, cupStandings, getCupProgress } from '@/engine/cup-progress'
import { installMenuGamepad, type MenuGamepad } from '@/engine/input/menu-gamepad'
import { showCupResultsOverlay } from '@/engine/render/cup-results-screen'
import { createRenderer } from '@/engine/render/renderer'
import { cloneLoadedBike, loadBike } from '@/game/assets/bike-loader'
import { hideLoadingScreen } from './loading-screen'

/** Seconds the cinematic plays before the standings card auto-reveals. */
const CEREMONY_SECONDS = 4.6

const TROPHY_GOLD = 0xffd54a

/** Podium block placement (x metres, block height). Index 0 = winner. */
const PODIUM_SLOTS: ReadonlyArray<{ x: number; height: number }> = [
  { x: 0, height: 1.25 }, // 1st — centre, tallest
  { x: -1.75, height: 0.92 }, // 2nd — left
  { x: 1.75, height: 0.64 }, // 3rd — right
]

export async function bootPodiumMode(parent: HTMLElement): Promise<void> {
  const progress = getCupProgress()

  const backToMenu = (): void => {
    clearCupProgress()
    document.body.classList.remove('podium-active')
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('back', '1')
    window.location.assign(url.toString())
  }

  if (!progress) {
    // Direct navigation with no completed cup in storage — don't strand
    // the player on a black canvas; bounce home.
    backToMenu()
    return
  }

  // The top three ride the podium; the player's own medal + full table are
  // surfaced by the standings card (`showCupResultsOverlay`) once the
  // ceremony settles, so the 3D scene only needs the ranked field here.
  const standings = cupStandings(progress)

  // ── Renderer + scene ───────────────────────────────────────────────────
  const { renderer, canvas, resize, dispose } = await createRenderer(parent)
  requestAnimationFrame(resize)

  const scene = new THREE.Scene()
  scene.background = makeGradientBackground()
  scene.fog = new THREE.Fog(0x0a1626, 12, 34)

  const camera = new THREE.PerspectiveCamera(46, aspect(), 0.1, 200)

  // Dramatic studio lighting — a cool ambient fill plus a warm key so the
  // gold trophy reads, and a back rim to pop the silhouettes.
  scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x141a26, 1.0))
  const key = new THREE.DirectionalLight(0xffe6c0, 1.5)
  key.position.set(4, 7, 6)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x5cf2ff, 0.7)
  rim.position.set(-5, 3, -6)
  scene.add(rim)

  // Reflective-ish dark stage floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(22, 48),
    new THREE.MeshStandardMaterial({ color: 0x0c1726, roughness: 0.55, metalness: 0.35 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.01
  scene.add(floor)

  // ── Podium blocks + top-three bikes ────────────────────────────────────
  const top = standings.slice(0, 3)
  const podiumGroup = new THREE.Group()
  scene.add(podiumGroup)

  for (let i = 0; i < top.length; i++) {
    const row = top[i]
    const slot = PODIUM_SLOTS[i]
    if (!row || !slot) continue

    const block = makePodiumBlock(slot.height, i)
    block.position.set(slot.x, slot.height / 2, 0)
    podiumGroup.add(block)

    // Name plate floating above the block.
    const label = makeTextSprite(`${i + 1}. ${row.identity.name}`, medalHex(i) ?? '#e6f0ff')
    label.position.set(slot.x, slot.height + 1.95, 0)
    podiumGroup.add(label)

    // Bike on top — loaded async; placed when ready so a slow GLB fetch
    // doesn't block the ceremony from starting.
    void loadPodiumBike(row.identity.variantId, row.identity.bodyColor).then((bike) => {
      bike.position.set(slot.x, slot.height, 0)
      bike.rotation.y = THREE.MathUtils.degToRad(210)
      podiumGroup.add(bike)
    })
  }

  // ── Trophy (spins above the winner's block) ────────────────────────────
  const trophy = makeTrophy()
  const winnerSlot = PODIUM_SLOTS[0]
  if (winnerSlot) trophy.position.set(winnerSlot.x, winnerSlot.height + 0.95, 0)
  scene.add(trophy)

  // ── Confetti ───────────────────────────────────────────────────────────
  const confetti = makeConfetti(240)
  scene.add(confetti.points)

  // ── Camera move: wide reveal → settle ──────────────────────────────────
  const camStart = new THREE.Vector3(3.6, 4.4, 9.2)
  const camEnd = new THREE.Vector3(0, 2.3, 6.0)
  const camTarget = new THREE.Vector3(0, 1.25, 0)
  camera.position.copy(camStart)
  camera.lookAt(camTarget)

  // ── Standings card reveal + navigation ─────────────────────────────────
  let standingsShown = false
  let gamepad: MenuGamepad | null = null
  let disposeOverlayKeys: (() => void) | null = null

  const revealStandings = (): void => {
    if (standingsShown) return
    standingsShown = true
    window.removeEventListener('keydown', onSkipKey)
    canvas.removeEventListener('pointerdown', revealStandings)
    document.body.classList.add('podium-active')
    disposeOverlayKeys = showCupResultsOverlay({ progress, onBackToMenu: backToMenu })
    gamepad = installMenuGamepad({
      container: () => document.getElementById('cup-results'),
      onBack: backToMenu,
    })
    gamepad.focusFirst()
  }

  function onSkipKey(e: KeyboardEvent): void {
    if (
      e.code === 'Enter' ||
      e.code === 'NumpadEnter' ||
      e.code === 'Space' ||
      e.code === 'Escape'
    ) {
      e.preventDefault()
      revealStandings()
    }
  }
  window.addEventListener('keydown', onSkipKey)
  canvas.addEventListener('pointerdown', revealStandings)

  window.addEventListener('resize', () => {
    camera.aspect = aspect()
    camera.updateProjectionMatrix()
    resize()
  })

  // ── Render loop ──────────────────────────────────────────────────────────
  const start = performance.now()
  let prev = start
  let running = true
  const stop = (): void => {
    running = false
    gamepad?.dispose()
    disposeOverlayKeys?.()
    dispose()
  }
  // Tear the loop + GPU context down before the page navigates away.
  window.addEventListener('pagehide', stop, { once: true })

  const tick = (): void => {
    if (!running) return
    const now = performance.now()
    const t = (now - start) / 1000
    const dt = Math.min(0.05, (now - prev) / 1000)
    prev = now

    // Eased dolly-in over the first ~3.2s, then a slow drift orbit layered
    // on top of the settled position.
    const k = easeOutCubic(Math.min(1, t / 3.2))
    camera.position.lerpVectors(camStart, camEnd, k)
    camera.position.x += Math.sin(t * 0.25) * 0.6
    camera.lookAt(camTarget)

    trophy.rotation.y += dt * 1.4
    trophy.position.y = (winnerSlot ? winnerSlot.height + 0.95 : 2.2) + Math.sin(t * 2) * 0.05
    confetti.update(dt)

    if (!standingsShown && t > CEREMONY_SECONDS) revealStandings()

    renderer.render(scene, camera)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  hideLoadingScreen()
}

// ──────────────────────────────── helpers ─────────────────────────────────

function aspect(): number {
  return (window.innerWidth || 1) / (window.innerHeight || 1)
}

function easeOutCubic(x: number): number {
  return 1 - (1 - x) ** 3
}

/** Hex string for a podium medal colour (0=gold, 1=silver, 2=bronze). */
function medalHex(index: number): string | null {
  if (index === 0) return '#ffd27a'
  if (index === 1) return '#cbd5e1'
  if (index === 2) return '#cd7f32'
  return null
}

function medalInt(index: number): number {
  if (index === 0) return 0xffd54a
  if (index === 1) return 0xcbd5e1
  return 0xcd7f32
}

function makeGradientBackground(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#10243f')
    grad.addColorStop(0.55, '#0a1626')
    grad.addColorStop(1, '#05080f')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 4, 256)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makePodiumBlock(height: number, index: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, height, 1.4),
    new THREE.MeshStandardMaterial({
      color: 0x16263c,
      roughness: 0.5,
      metalness: 0.3,
      emissive: medalInt(index),
      emissiveIntensity: 0.12,
    }),
  )
  return mesh
}

/** Build a stylised trophy from lathe + primitive parts. Always gold —
 *  it's the cup's championship trophy; the player's own medal is conveyed
 *  by the standings card. */
function makeTrophy(): THREE.Group {
  const group = new THREE.Group()
  const gold = new THREE.MeshStandardMaterial({
    color: TROPHY_GOLD,
    roughness: 0.25,
    metalness: 0.95,
    emissive: 0x4d3a00,
    emissiveIntensity: 0.35,
  })

  // Cup bowl — a lathe profile.
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.26, 0.02),
    new THREE.Vector2(0.3, 0.12),
    new THREE.Vector2(0.22, 0.34),
    new THREE.Vector2(0.3, 0.5),
    new THREE.Vector2(0.32, 0.58),
  ]
  const bowl = new THREE.Mesh(new THREE.LatheGeometry(profile, 32), gold)
  bowl.position.y = 0.2
  group.add(bowl)

  // Stem + base.
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.22, 16), gold)
  stem.position.y = 0.08
  group.add(stem)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.08, 24), gold)
  base.position.y = -0.04
  group.add(base)

  // Handles.
  const handleGeo = new THREE.TorusGeometry(0.12, 0.025, 12, 24, Math.PI)
  const left = new THREE.Mesh(handleGeo, gold)
  left.position.set(-0.3, 0.5, 0)
  left.rotation.z = Math.PI / 2
  group.add(left)
  const right = new THREE.Mesh(handleGeo, gold)
  right.position.set(0.3, 0.5, 0)
  right.rotation.z = -Math.PI / 2
  group.add(right)

  group.scale.setScalar(1.1)
  return group
}

const CONFETTI_COLORS = [0x5cf2ff, 0xffd54a, 0xff7ec1, 0x66ff99, 0xff7a3a, 0xffffff]

function makeConfetti(count: number): { points: THREE.Points; update: (dt: number) => void } {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const velocities = new Float32Array(count)
  const spin = new Float32Array(count)
  const color = new THREE.Color()
  const spread = 9
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * spread
    positions[i * 3 + 1] = Math.random() * 9 + 3
    positions[i * 3 + 2] = (Math.random() - 0.5) * spread
    velocities[i] = 0.8 + Math.random() * 1.4
    spin[i] = Math.random() * Math.PI
    color.setHex(CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? 0xffffff)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.16,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  })
  const points = new THREE.Points(geo, mat)

  const update = (dt: number): void => {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < count; i++) {
      const v = velocities[i] ?? 1
      const s = (spin[i] ?? 0) + dt * 2
      spin[i] = s
      let y = pos.getY(i) - v * dt
      const x = pos.getX(i) + Math.sin(s) * dt * 0.6
      if (y < 0) y = Math.random() * 4 + 8
      pos.setX(i, x)
      pos.setY(i, y)
    }
    pos.needsUpdate = true
  }
  return { points, update }
}

function makeTextSprite(text: string, hex: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(7, 30, 38, 0.6)'
    roundRect(ctx, 6, 30, 500, 68, 12)
    ctx.fill()
    ctx.font = 'bold 44px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hex
    ctx.fillText(text.toUpperCase(), canvas.width / 2, canvas.height / 2 + 2)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(2.0, 0.5, 1)
  return sprite
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Load a bike GLB for the podium, tinted to its livery. Falls back to the
 *  racer GLB, then to a primitive stand-in, so a missing asset never breaks
 *  the ceremony. */
async function loadPodiumBike(variantId: string, bodyColor: number): Promise<THREE.Object3D> {
  try {
    const loaded = await loadBike(assetUrl(`/assets/bikes/${variantId}.glb`))
    return cloneLoadedBike(loaded, { tintLivery: bodyColor }).root
  } catch {
    try {
      const loaded = await loadBike(assetUrl('/assets/bikes/racer.glb'))
      return cloneLoadedBike(loaded, { tintLivery: bodyColor }).root
    } catch {
      return makePlaceholderBike(bodyColor)
    }
  }
}

/** Last-resort stand-in bike: a couple of tinted boxes so the podium still
 *  reads when no GLB is available (offline dev / stripped asset bundle). */
function makePlaceholderBike(bodyColor: number): THREE.Object3D {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.4, metalness: 0.5 })
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 1.3), mat)
  body.position.y = 0.32
  group.add(body)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 12), mat)
  nose.rotation.x = Math.PI / 2
  nose.position.set(0, 0.32, 0.8)
  group.add(nose)
  return group
}
