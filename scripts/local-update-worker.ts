import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { applyWhenClosed, readJob, updateDirectory } from "./lib/localUpdate.ts"

const appPath = process.argv[2]
const directory = updateDirectory(appPath)
try {
  let job = readJob(appPath)
  for (let attempt = 0; job.pid !== process.pid && attempt < 100; attempt++) {
    await delay(50)
    job = readJob(appPath)
  }
  if (job.pid !== process.pid) throw new Error("The update command did not transfer ownership to the installer.")
  console.log(`${new Date().toISOString()} Waiting for Cogpit to quit.`)
  await applyWhenClosed(job)
  console.log(`${new Date().toISOString()} Installed ${appPath}${job.relaunch ? " and reopened Cogpit" : ""}.`)
  rmSync(directory, { recursive: true })
} catch (error) {
  console.error(`${new Date().toISOString()} Local update failed:`, error)
  if (existsSync(join(directory, "previous.app"))) {
    console.error(`The previous app is preserved at ${join(directory, "previous.app")}.`)
  }
  process.exitCode = 1
}
