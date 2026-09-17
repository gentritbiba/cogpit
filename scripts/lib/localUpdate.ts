import { execFileSync } from "node:child_process"
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export interface LocalUpdateJob {
  format: 1
  appPath: string
  stagedApp: string
  pid: number
  status: "building" | "starting" | "waiting" | "installing"
  relaunch: boolean
}

export function updateDirectory(appPath: string): string {
  return join(dirname(appPath), `.${basename(appPath)}.local-update`)
}

export function writeJob(job: LocalUpdateJob): void {
  const path = join(updateDirectory(job.appPath), "job.json")
  writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

export function readJob(appPath: string): LocalUpdateJob {
  const directory = updateDirectory(appPath)
  const job: LocalUpdateJob = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"))
  if (job.format !== 1 || job.appPath !== appPath || !Number.isSafeInteger(job.pid) || job.pid <= 0
    || typeof job.stagedApp !== "string" || !resolve(job.stagedApp).startsWith(`${join(directory, "build")}${sep}`)) {
    throw new Error(`Unrecognized update state at ${directory}; it has been left untouched.`)
  }
  return job
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

export function appProcessIds(appPath: string, listing: string): number[] {
  const prefix = `${appPath}/Contents/`
  return listing.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    return match && match[2].startsWith(prefix) ? [Number(match[1])] : []
  })
}

export function runningAppProcesses(appPath: string): number[] {
  return appProcessIds(appPath, execFileSync("/bin/ps", ["-ww", "-axo", "pid=,comm="], { encoding: "utf8" }))
}

export function validateApp(appPath: string): string {
  if (!lstatSync(appPath).isDirectory() || !appPath.endsWith(".app")) {
    throw new Error(`Expected a regular application bundle: ${appPath}`)
  }
  const plist = join(appPath, "Contents/Info.plist")
  const readValue = (key: string) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim()
  if (readValue("CFBundleIdentifier") !== "com.cogpit.app" || readValue("CFBundleExecutable") !== "Cogpit") {
    throw new Error(`Refusing to replace a bundle that is not Cogpit: ${appPath}`)
  }
  accessSync(join(appPath, "Contents/MacOS/Cogpit"), constants.X_OK)
  accessSync(join(appPath, "Contents/Resources/app.asar"), constants.R_OK)
  return readValue("CFBundleShortVersionString")
}

export function acquireUpdate(appPath: string, isAlive = processExists): string {
  const directory = updateDirectory(appPath)
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!lstatSync(directory).isDirectory()) throw new Error(`Update path is not a directory: ${directory}`)
    const previousJob = readJob(appPath)
    if (isAlive(previousJob.pid)) {
      throw new Error(`A local update is already ${previousJob.status} (PID ${previousJob.pid}). Quit Cogpit when you are ready to apply it.`)
    }
    const backup = join(directory, "previous.app")
    if (existsSync(backup)) {
      if (existsSync(appPath)) {
        throw new Error(`An interrupted install left a backup at ${backup}. Both copies have been preserved; inspect them before retrying.`)
      }
      renameSync(backup, appPath)
    }
    rmSync(directory, { recursive: true })
    mkdirSync(directory, { mode: 0o700 })
  }
  return directory
}

export function installApp(job: LocalUpdateJob, options: {
  rename?: typeof renameSync
  launch?: (appPath: string) => void
} = {}): void {
  const rename = options.rename ?? renameSync
  const backup = join(updateDirectory(job.appPath), "previous.app")
  const hadPrevious = existsSync(job.appPath)
  if (hadPrevious) rename(job.appPath, backup)
  let installed = false
  try {
    rename(job.stagedApp, job.appPath)
    installed = true
    if (job.relaunch) (options.launch ?? launchApp)(job.appPath)
  } catch (error) {
    if (installed) rename(job.appPath, job.stagedApp)
    if (hadPrevious) rename(backup, job.appPath)
    throw error
  }
  if (hadPrevious) rmSync(backup, { recursive: true })
}

function launchApp(appPath: string): void {
  execFileSync("/usr/bin/open", [appPath], { stdio: "pipe" })
}

export async function applyWhenClosed(job: LocalUpdateJob, options: {
  processes?: (appPath: string) => number[]
  wait?: () => Promise<unknown>
  install?: (job: LocalUpdateJob) => void
  validate?: (appPath: string) => string
} = {}): Promise<void> {
  const processes = options.processes ?? runningAppProcesses
  const wait = options.wait ?? (() => delay(1000))
  job.status = "waiting"
  writeJob(job)
  while (processes(job.appPath).length > 0) await wait()
  const validate = options.validate ?? validateApp
  validate(job.stagedApp)
  if (existsSync(job.appPath)) validate(job.appPath)
  // Check again after validation, including helpers that can outlive the window.
  if (processes(job.appPath).length > 0) return applyWhenClosed(job, options)
  job.status = "installing"
  writeJob(job)
  const install = options.install ?? installApp
  install(job)
}

export function resolveAppPath(value = "/Applications/Cogpit.app"): string {
  const appPath = resolve(value)
  if (basename(appPath) !== "Cogpit.app") throw new Error("The destination must be named Cogpit.app.")
  return join(realpathSync(dirname(appPath)), basename(appPath))
}
