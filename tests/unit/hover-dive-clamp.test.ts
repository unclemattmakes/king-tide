import { describe, expect, it } from 'vitest'
import {
  applyPlayerPitchTorque,
  DIVE_PITCH_FWD_LIMIT_DEG,
  type HoverFrame,
} from '@/game/systems/hover'

/**
 * Pins the airborne dive-clamp DIRECTION in applyPlayerPitchTorque.
 *
 * The clamp's job (916fa6e, tuned 6bd1276/cf11928): once the chassis is
 * pitched more than DIVE_PITCH_FWD_LIMIT below the surface tangent
 * (nose buried), suppress further nose-down player torque. It must NOT
 * fire when the nose is HIGH — that's exactly when the dive kick is
 * wanted (pitch-the-landing off a wave or ramp launch, the signature
 * mechanic). The comparison shipped inverted for two weeks and made
 * Q-dives randomly dead on nose-high launches depending on the wave
 * slope under the flight (caught via the m9-air-control e2e flake);
 * this test makes the orientation regression-proof at the unit level.
 *
 * Convention (see the grounded PD in hover.ts): pitchAngle =
 * asin(−fwd.y); rotation about the bike's +right (local +X) axis by
 * +α pitches the nose DOWN by α, giving fwd.y = −sin(α) — so positive
 * pitchAngle = nose down. A torque along +right is a nose-down torque.
 */

/** Quat for a pure pitch: rotation about local +X by `rad` (positive =
 *  nose down). fwd.y = 2(qy·qz − qx·qw) = −sin(rad). */
function pitchQuat(rad: number): { x: number; y: number; z: number; w: number } {
  return { x: Math.sin(rad / 2), y: 0, z: 0, w: Math.cos(rad / 2) }
}

type Vec = { x: number; y: number; z: number }

function makeFrame(pitchRad: number, intentPitch: number): { frame: HoverFrame; torques: Vec[] } {
  const q = pitchQuat(pitchRad)
  const torques: Vec[] = []
  const rb = {
    rotation: () => q,
    applyTorqueImpulse: (t: Vec) => {
      torques.push({ ...t })
    },
    applyImpulse: () => {},
  } as unknown as HoverFrame['rb']
  const frame = {
    eid: 1,
    rb,
    intent: { pitch: intentPitch },
    q,
    dt: 1 / 60,
    m: 1,
  } as unknown as HoverFrame
  return { frame, torques }
}

const LIMIT_RAD = (DIVE_PITCH_FWD_LIMIT_DEG * Math.PI) / 180
const NOSE_HIGH = -16 * (Math.PI / 180) // fwd.y ≈ +0.28 — a ramp/wave launch
const NOSE_BURIED = LIMIT_RAD + 8 * (Math.PI / 180) // well past the dive ceiling

describe('airborne-over-water dive clamp', () => {
  it('lets the dive kick fire when the nose is high (the wave-mastery case)', () => {
    const { frame, torques } = makeFrame(NOSE_HIGH, -1)
    applyPlayerPitchTorque(frame, false, true, 0, 0, 0)
    expect(torques.length).toBe(1)
    // Nose-down torque = along +right = +X for a pure-pitch attitude.
    expect(torques[0]!.x).toBeGreaterThan(0)
  })

  it('suppresses nose-down torque once buried past the dive ceiling', () => {
    const { frame, torques } = makeFrame(NOSE_BURIED, -1)
    applyPlayerPitchTorque(frame, false, true, 0, 0, 0)
    expect(torques.length).toBe(0)
  })

  it('measures the ceiling against the surface tangent, not the horizon', () => {
    // Same buried-vs-horizon attitude, but the surface drops away ahead
    // steeply enough that the bike is still ABOVE tangent − limit:
    // pitchAngle − (−atan(slope)) must stay ≤ limit. With slope = −0.6
    // (downhill-forward), target = +31°, so a 20° nose-down chassis is
    // 11° ABOVE the target — torque must fire.
    const { frame, torques } = makeFrame(NOSE_BURIED, -1)
    applyPlayerPitchTorque(frame, false, true, -0.6, 0, 0)
    expect(torques.length).toBe(1)
    expect(torques[0]!.x).toBeGreaterThan(0)
  })

  it('never gates pitch-up input, even when buried', () => {
    const { frame, torques } = makeFrame(NOSE_BURIED, +1)
    applyPlayerPitchTorque(frame, false, true, 0, 0, 0)
    expect(torques.length).toBe(1)
    // Nose-up torque = along −right.
    expect(torques[0]!.x).toBeLessThan(0)
  })

  it('tapers the dive kick to zero under sustained held input', () => {
    const { frame, torques } = makeFrame(NOSE_HIGH, -1)
    applyPlayerPitchTorque(frame, false, true, 0, 999, 0)
    expect(torques.length).toBe(1)
    expect(Math.abs(torques[0]!.x)).toBeLessThan(1e-9)
  })
})
