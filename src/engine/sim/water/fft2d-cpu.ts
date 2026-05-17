/**
 * Pure-JS 2D radix-2 Cooley-Tukey FFT, used as:
 *
 *   1. The reference / oracle for the GPU compute pipeline in later
 *      phases (we compare GPU IFFT output against this).
 *   2. The one-shot CPU bake in Phase C — the spectrum is IFFTed once
 *      at boot into a slope texture that water.ts samples as a
 *      drop-in replacement for the procedural sub-Gerstner detail
 *      cascade.
 *
 * No SIMD, no workers, no library dependency — N=256 takes ~30 ms
 * which is fine for a boot-time bake. If the per-frame animated path
 * ever needs CPU FFT (e.g. for the WebGL2 fallback), we'd revisit.
 *
 * Layout: complex grids are stored as interleaved Float32Arrays of
 * length 2·N·N. `arr[2·idx]` is the real part, `arr[2·idx + 1]` is the
 * imaginary part, with `idx = z·N + x`. This matches `phillips.ts`'s
 * h0 layout exactly so consumers can hand a Phillips spectrum straight
 * to `ifft2d`.
 *
 * Center convention: the input from `buildPhillipsSpectrum` is in
 * "centered" order (DC at index N/2, wavenumbers running from −N/2 to
 * N/2−1). The IFFT here expects "natural" order (DC at index 0,
 * wavenumbers wrapping at Nyquist). `fftshift` and `ifftshift` convert
 * between the two. Same convention as NumPy's `np.fft.fftshift`.
 */

const TWO_PI = Math.PI * 2

/**
 * In-place bit-reversal permutation. Stage 1 of any iterative
 * Cooley-Tukey FFT — the input is reordered so the butterfly stages
 * read consecutive elements from each pair. Operates on the
 * interleaved-complex layout: each "element" is a real/imag pair, so
 * the swap moves 2 floats at a time.
 *
 * `N` is the array length in complex elements (NOT floats). Must be a
 * power of two.
 */
function bitReverse(buf: Float32Array, N: number): void {
  // Standard textbook bit-reversal walk.
  let j = 0
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      const ai = 2 * i
      const aj = 2 * j
      const r = buf[ai]!
      const im = buf[ai + 1]!
      buf[ai] = buf[aj]!
      buf[ai + 1] = buf[aj + 1]!
      buf[aj] = r
      buf[aj + 1] = im
    }
    let m = N >> 1
    while (m >= 1 && j >= m) {
      j -= m
      m >>= 1
    }
    j += m
  }
}

/**
 * In-place 1D Cooley-Tukey FFT. `direction = +1` is the forward
 * transform; `direction = -1` is the inverse. Inverse scaling (`/N`)
 * is applied here so consumers don't have to remember.
 *
 * `N` must be a power of two.
 */
function fft1d(buf: Float32Array, N: number, direction: 1 | -1): void {
  bitReverse(buf, N)
  // Butterfly stages. At stage `s`, blocks of size `m = 2^s` get
  // combined; the inner loop sweeps pairs (j, j+m/2) within each block.
  for (let s = 1; s <= Math.log2(N); s++) {
    const m = 1 << s
    const halfM = m >> 1
    // Twiddle base angle for this stage. Sign convention: forward FFT
    // uses e^{−i2π/N} (so a real signal's positive frequencies sit in
    // the lower half of the spectrum), inverse uses e^{+i2π/N}. Per
    // Tessendorf (and matching `sampleSpectrumHeight`'s `cos(k·x + ω·t)`
    // sign), the synthesis path is the +i inverse FFT.
    const baseAngle = (-direction * TWO_PI) / m
    for (let k = 0; k < N; k += m) {
      // Per-pair twiddles, walked incrementally to avoid sin/cos
      // inside the inner loop.
      let wr = 1
      let wi = 0
      const cosB = Math.cos(baseAngle)
      const sinB = Math.sin(baseAngle)
      for (let j = 0; j < halfM; j++) {
        const tIdx = 2 * (k + j + halfM)
        const tr = wr * buf[tIdx]! - wi * buf[tIdx + 1]!
        const ti = wr * buf[tIdx + 1]! + wi * buf[tIdx]!
        const uIdx = 2 * (k + j)
        const ur = buf[uIdx]!
        const ui = buf[uIdx + 1]!
        buf[uIdx] = ur + tr
        buf[uIdx + 1] = ui + ti
        buf[tIdx] = ur - tr
        buf[tIdx + 1] = ui - ti
        // Advance twiddle: w *= e^{i·baseAngle}.
        const nwr = wr * cosB - wi * sinB
        wi = wr * sinB + wi * cosB
        wr = nwr
      }
    }
  }
  if (direction === -1) {
    const inv = 1 / N
    for (let i = 0; i < 2 * N; i++) buf[i] *= inv
  }
}

/**
 * 2D FFT by separable 1D transforms: FFT every row, then FFT every
 * column. The IFFT (`direction = -1`) does the same with reversed
 * sign on the twiddle and a 1/N² total scaling (applied as 1/N per
 * 1D pass).
 *
 * `N` must be a power of two. Operates in-place on a 2·N·N interleaved-
 * complex Float32Array, indexed as `arr[2·(z·N + x) + {0,1}]`.
 */
export function fft2d(buf: Float32Array, N: number, direction: 1 | -1): void {
  // Row pass.
  const row = new Float32Array(2 * N)
  for (let z = 0; z < N; z++) {
    const rowStart = z * N * 2
    for (let i = 0; i < 2 * N; i++) row[i] = buf[rowStart + i]!
    fft1d(row, N, direction)
    for (let i = 0; i < 2 * N; i++) buf[rowStart + i] = row[i]!
  }
  // Column pass: gather column z into row, transform, scatter back.
  const col = new Float32Array(2 * N)
  for (let x = 0; x < N; x++) {
    for (let z = 0; z < N; z++) {
      const idx2 = (z * N + x) * 2
      col[2 * z] = buf[idx2]!
      col[2 * z + 1] = buf[idx2 + 1]!
    }
    fft1d(col, N, direction)
    for (let z = 0; z < N; z++) {
      const idx2 = (z * N + x) * 2
      buf[idx2] = col[2 * z]!
      buf[idx2 + 1] = col[2 * z + 1]!
    }
  }
}

/**
 * Move the DC component to / from the array origin. The Phillips
 * spectrum lays out wavenumbers centered (DC at N/2), but the FFT
 * here wants them in natural order (DC at 0). Apply `ifftshift` before
 * `fft2d(buf, N, -1)`, then `fftshift` on the result if you want the
 * heightfield in centered coords.
 *
 * For an N×N grid (N even), shifting is the same operation in both
 * directions — swap quadrant (0,0)↔(N/2,N/2) and (0,N/2)↔(N/2,0). We
 * still expose both names so the call sites read clearly.
 */
export function fftshift(buf: Float32Array, N: number): void {
  shiftQuadrants(buf, N)
}
export function ifftshift(buf: Float32Array, N: number): void {
  shiftQuadrants(buf, N)
}

function shiftQuadrants(buf: Float32Array, N: number): void {
  const half = N / 2
  for (let z = 0; z < half; z++) {
    for (let x = 0; x < half; x++) {
      // Quadrant TL (z, x) ↔ BR (z + half, x + half)
      const a = (z * N + x) * 2
      const b = ((z + half) * N + (x + half)) * 2
      const ar = buf[a]!
      const ai = buf[a + 1]!
      buf[a] = buf[b]!
      buf[a + 1] = buf[b + 1]!
      buf[b] = ar
      buf[b + 1] = ai
      // Quadrant TR (z, x + half) ↔ BL (z + half, x)
      const c = (z * N + (x + half)) * 2
      const d = ((z + half) * N + x) * 2
      const cr = buf[c]!
      const ci = buf[c + 1]!
      buf[c] = buf[d]!
      buf[c + 1] = buf[d + 1]!
      buf[d] = cr
      buf[d + 1] = ci
    }
  }
}
