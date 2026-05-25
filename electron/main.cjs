// Minimal Electron shell — SPIKE to validate the Steam/Deck wrapper.
//
// Goal: confirm the existing Vite `dist/` build (1) launches inside the
// Steam Linux Runtime container and (2) gets real Chromium WebGPU + good
// perf — the two things WebKitGTK/Tauri can't give us on the Deck. This is
// throwaway scaffolding until the spike is proven green; if we commit to the
// migration it grows a preload bridge (Deck detection) + Steamworks.
//
// dist/ is served over a custom `app://bundle/` scheme (registered standard
// + secure) rather than file:// so (a) Vite's default absolute asset paths
// ("/assets/…") resolve against the app origin and (b) the page runs in a
// secure context, which WebGPU requires.

const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')

// WebGPU on Linux/Chromium rides on Vulkan; the Deck's RADV stack provides
// it. Enable explicitly so the spike actually exercises the GPU path we're
// here to test (harmless on platforms where WebGPU is already on by default).
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-features', 'Vulkan')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0e18',
    webPreferences: { sandbox: true },
  })
  win.removeMenu()
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
