#!/usr/bin/env node
/**
 * Generate placeholder app icons for the Electron desktop builds.
 * Writes minimal solid-color PNGs (and a real Windows .ico container)
 * so electron-builder has icons to stamp onto the Linux/Windows builds
 * during pre-art development. Replace with real art once the v1 brand
 * assets land.
 *
 * Color: hoverbike teal #00B4B4 over an opaque background — keeps the
 * placeholder distinct from any future palette experiments so it's
 * obvious in screenshots / debug output that the icons aren't final.
 *
 * Outputs:
 *   32x32.png        — Linux taskbar
 *   128x128.png      — Linux high-DPI
 *   128x128@2x.png   — Linux retina
 *   icon.png         — generic 512² master (Linux fallback)
 *   icon.ico         — Windows app + installer icon (PNG-embedded ICO)
 *
 * No deps — PNG/ICO bytes written directly. PNG = IHDR + IDAT + IEND.
 * ICO = ICONDIR + one ICONDIRENTRY pointing at an embedded PNG (modern
 * Windows ICO format; Vista+ accepts PNG inside the container).
 *
 * macOS .icns is deliberately omitted — we don't ship macOS yet.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ICONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'electron',
  'icons',
)

mkdirSync(ICONS_DIR, { recursive: true })

// Hoverbike-teal placeholder color.
const R = 0x00
const G = 0xb4
const B = 0xb4
const A = 0xff

function crc32(buf) {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return ~crc >>> 0
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

function chunk(type, data) {
  const len = u32(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = u32(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function makePng(size) {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // IHDR: width, height, bitdepth=8, colortype=6 (RGBA), compression=0, filter=0, interlace=0
  const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])
  // IDAT: each scanline starts with filter byte 0, then RGBA pixels.
  const row = Buffer.alloc(1 + size * 4)
  row[0] = 0
  for (let x = 0; x < size; x++) {
    row[1 + x * 4 + 0] = R
    row[1 + x * 4 + 1] = G
    row[1 + x * 4 + 2] = B
    row[1 + x * 4 + 3] = A
  }
  const raw = Buffer.alloc(size * row.length)
  for (let y = 0; y < size; y++) {
    row.copy(raw, y * row.length)
  }
  const idat = deflateSync(raw)
  // Reuse chunk helper. IEND is empty.
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Linux PNGs + a 512² master used as the Windows ICO source.
const targets = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
]

const pngs = new Map()
for (const t of targets) {
  const png = makePng(t.size)
  pngs.set(t.name, png)
  const dest = path.join(ICONS_DIR, t.name)
  writeFileSync(dest, png)
  console.log(`wrote ${dest} (${png.length} B, ${t.size}px)`)
}

// Windows .ico — a single 256×256 PNG embedded in an ICO container.
// Modern Windows (Vista+) parses ICO files where each entry is a PNG
// rather than a BMP. electron-builder reads this for both the .exe icon
// and the NSIS installer.
//
// Layout: ICONDIR header (6 B) + one ICONDIRENTRY (16 B) + PNG bytes.
const winPng = pngs.get('128x128@2x.png') // 256x256 master
const icoDir = Buffer.alloc(6)
icoDir.writeUInt16LE(0, 0) // reserved
icoDir.writeUInt16LE(1, 2) // type = 1 (icon)
icoDir.writeUInt16LE(1, 4) // count = 1

const icoEntry = Buffer.alloc(16)
icoEntry.writeUInt8(0, 0) // width: 0 means 256
icoEntry.writeUInt8(0, 1) // height: 0 means 256
icoEntry.writeUInt8(0, 2) // numColors = 0 (truecolor)
icoEntry.writeUInt8(0, 3) // reserved
icoEntry.writeUInt16LE(1, 4) // planes (irrelevant for PNG, set to 1)
icoEntry.writeUInt16LE(32, 6) // bitcount (32 = RGBA)
icoEntry.writeUInt32LE(winPng.length, 8) // bytes in resource
icoEntry.writeUInt32LE(6 + 16, 12) // offset = header + entry size

const ico = Buffer.concat([icoDir, icoEntry, winPng])
const icoDest = path.join(ICONS_DIR, 'icon.ico')
writeFileSync(icoDest, ico)
console.log(`wrote ${icoDest} (${ico.length} B, 256×256 PNG-in-ICO)`)

console.log('\ndone — placeholders ready. Swap with real art when v1 art lands.')
