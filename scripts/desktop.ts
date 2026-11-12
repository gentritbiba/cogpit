/**
 * Builds and runs the Tauri desktop app in `desktop/`.
 *
 *   bun run desktop:dev     Vite (renderer only) + the shell running the server from source
 *   bun run desktop:build   the renderer, the bundled server and the app bundle
 *   bun scripts/desktop.ts stage   only the renderer and the bundled server
 *
 * A built app runs the API server as a sidecar on the Bun runtime it ships
 * (`desktop/binaries/`), from the bundle staged in `desktop/resources/`
 * (`desktop/tauri.bundle.json`). A dev build runs `server/desktop.ts` from
 * source on the developer's own Bun.
 */
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const desktop = join(root, "desktop")
const resources = join(desktop, "resources")
/** The renderer dev server `desktop:dev` starts; the server proxies everything that is not an API to it. */
const RENDERER_DEV_URL = "http://localhost:5174"

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status}).`)
}

function rustTarget(): string {
  const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout?.match(/^host: (\S+)$/m)?.[1]
  if (!host) throw new Error("rustc is not on PATH; install Rust (https://rustup.rs) to build the desktop app.")
  return host
}

/** Tauri looks external binaries up by target triple. */
function stageRuntime(): void {
  const directory = join(desktop, "binaries")
  mkdirSync(directory, { recursive: true })
  const extension = process.platform === "win32" ? ".exe" : ""
  const target = join(directory, `cogpit-bun-${rustTarget()}${extension}`)
  cpSync(process.execPath, target)
  chmodSync(target, 0o755)
}

/** node-pty is loaded from disk: its native addon and helpers cannot live inside the bundle. */
function stageNodePty(serverDir: string): void {
  const source = join(root, "node_modules/node-pty")
  const target = join(serverDir, "node_modules/node-pty")
  for (const entry of ["package.json", "LICENSE", "lib"]) cpSync(join(source, entry), join(target, entry), { recursive: true })
  const prebuild = `prebuilds/${process.platform}-${process.arch}`
  cpSync(join(source, prebuild), join(target, prebuild), { recursive: true })
}

async function stageServer(): Promise<void> {
  const serverDir = join(resources, "server")
  for (const [entry, name] of [["server/desktop.ts", "desktop"], ["server/agents/instanceWorker.ts", "instance-worker"]]) {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: serverDir,
      naming: `${name}.js`,
      target: "bun",
      external: ["node-pty"],
    })
    if (!result.success) throw new AggregateError(result.logs, `Bundling ${entry} failed`)
  }
  stageNodePty(serverDir)
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

async function build(): Promise<void> {
  await stage()
  stageRuntime()
  run("bunx", ["tauri", "build", "--config", join(desktop, "tauri.bundle.json"), ...process.argv.slice(3)])
}

function dev(): void {
  run("bun", ["run", "build:generated"])
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
