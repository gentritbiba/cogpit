/**
 * Builds and runs the Tauri desktop app in `desktop/`.
 *
 *   bun run desktop:dev     Vite (renderer only) + the shell running the server from source
 *   bun run desktop:build   the renderer, the bundled server and the app bundle
 *   bun scripts/desktop.ts stage   only the renderer and the bundled server
 *
 * A built app runs the API server as a sidecar on the Bun runtime it ships,
 * next to the Rust core (`desktop/binaries/`), from the bundle staged in
 * `desktop/resources/` (`desktop/tauri.bundle.json`). A dev build runs
 * `server/desktop.ts` from source on the developer's own Bun.
 *
 * Environment a release build sets:
 *   COGPIT_CORE_PREBUILT     ship this cogpit-core instead of building one
 *   TAURI_SIGNING_PRIVATE_KEY (and its _PASSWORD)
 *                            also produce the signed files the app's updater installs
 *   COGPIT_ELECTRON_BRIDGE   "1": the macOS bundle carries the file the Electron
 *                            app's updater insists on, so it accepts this app
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const desktop = join(root, "desktop")
const resources = join(desktop, "resources")
/** The renderer dev server `desktop:dev` starts; the server proxies everything that is not an API to it. */
const RENDERER_DEV_URL = "http://localhost:5174"
const EXE = process.platform === "win32" ? ".exe" : ""

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status}).`)
}

function rustTarget(): string {
  const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout?.match(/^host: (\S+)$/m)?.[1]
  if (!host) throw new Error("rustc is not on PATH; install Rust (https://rustup.rs) to build the desktop app.")
  return host
}

/** Ship a binary next to the app executable; Tauri looks external binaries up by target triple. */
function stageBinary(name: string, source: string): void {
  const directory = join(desktop, "binaries")
  mkdirSync(directory, { recursive: true })
  const target = join(directory, `${name}-${rustTarget()}${EXE}`)
  cpSync(source, target)
  chmodSync(target, 0o755)
}

/**
 * The Bun release every desktop app ships as `cogpit-bun`, whatever Bun ran the
 * build. Bump the version and the checksums (SHASUMS256.txt of the release) together.
 */
const BUN_VERSION = "1.4.3"
const BUN_ARCHIVES: Record<string, { name: string; sha256: string }> = {
  "darwin-arm64": { name: "bun-darwin-aarch64", sha256: "80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403" },
  "darwin-x64": { name: "bun-darwin-x64", sha256: "62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d" },
  "linux-arm64": { name: "bun-linux-aarch64", sha256: "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21" },
  "linux-x64": { name: "bun-linux-x64", sha256: "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18" },
  "win32-x64": { name: "bun-windows-x64", sha256: "0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d" },
}

/** The pinned Bun for this machine: the one running the build when it matches, else the verified release download. */
async function pinnedBun(): Promise<string> {
  if (process.versions.bun === BUN_VERSION) return process.execPath
  const archive = BUN_ARCHIVES[`${process.platform}-${process.arch}`]
  if (!archive) throw new Error(`No pinned Bun ${BUN_VERSION} for ${process.platform}-${process.arch}.`)
  const directory = join(desktop, "target", "bun", BUN_VERSION)
  const binary = join(directory, archive.name, `bun${EXE}`)
  if (existsSync(binary)) return binary
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${archive.name}.zip`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading ${url} failed (${response.status}).`)
  const zip = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash("sha256").update(zip).digest("hex")
  if (sha256 !== archive.sha256) throw new Error(`${url} has checksum ${sha256}, expected ${archive.sha256}.`)
  mkdirSync(directory, { recursive: true })
  const zipPath = join(directory, `${archive.name}.zip`)
  writeFileSync(zipPath, zip)
  // Windows ships bsdtar, which reads zip; Linux tar does not.
  if (process.platform === "win32") run("tar", ["-xf", zipPath, "-C", directory])
  else run("unzip", ["-o", "-q", zipPath, "-d", directory])
  rmSync(zipPath)
  return binary
}

/** The Bun runtime the server runs on, and the Rust core the server supervises. */
async function stageBinaries(): Promise<void> {
  stageBinary("cogpit-bun", await pinnedBun())
  const prebuilt = process.env.COGPIT_CORE_PREBUILT?.trim()
  if (prebuilt) return stageBinary("cogpit-core", prebuilt)
  run("bun", ["run", "build:core", "--release"])
  const targetDir = process.env.CARGO_TARGET_DIR?.trim() || join(root, "target")
  stageBinary("cogpit-core", join(targetDir, "release", `cogpit-core${EXE}`))
}

async function stageServer(): Promise<void> {
  const serverDir = join(resources, "server")
  for (const [entry, name] of [["server/desktop.ts", "desktop"], ["server/agents/instanceWorker.ts", "instance-worker"]]) {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: serverDir,
      naming: `${name}.js`,
      target: "bun",
    })
    if (!result.success) throw new AggregateError(result.logs, `Bundling ${entry} failed`)
  }
  // `/api/hello` reports the version from the package.json beside the server's folder.
  const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string }
  writeFileSync(join(resources, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`)
}

/** The renderer and the bundled server, as the app bundle carries them. */
async function stage(): Promise<void> {
  rmSync(resources, { recursive: true, force: true })
  mkdirSync(resources, { recursive: true })
  run("bun", ["run", "build:web", "--outDir", join(resources, "web"), "--emptyOutDir"])
  await stageServer()
}

/**
 * The Electron app's macOS updater only accepts a bundle holding
 * `Contents/Resources/app.asar`. Carrying a placeholder lets installs that
 * still run Electron update themselves to this app.
 */
const ELECTRON_BRIDGE = { bundle: { macOS: { files: { "Resources/app.asar": "electron-bridge/app.asar" } } } }

async function build(): Promise<void> {
  await stage()
  await stageBinaries()
  const configs = [join(desktop, "tauri.bundle.json")]
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) configs.push(join(desktop, "tauri.release.json"))
  if (process.env.COGPIT_ELECTRON_BRIDGE === "1" && process.platform === "darwin") configs.push(JSON.stringify(ELECTRON_BRIDGE))
  run("bunx", ["tauri", "build", ...configs.flatMap((config) => ["--config", config]), ...process.argv.slice(3)])
}

function dev(): void {
  run("bun", ["run", "build:generated"])
  run("bun", ["run", "build:core"])
  const env = { ...process.env, COGPIT_RENDERER_DEV_URL: RENDERER_DEV_URL }
  const port = new URL(RENDERER_DEV_URL).port
  const vite = spawn("bunx", ["vite", "--mode", "renderer", "--port", port, "--strictPort"], { cwd: root, stdio: "inherit", env })
  const shell = spawn("bunx", ["tauri", "dev", ...process.argv.slice(3)], { cwd: root, stdio: "inherit", env })
  const stop = () => { vite.kill(); shell.kill() }
  process.once("SIGINT", stop)
  shell.once("exit", (code) => { vite.kill(); process.exit(code ?? 0) })
  vite.once("exit", (code) => { if (code) shell.kill() })
}

const command = process.argv[2]
if (command === "build") await build()
else if (command === "stage") await stage()
else if (command === "dev") dev()
else throw new Error("Usage: bun scripts/desktop.ts dev|build|stage [tauri args]")
