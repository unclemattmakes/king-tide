#!/usr/bin/env node
/**
 * Generate placeholder Tauri app icons. Writes minimal solid-color PNGs
 * (and matching .ico / .icns) so `cargo tauri build` can proceed during
 * pre-art development. Replace with real art via `cargo tauri icon`
 * once the v1 brand assets land.
 *
 * Color: hoverbike teal #00B4B4 over an opaque background — keeps the
 * placeholder distinct from any future palette experiments so it's
 * obvious in screenshots / debug output that the icons aren't final.
 *
 * No deps — we write the PNG bytes directly. Each icon is a solid color
 * filling the requested size. PNG format: IHDR + IDAT (deflated raw RGB)
 * + IEND. Tiny. ~200 bytes per icon.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ICONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons')

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
  const ihdr = Buffer.concat([
    u32(size),
    u32(size),
    Buffer.from([8, 6, 0, 0, 0]),
  ])
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

// PNG-only set. The Linux AppImage + deb targets only need PNGs, so
// we skip the .ico/.icns ceremony. When we add Windows or macOS
// targets, run `cargo tauri icon path/to/master.png` to generate the
// real container formats — those need proper headers, not renamed
// PNG bytes.
const targets = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
]

for (const t of targets) {
  const png = makePng(t.size)
  const dest = path.join(ICONS_DIR, t.name)
  writeFileSync(dest, png)
  console.log(`wrote ${dest} (${png.length} B, ${t.size}px)`)
}

console.log('\ndone — placeholders ready. Swap with real art via `cargo tauri icon` when v1 art lands.')
