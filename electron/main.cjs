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

// WebGPU on Linux/Chromium rides on Vulkan; the Deck's RADV stack provides
// it. Enable explicitly so we exercise the GPU path (harmless on platforms
// where WebGPU is already on by default).
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-features', 'Vulkan')

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
  win.loadURL('app://bundle/index.html')
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
