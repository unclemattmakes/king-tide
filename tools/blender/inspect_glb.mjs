#!/usr/bin/env node
/**
 * Read a .glb file's JSON chunk and dump its node list with extras.
 *
 * Usage: node tools/blender/inspect_glb.mjs <path/to/file.glb> [--node <name>]
 *
 * Useful for verifying that the headless builders produced the right
 * extras-keyed contract (kind, slot, shape, etc.) — see T6 in
 * docs/asset-pipeline-plan.md.
 */
import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

const path = argv[2]
if (!path) {
  console.error('usage: inspect_glb.mjs <path> [--node <name>]')
  exit(1)
}
const filterIdx = argv.indexOf('--node')
const filter = filterIdx > 0 ? argv[filterIdx + 1] : null

const buf = readFileSync(path)
if (buf.readUInt32LE(0) !== 0x46546c67 /* 'glTF' */) {
  console.error('not a glTF binary file')
  exit(2)
}

const chunkLen = buf.readUInt32LE(12)
const chunkType = buf.readUInt32LE(16)
if (chunkType !== 0x4e4f534a /* 'JSON' */) {
  console.error('first chunk is not JSON — file layout unexpected')
  exit(2)
}
const json = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'))

console.log(`# ${path}`)
console.log(
  `# nodes=${json.nodes?.length ?? 0} meshes=${json.meshes?.length ?? 0} materials=${json.materials?.length ?? 0}`,
)
console.log()
for (let i = 0; i < (json.nodes?.length ?? 0); i++) {
  const n = json.nodes[i]
  if (filter && n.name !== filter) continue
  const extras = n.extras ?? {}
  const extraKeys = Object.keys(extras)
  const tag = extraKeys.length
    ? ' { ' + extraKeys.map((k) => `${k}=${JSON.stringify(extras[k])}`).join(', ') + ' }'
    : ''
  console.log(`  [${i}] ${n.name ?? '(unnamed)'}${tag}`)
}
