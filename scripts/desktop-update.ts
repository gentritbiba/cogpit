/**
 * Builds this checkout's desktop app and installs it over the installed one.
 *
 *   bun run desktop:update [--app /Applications/Cogpit.app]
 *
 * Cogpit can stay open while this builds; the swap happens once it has quit,
 * and a running app is reopened. The installed build carries
 * `local-build.json`, which keeps the in-app updater from replacing it.
 */
import { spawn } from "node:child_process"
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { acquireUpdate, applyWhenClosed, resolveAppPath, runningAppProcesses, validateApp, validateBuild, writeJob, type LocalUpdateJob } from "./lib/localUpdate"
import { root } from "./lib/sourceFiles"

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
    console.log("Usage: bun run desktop:update [--app /Applications/Cogpit.app]\nBuilds this checkout and installs after Cogpit quits. A running app is reopened after the update.")
    return
  }
  if (args.length && !(args.length === 2 && args[0] === "--app")) throw new Error("Use --help for usage.")
  if (process.platform !== "darwin") throw new Error("Local desktop updates currently support macOS only.")
  const appPath = resolveAppPath(args[1])
  accessSync(dirname(appPath), constants.W_OK)
  if (existsSync(appPath)) validateApp(appPath)
  const directory = acquireUpdate(appPath)
  const stagedApp = join(directory, "build", "Cogpit.app")
  const job: LocalUpdateJob = { format: 1, appPath, stagedApp, pid: process.pid, status: "building", relaunch: runningAppProcesses(appPath).length > 0 }
  let handedOff = false
  try {
    writeJob(job)
    const packageVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version
    const marker = join(directory, "local-build.json")
    writeFileSync(marker, JSON.stringify({ version: packageVersion, builtAt: new Date().toISOString(), source: root }, null, 2))
    console.log("Building the current checkout. Cogpit can stay open while this runs.")
    await run(process.execPath, [
      "scripts/desktop.ts", "build", "--bundles", "app",
      "--config", JSON.stringify({ bundle: { resources: { [marker]: "local-build.json" } } }),
    ])
    const built = join(process.env.CARGO_TARGET_DIR?.trim() || join(root, "desktop/target"), "release/bundle/macos/Cogpit.app")
    mkdirSync(dirname(stagedApp), { recursive: true })
    // Next to the installed app, so the swap is a rename on one volume.
    await run("/usr/bin/ditto", [built, stagedApp])
    const version = validateBuild(stagedApp)
    if (version !== packageVersion) throw new Error(`Built version ${version} does not match the checkout's ${packageVersion}.`)

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
