/**
 * Step 8 — Console-error trap for QA.
 *
 * Installed once at the top of `main.ts` (before any other module gets a
 * chance to throw or warn). Captures four signal streams into a bounded
 * ring buffer:
 *
 *  - uncaught synchronous exceptions (`window.onerror`)
 *  - unhandled promise rejections (`window.onunhandledrejection`)
 *  - `console.error` calls
 *  - `console.warn` calls
 *
 * The ring is the source of truth for two consumers:
 *
 *  1. `__hover.qa.consoleErrors()` — debug accessor surfaced to Playwright
 *     specs and Claude shells so a test that asserts "no console errors"
 *     gets a stable, deduped view rather than racing against the live
 *     console object.
 *  2. `bug-bundle.ts` — the repro bundle dumps the ring verbatim so a QA
 *     filer can attach "the last 200 messages before the crash" to a
 *     GitHub issue.
 *
 * Design notes:
 *  - The trap MUST be allocation-light. We pre-size the ring + reuse a
 *    single record shape; no closure allocations per call.
 *  - The trap proxies `console.error/warn` rather than replacing them so
 *    Vite + browser devtools still see the original output.
 *  - Stack frames are captured opportunistically via `Error.stack`; not
 *    every browser dialect gives us one and we tolerate `undefined`.
 *  - The trap is install-once. A second call is a no-op so HMR doesn't
 *    accumulate proxy layers (Vite's HMR re-runs `main.ts` modules but
 *    not the entire bundle).
 */

/** Capacity of the ring. ~200 entries is enough for the last few seconds
 *  of a runaway error spam without flooding GC. */
export const CONSOLE_TRAP_CAPACITY = 200

export type ConsoleSource = 'error' | 'warn' | 'pageerror' | 'unhandledrejection'

export type ConsoleRecord = {
  /** Which signal produced this entry. */
  source: ConsoleSource
  /** Human-readable message — formatted args joined by spaces. */
  message: string
  /** Best-effort stack trace, if available. */
  stack?: string
  /** Monotonic timestamp (performance.now()) at capture. */
  ts: number
}

export type ConsoleTrap = {
  /** Snapshot of every record currently in the ring, oldest first. */
  records(): ConsoleRecord[]
  /** Records since a previous count, as a delta. Useful in Playwright
   *  specs that want to assert "no errors during this 5s window". */
  recordsSince(prevCount: number): ConsoleRecord[]
  /** Total records ever captured (monotonic; not the ring size). */
  totalCount(): number
  /** Wipe the ring. Total count stays. */
  clear(): void
  /** True iff any `error` or `pageerror` or `unhandledrejection` record
   *  is currently in the ring. Warnings don't count. */
  hasErrors(): boolean
}

let installed: ConsoleTrap | null = null

export function installConsoleTrap(capacity: number = CONSOLE_TRAP_CAPACITY): ConsoleTrap {
  if (installed) return installed

  const cap = Math.max(1, Math.floor(capacity))
  const ring: ConsoleRecord[] = []
  let total = 0

  function push(source: ConsoleSource, message: string, stack?: string): void {
    total += 1
    const rec: ConsoleRecord = { source, message, ts: now() }
    if (stack) rec.stack = stack
    if (ring.length < cap) {
      ring.push(rec)
    } else {
      // Shift oldest out. Array of <=cap is small enough that the shift
      // cost is negligible; we'd reach for a true ring if this ever ran
      // hot (it shouldn't — errors are by definition rare).
      ring.shift()
      ring.push(rec)
    }
  }

  // Format console.error/warn args the way devtools does — strings pass
  // through, everything else gets JSON-stringified (with a fallback for
  // circular structures). Mirrors what Playwright's `ConsoleMessage.text()`
  // would produce so the trap's records line up with Playwright's view.
  function formatArgs(args: unknown[]): string {
    return args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return `${a.name}: ${a.message}`
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
  }

  // Only run the DOM-side install if we're in a browser. Unit tests under
  // node/jsdom hit this code path too; we gate the listeners but still
  // return a working trap so the unit tests can drive push() via the
  // exported `__pushForTest` hook below.
  if (typeof window !== 'undefined') {
    const originalError = console.error.bind(console)
    const originalWarn = console.warn.bind(console)

    console.error = (...args: unknown[]): void => {
      const text = formatArgs(args)
      // If the first arg is an Error, prefer its stack.
      const err = args.find((a): a is Error => a instanceof Error)
      push('error', text, err?.stack)
      originalError(...args)
    }
    console.warn = (...args: unknown[]): void => {
      push('warn', formatArgs(args))
      originalWarn(...args)
    }

    window.addEventListener('error', (ev) => {
      const msg = ev.error instanceof Error ? `${ev.error.name}: ${ev.error.message}` : ev.message
      push('pageerror', msg, ev.error instanceof Error ? ev.error.stack : undefined)
    })

    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason
      const msg = r instanceof Error ? `${r.name}: ${r.message}` : String(r)
      push('unhandledrejection', msg, r instanceof Error ? r.stack : undefined)
    })
  }

  const trap: ConsoleTrap = {
    records: () => ring.slice(),
    recordsSince: (prev) => {
      // Records emitted since the caller observed `prev` total. If the
      // ring already wrapped past `prev`, we return what survived.
      const dropped = total - ring.length
      const start = Math.max(0, prev - dropped)
      return ring.slice(start)
    },
    totalCount: () => total,
    clear: () => {
      ring.length = 0
    },
    hasErrors: () =>
      ring.some(
        (r) =>
          r.source === 'error' || r.source === 'pageerror' || r.source === 'unhandledrejection',
      ),
  }

  // Expose a private push hook for unit tests — see console-trap.test.ts.
  // The `__` prefix + presence-check at call sites keeps this from leaking
  // into the public type.
  ;(trap as { __pushForTest?: typeof push }).__pushForTest = push

  installed = trap
  return trap
}

/** Returns the singleton if installed, else null. The bug-bundle reads
 *  through this so it never accidentally double-installs. */
export function consoleTrap(): ConsoleTrap | null {
  return installed
}

/** Test-only — wipes the singleton so install can be re-run with a fresh
 *  capacity. Never call from product code. */
export function __resetConsoleTrapForTest(): void {
  installed = null
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}
