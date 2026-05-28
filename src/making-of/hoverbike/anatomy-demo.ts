import * as THREE from 'three'
import { BIKE_VARIANTS, type BikeVariantId, DEFAULT_BIKE_VARIANT } from '@/game/bikes/variants'
import { createDemoHarness } from '../shared/demo-harness'
import { buildBike } from '../shared/scene-bits'
import { el, panel, readout, segmented, toggle } from '../shared/ui'

/**
 * Chapter 07 / anatomy demo. A rotating, isolated view of the stylized
 * hoverbike — variant-tintable body, the four hover probes shown at their
 * shipping bow/stern/port/starboard slots, and a wireframe overlay of the
 * underlying physics capsule (0.6 m × 0.45 m, mirrored from
 * `src/game/entities/bike.ts`).
 *
 * The variant list and stats are imported live from
 * `@/game/bikes/variants` so this page reflects whatever the shipping
 * archetypes are at the time the article is built.
 */

// Stylized hull length used for the demo bike. Matches the buoyancy
// chapter's footprint so the probe spread reads as "the same bike".
const HALF_LEN = 1.0
const HALF_WIDTH = HALF_LEN * 0.5

// Physics capsule from src/game/entities/bike.ts — half-length is "length /
// 2", and CapsuleGeometry takes the cylindrical mid-section length, also
// known as length-minus-the-hemispheres.
const CAPSULE_LEN = 0.6
const CAPSULE_RADIUS = 0.45

const VARIANT_ORDER: BikeVariantId[] = ['racer', 'cruiser', 'stunt', 'scout', 'sparrow']

export function mountAnatomyDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [3.6, 2.2, 4.4],
    target: [0, 0.5, 0],
    fov: 45,
    background: 0x070f1a,
  })
  const { scene, controls } = harness
  controls.target.set(0, 0.5, 0)
  controls.minDistance = 3
  controls.maxDistance = 14
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.9
  controls.addEventListener('start', () => {
    controls.autoRotate = false
    autoRotateToggle.set(false)
  })

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a1526, 0.9))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.4)
  sun.position.set(-4, 7, 5)
  scene.add(sun)
  const fill = new THREE.DirectionalLight(0x6aa0c8, 0.5)
  fill.position.set(6, 3, -4)
  scene.add(fill)

  // ── Bike body ────────────────────────────────────────────────────────
  const startVariant = BIKE_VARIANTS[DEFAULT_BIKE_VARIANT]
  const bike = buildBike(HALF_LEN, { bodyColor: startVariant.bodyColor })
  scene.add(bike)

  // ── Four hover probes at the corners of the footprint ─────────────────
  // Color convention shared with the buoyancy chapter: yellow = pitch
  // (bow/stern read fore-aft slope), cyan = roll (port/starboard read
  // side slope). Helps readers carry the colors between the two demos.
  const pitchMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x4a3a00 })
  const rollMat = new THREE.MeshStandardMaterial({ color: 0x4dd6ff, emissive: 0x003a4a })
  const probeGeo = new THREE.SphereGeometry(0.12, 16, 12)
  const probeGroup = new THREE.Group()
  const probeY = 0.06
  const probeSpots: Array<{ x: number; z: number; mat: THREE.MeshStandardMaterial }> = [
    { x: 0, z: HALF_LEN, mat: pitchMat }, // bow
    { x: 0, z: -HALF_LEN, mat: pitchMat }, // stern
    { x: HALF_WIDTH, z: 0, mat: rollMat }, // starboard
    { x: -HALF_WIDTH, z: 0, mat: rollMat }, // port
  ]
  for (const p of probeSpots) {
    const m = new THREE.Mesh(probeGeo, p.mat)
    m.position.set(p.x, probeY, p.z)
    probeGroup.add(m)
  }
  scene.add(probeGroup)

  // ── Physics capsule wireframe (the actual collider) ──────────────────
  // CapsuleGeometry defaults to axis +Y, so rotate it to lie along +Z to
  // match the bike's forward axis.
  const capGeo = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_LEN, 6, 18)
  capGeo.rotateX(Math.PI / 2)
  const capMat = new THREE.MeshBasicMaterial({
    color: 0x9fc8ff,
    wireframe: true,
    transparent: true,
    opacity: 0.4,
  })
  const capsule = new THREE.Mesh(capGeo, capMat)
  capsule.position.y = 0.35
  scene.add(capsule)

  // ── Stat readouts (filled in by applyVariant) ────────────────────────
  const massOut = readout('Mass')
  const heightOut = readout('Hover height')
  const speedOut = readout('Top speed')
  const accelOut = readout('Accel (forward thrust)')
  const torqueOut = readout('Turn torque')
  const dragOut = readout('Lateral drag')
  const tagline = el('p', { class: 'mo-variant-tagline' }, [''])

  function applyVariant(id: BikeVariantId): void {
    const v = BIKE_VARIANTS[id]
    const bodyMat = (bike.userData as { bodyMat?: THREE.MeshStandardMaterial }).bodyMat
    if (bodyMat) bodyMat.color.setHex(v.bodyColor)
    tagline.textContent = v.tagline
    massOut.set(`${v.stats.mass} kg`)
    heightOut.set(`${v.stats.hoverHeight.toFixed(2)} m`)
    speedOut.set(`${v.stats.topSpeed} m/s`)
    accelOut.set(`${v.stats.accel} m/s²`)
    torqueOut.set(`${v.stats.turnTorque.toFixed(1)} rad/s²`)
    dragOut.set(`${v.stats.lateralDrag} m/s² per m/s`)
  }

  const autoRotateToggle = makeToggleHandle({
    label: 'Auto-rotate the camera',
    value: true,
    onChange: (v) => {
      controls.autoRotate = v
    },
  })

  controlsHost.append(
    panel('Pick a flavor', [
      segmented({
        label: 'Variant',
        value: DEFAULT_BIKE_VARIANT,
        options: VARIANT_ORDER.map((id) => ({ value: id, label: BIKE_VARIANTS[id].name })),
        onChange: (v) => applyVariant(v as BikeVariantId),
      }),
      tagline,
    ]),
    panel('Sim stats (live from variants.ts)', [
      massOut.node,
      heightOut.node,
      speedOut.node,
      accelOut.node,
      torqueOut.node,
      dragOut.node,
    ]),
    panel('Show', [
      toggle({
        label: 'Hover probes (yellow = pitch, cyan = roll)',
        value: true,
        onChange: (v) => {
          probeGroup.visible = v
        },
      }),
      toggle({
        label: 'Physics capsule (the actual collider)',
        value: true,
        onChange: (v) => {
          capsule.visible = v
        },
      }),
      autoRotateToggle.node,
    ]),
  )

  applyVariant(DEFAULT_BIKE_VARIANT)

  return () => {
    harness.dispose()
    probeGeo.dispose()
    pitchMat.dispose()
    rollMat.dispose()
    capGeo.dispose()
    capMat.dispose()
  }
}

// A toggle whose external `set` flips the underlying checkbox without
// firing the onChange callback. Used so the orbit-controls "start" event
// can flip the auto-rotate toggle visually when the user grabs the camera.
function makeToggleHandle(opts: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'mo-checkbox'
  input.checked = opts.value
  input.addEventListener('change', () => opts.onChange(input.checked))
  const label = document.createElement('label')
  label.className = 'mo-ctrl mo-ctrl-toggle'
  const span = document.createElement('span')
  span.className = 'mo-ctrl-label'
  span.textContent = opts.label
  label.append(input, span)
  return {
    node: label,
    set: (v: boolean) => {
      input.checked = v
    },
  }
}
