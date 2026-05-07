export type Clock = {
  now(): number
  fps: number
  frame: number
}

export function createClock(): Clock {
  let lastFpsUpdate = performance.now()
  let framesThisSecond = 0
  let fps = 0
  let frame = 0

  return {
    now: () => performance.now(),
    get fps() {
      const t = performance.now()
      framesThisSecond += 1
      frame += 1
      if (t - lastFpsUpdate >= 1000) {
        fps = (framesThisSecond * 1000) / (t - lastFpsUpdate)
        framesThisSecond = 0
        lastFpsUpdate = t
      }
      return fps
    },
    get frame() {
      return frame
    },
  }
}
