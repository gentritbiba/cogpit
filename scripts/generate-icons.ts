/**
 * Renders every platform icon from the single source mark at public/cogpit.svg.
 *
 * Run after changing the mark:  bun run generate:icons
 * Requires librsvg (`brew install librsvg`); .icns generation additionally needs macOS.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SOURCE = `${ROOT}/public/cogpit.svg`

const APPLE_TOUCH_ICON = `${ROOT}/public/apple-touch-icon.png`
const DESKTOP_PNG = `${ROOT}/build/icon.png`
const DESKTOP_ICNS = `${ROOT}/build/icon.icns`
const DESKTOP_ICO = `${ROOT}/build/icon.ico`
const IOS_ICON = `${ROOT}/ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png`

const rel = (path: string) => path.replace(`${ROOT}/`, '')

// ---------------------------------------------------------------- rendering

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`${cmd[0]} exited ${code}: ${err.trim()}`)
  }
}

async function render(svg: string, size: number): Promise<Buffer> {
  const proc = Bun.spawn(['rsvg-convert', '-w', String(size), '-h', String(size)], {
    stdin: new TextEncoder().encode(svg),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [png, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`rsvg-convert exited ${code}: ${err.trim()}`)
  return Buffer.from(png)
}

/** iOS and the mobile Home Screen apply their own squircle mask, so square off our corners first. */
const fullBleed = (svg: string) => svg.replace(/(<rect id="bg"[^>]*?)\s+rx="\d+"/, '$1')

/**
 * The App Store rejects icons carrying an alpha channel. librsvg drops it on
 * fully opaque input, so this guards the assumption rather than re-encoding.
 */
function assertOpaque(png: Buffer, label: string): Buffer {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, 4-byte
  // type, then width(4) height(4) depth(1) — putting colour type at byte 25.
  if (png.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${label}: not a PNG`)
  const colourType = png[25]
  if (colourType !== 2) {
    throw new Error(`${label}: expected alpha-free RGB (colour type 2), got ${colourType} — is the background still opaque?`)
  }
  return png
}

// ------------------------------------------------------------- ICO container
// Vista-era .ico files may embed PNG frames verbatim, so no BMP encoding needed.

function buildIco(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // resource type: icon
  header.writeUInt16LE(frames.length, 4)

  let offset = 6 + frames.length * 16
  const entries = frames.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size // 0 encodes 256
    entry[1] = size === 256 ? 0 : size
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })

  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)])
}

// ----------------------------------------------------------------- pipeline

async function writeIcns(svg: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    console.warn('  skipped build/icon.icns — iconutil is macOS-only')
    return false
  }
  const staging = mkdtempSync(join(tmpdir(), 'cogpit-icons-'))
  const iconset = join(staging, 'icon.iconset')
  mkdirSync(iconset)
  try {
    // iconutil requires exactly these filenames.
    const slots: [string, number][] = [
      ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
    ]
    for (const [name, size] of slots) {
      writeFileSync(join(iconset, name), await render(svg, size))
    }
    await run(['iconutil', '-c', 'icns', iconset, '-o', DESKTOP_ICNS])
    return true
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE)) throw new Error(`missing source mark: ${SOURCE}`)
  const svg = await Bun.file(SOURCE).text()
  const bleed = fullBleed(svg)
  if (bleed === svg) {
    throw new Error('could not square off the corners — is <rect id="bg" … rx="…"> still in the SVG?')
  }

  console.log(`Rendering icons from ${rel(SOURCE)}`)

  writeFileSync(DESKTOP_PNG, await render(svg, 512))
  console.log(`  ${rel(DESKTOP_PNG)} — 512×512`)

  if (await writeIcns(svg)) console.log(`  ${rel(DESKTOP_ICNS)} — 16→1024`)

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const frames = await Promise.all(icoSizes.map(async (size) => ({ size, png: await render(svg, size) })))
  writeFileSync(DESKTOP_ICO, buildIco(frames))
  console.log(`  ${rel(DESKTOP_ICO)} — ${icoSizes.join(', ')}`)

  writeFileSync(APPLE_TOUCH_ICON, assertOpaque(await render(bleed, 180), rel(APPLE_TOUCH_ICON)))
  console.log(`  ${rel(APPLE_TOUCH_ICON)} — 180×180, full-bleed`)

  writeFileSync(IOS_ICON, assertOpaque(await render(bleed, 1024), rel(IOS_ICON)))
  console.log(`  ${rel(IOS_ICON)} — 1024×1024, full-bleed, no alpha`)
}

await main()
