// Electron main process — the desktop/Steam wrapper around the Vite `dist/`
// build. Replaces the former Tauri/WebKitGTK shell: on the Steam Deck that
// stack couldn't launch inside the Steam Linux Runtime and only ever got a
// WebGL2 fallback. Electron bundles its own Chromium, so it runs in the
// runtime container and gives us real WebGPU.
//
// dist/ is served over a custom `app://bundle/` scheme (registered standard
// + secure) rather than file:// so (a) Vite's default absolute asset paths
// ("/assets/…") resolve against the app origin and (b) the page runs in a
// secure context, which WebGPU requires.

const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')

// Steam installs depot files without the setuid bit, so Electron's
// chrome-sandbox helper can't initialise inside the Steam Linux Runtime
// container. Disable the sandbox — we only ever load local, trusted content
// over app://, so there's no remote renderer to isolate. Standard practice
// for Electron titles shipped on Steam.
app.commandLine.appendSwitch('no-sandbox')

// Inside the Steam Linux Runtime (pressure-vessel) the zygote's namespace
// setup fails with EINVAL → FATAL in zygote_host_impl_linux.cc. Dropping the
// zygote fork model sidesteps it. Only effective paired with --no-sandbox;
// the launch wrapper also passes both on the command line (more reliable than
// appendSwitch, since the zygote is spun up very early).
app.commandLine.appendSwitch('no-zygote')

// WebGPU enablement is Linux-only.
//
// - On real Windows, Chromium's WebGPU is enabled by default for D3D12 on
//   allow-listed drivers; we don't need (and shouldn't override) the safety
//   check.
// - On Windows running under Proton on the Steam Deck — which is how the Deck
//   ships — Chromium's WebGPU is gated *off* by the same safety check because
//   the D3D12 backend rides VKD3D-Proton, which Chromium's GPU blocklist
//   considers unsafe. With --enable-unsafe-webgpu the page initialises WebGPU
//   anyway, and Three's render path then silently produces a black frame
//   (similar failure mode to the bloom cache-key bug in post-pipeline.ts).
//   Letting Chromium pick the safe path → WebGL2 fallback renders fine.
// - On Linux desktop (non-Steam, X11), WebGPU/Dawn rides plain Vulkan and
//   renders correctly. We still set the flags so a direct-launch Linux user
//   gets WebGPU. Native Linux on Deck via the Steam Linux Runtime is shelved.
//
// NOTE: do NOT add `--use-angle=vulkan` / VulkanFromANGLE / DefaultANGLEVulkan
// here. Those were a (never-confirmed) attempt to make Vulkan present under
// Wayland inside the Steam Linux Runtime, and they black-screen the normal
// render path.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('enable-features', 'Vulkan')
}

// Boot-time diagnostic: log which GPU-relevant flags this binary applied, so
// `coredumpctl`/`journalctl`/Steam log scrapes can confirm the active config
// without devtools. Reads back the actual values from commandLine.
const gpuFlags = ['enable-unsafe-webgpu', 'enable-features', 'use-angle', 'no-sandbox', 'no-zygote']
const applied = gpuFlags
  .map((f) => {
    const v = app.commandLine.getSwitchValue(f)
    return app.commandLine.hasSwitch(f) ? (v ? `--${f}=${v}` : `--${f}`) : null
  })
  .filter(Boolean)
console.info(`[main] platform=${process.platform} gpu flags: ${applied.join(' ') || '(none)'}`)

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// Steam exports `SteamDeck=1` to processes it launches on Deck hardware.
// The renderer's detectSteamDeck() keys partly off a "SteamDeck" UA token
// (the cheap, reliable signal), so surface it by appending the token to the
// window's user agent when we know we're on a Deck — no preload/IPC needed.
const ON_DECK = process.env.SteamDeck === '1'

// Bridge for diagnostic overrides set via Steam launch options:
//   HOVERBIKE_BACKEND=webgl2  %command%   # force WebGL2 even when WebGPU is available
//   HOVERBIKE_BACKEND=webgpu  %command%   # force WebGPU adapter probe path
// The renderer (src/engine/render/renderer.ts) reads `?backend=…` and respects
// the override. Proton bridges Linux env vars into the Wine process, so this
// works for the Windows depot launched on the Deck too.
const BACKEND_OVERRIDE = (process.env.HOVERBIKE_BACKEND || '').toLowerCase()
const VALID_BACKENDS = new Set(['webgl2', 'webgpu', 'auto'])
const backendQuery =
  BACKEND_OVERRIDE && VALID_BACKENDS.has(BACKEND_OVERRIDE)
    ? `?backend=${BACKEND_OVERRIDE}`
    : ''
if (BACKEND_OVERRIDE && !backendQuery) {
  console.warn(
    `[main] ignoring HOVERBIKE_BACKEND='${BACKEND_OVERRIDE}' — expected one of ${[
      ...VALID_BACKENDS,
    ].join('|')}`,
  )
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'Hoverbike',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    resizable: true,
    backgroundColor: '#0b0e18',
    webPreferences: { sandbox: false },
  })
  win.removeMenu()
  if (ON_DECK) {
    win.webContents.setUserAgent(`${win.webContents.getUserAgent()} SteamDeck/1`)
  }
  win.loadURL(`app://bundle/index.html${backendQuery}`)
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    let rel = decodeURIComponent(new URL(request.url).pathname)
    if (!rel || rel === '/') rel = '/index.html'
    // Pin every request inside DIST — reject path-traversal escapes.
    const resolved = path.normalize(path.join(DIST, rel))
    if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(resolved).toString())
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
