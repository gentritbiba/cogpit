import { execFile, spawn } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { validateApp } from "../scripts/lib/localUpdate.ts"
import { downloadVerified, type Fetch, type FeedFile } from "./updateFeed.ts"

/**
 * Release builds are ad-hoc signed, so Squirrel.Mac (electron-updater's macOS
 * path) rejects every update: its designated requirement is a per-build cdhash.
 * Cogpit instead stages the verified bundle beside the installed one and a
 * detached shell swaps them once the app has exited.
 */

/** Waits for the app to exit, swaps the bundles, restores the old one on failure, optionally reopens. */
export const SWAP_SCRIPT = `
pid=$1 app=$2 staged=$3 relaunch=$4
stage=$(dirname "$staged")
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 3000 ] && exit 1
  sleep 0.2
done
mv "$app" "$stage/previous.app" || exit 1
if mv "$staged" "$app"; then
  rm -rf "$stage"
else
  mv "$stage/previous.app" "$app"
  exit 1
fi
[ "$relaunch" = 1 ] && exec /usr/bin/open "$app"
exit 0
`

export interface StagedMacUpdate { version: string; appPath: string; stagedApp: string }

/** The bundle Cogpit can replace in place, or null when it runs from somewhere it must not or cannot write. */
export function replaceableAppPath(executablePath: string, resourcesPath: string): string | null {
  const appPath = dirname(dirname(dirname(executablePath)))
  if (!appPath.endsWith(".app") || appPath.startsWith("/Volumes/") || appPath.includes("/AppTranslocation/")) return null
  // A bundle installed by `bun run electron:update` is the developer's own build.
  if (existsSync(join(resourcesPath, "local-build.json"))) return null
  try {
    accessSync(dirname(appPath), constants.W_OK)
    accessSync(appPath, constants.W_OK)
  } catch {
    return null
  }
  return appPath
}

/** Electron reads any path through an .asar file as an archive; a staged bundle must be handled as plain files. */
function plainFiles<T>(work: () => T): T {
  const previous = process.noAsar
  process.noAsar = true
  try {
    return work()
  } finally {
    process.noAsar = previous
  }
}

export function stageDirectory(appPath: string): string {
  return join(dirname(appPath), `.${basename(appPath)}.update`)
}

export async function stageMacUpdate(fetchImpl: Fetch, appPath: string, version: string, archiveUrl: string, archive: FeedFile): Promise<StagedMacUpdate> {
  const stage = stageDirectory(appPath)
  const clear = () => plainFiles(() => rmSync(stage, { recursive: true, force: true }))
  clear()
  mkdirSync(stage, { mode: 0o700 })
  try {
    const zip = join(stage, "update.zip")
    await downloadVerified(fetchImpl, archiveUrl, archive, zip)
    await promisify(execFile)("/usr/bin/ditto", ["-x", "-k", zip, stage])
    rmSync(zip)
    const stagedApp = join(stage, "Cogpit.app")
    const stagedVersion = plainFiles(() => validateApp(stagedApp))
    if (stagedVersion !== version) throw new Error(`Update archive holds ${stagedVersion}, expected ${version}.`)
    return { version, appPath, stagedApp }
  } catch (error) {
    clear()
    throw error
  }
}

export function swapAfterExit(update: StagedMacUpdate, relaunch: boolean): void {
  spawn("/bin/sh", ["-c", SWAP_SCRIPT, "cogpit-update", String(process.pid), update.appPath, update.stagedApp, relaunch ? "1" : "0"], {
    detached: true,
    stdio: "ignore",
  }).unref()
}
