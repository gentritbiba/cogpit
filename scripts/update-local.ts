import { spawn } from "node:child_process"
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquireUpdate, applyWhenClosed, resolveAppPath, runningAppProcesses, validateApp, writeJob, type LocalUpdateJob } from "./lib/localUpdate.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code}).`)))
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun run electron:update [--app /Applications/Cogpit.app]\nBuilds this checkout and installs after Cogpit quits. A running app is reopened after the update.")
    return
  }
  if (args.length && !(args.length === 2 && args[0] === "--app")) throw new Error("Use --help for usage.")
  if (process.platform !== "darwin") throw new Error("Local desktop updates currently support macOS only.")
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported architecture: ${process.arch}`)
  const appPath = resolveAppPath(args[1])
  accessSync(dirname(appPath), constants.W_OK)
  if (existsSync(appPath)) validateApp(appPath)
  const directory = acquireUpdate(appPath)
  const buildDirectory = join(directory, "build")
  const stagedApp = join(buildDirectory, process.arch === "arm64" ? "mac-arm64" : "mac", "Cogpit.app")
  const job: LocalUpdateJob = { format: 1, appPath, stagedApp, pid: process.pid, status: "building", relaunch: runningAppProcesses(appPath).length > 0 }
  let handedOff = false
  try {
    writeJob(job)
    const config = join(directory, "builder.json")
    writeFileSync(config, JSON.stringify({
      extends: join(root, "electron-builder.yml"),
      directories: { output: buildDirectory },
      mac: { identity: null, notarize: false },
    }))
    console.log("Building the current checkout. Cogpit can stay open while this runs.")
    await run(process.execPath, ["run", "typecheck:electron"])
    await run(process.execPath, ["run", "electron:build"])
    await run(join(root, "node_modules/.bin/electron-builder"), ["--dir", "--mac", `--${process.arch}`, "--publish", "never", "--config", config])
    const version = validateApp(stagedApp)
    const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
    if (version !== packageVersion) throw new Error(`Built version ${version} does not match the checkout's ${packageVersion}.`)
    writeFileSync(join(stagedApp, "Contents/Resources/local-build.json"), JSON.stringify({ version, builtAt: new Date().toISOString(), source: root }, null, 2))

    if (runningAppProcesses(appPath).length === 0) {
      await applyWhenClosed(job)
      console.log(`Updated ${appPath} to local build ${version}.${job.relaunch ? " Cogpit has reopened." : " Open Cogpit when ready."}`)
      return
    }

    job.relaunch = true
    const worker = join(directory, "installer.mjs")
    await run(process.execPath, ["build", join(root, "scripts/local-update-worker.ts"), "--target=bun", `--outfile=${worker}`])
    const logDirectory = join(homedir(), ".cogpit")
    mkdirSync(logDirectory, { recursive: true })
    const logPath = join(logDirectory, "local-update.log")
    const log = openSync(logPath, "a", 0o600)
    try {
      const child = spawn(process.execPath, [worker, appPath], { cwd: directory, detached: true, stdio: ["ignore", log, log] })
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve)
        child.once("error", reject)
      })
      job.pid = child.pid!
      job.status = "starting"
      writeJob(job)
      child.unref()
      handedOff = true
    } finally {
      closeSync(log)
    }
    console.log(`Local build ${version} is ready. Quit Cogpit with Cmd+Q when you are ready; the update will install and Cogpit will reopen.\nInstaller log: ${logPath}`)
  } finally {
    if (!handedOff && !existsSync(join(directory, "previous.app"))) rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
