import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import lockfile from "proper-lockfile"
import { z } from "zod"
import { documentBytes, durableWrite, exists, regularFile, removeDurably } from "./durable"
import { parseJsonText } from "./json"

const ownerSchema = z.strictObject({ formatVersion: z.literal(1), hostname: z.string(), pid: z.number().int().positive(), token: z.string().uuid(), startedAt: z.number().int().nonnegative() })
export interface PluginStoreLock { assertOwned(): Promise<void>; release(): Promise<void> }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}
export async function acquirePluginStoreLock(root: string, onCompromised: (reason: string) => void): Promise<PluginStoreLock> {
  const lockPath = join(root, ".store.lock")
  const ownerPath = join(root, "owner.json")
  for (let attempt = 0; attempt < 2; attempt++) {
    const lockExists = await exists(lockPath)
    const ownerExists = await exists(ownerPath)
    if (!lockExists && !ownerExists) break
    let owner: z.infer<typeof ownerSchema>
    try { owner = ownerSchema.parse(parseJsonText(await regularFile(ownerPath), 4096)) }
    catch { throw new Error("Plugin store lock has missing or malformed ownership; recovery requires operator inspection") }
    if (owner.hostname !== hostname()) throw new Error("Plugin store belongs to another host; network filesystems are unsupported")
    if (alive(owner.pid)) throw new Error(`Plugin store already has a live owner process ${owner.pid}`)
    if (!lockExists) break
    const lockStat = await lstat(lockPath)
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw new Error("Plugin store lock is not a real directory")
    if (attempt > 0) break
    const remaining = lockStat.mtimeMs + 10100 - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(remaining, 10100))
  }
  let compromised: string | undefined
  const markCompromised = (message: string) => {
    if (compromised) return
    compromised = message
    onCompromised(message)
  }
  const releaseLock = await lockfile.lock(root, {
    realpath: false, lockfilePath: lockPath, stale: 10000, update: 2000, retries: 0,
    onCompromised: error => markCompromised(`Plugin store ownership was compromised: ${error.message}`),
  })
  const token = randomUUID()
  const identity = await lstat(lockPath)
  const owner = { formatVersion: 1, hostname: hostname(), pid: process.pid, token, startedAt: Date.now() }
  try {
    await durableWrite(ownerPath, documentBytes(owner), { label: "owner", guard: async () => { if (compromised) throw new Error(compromised) } })
  } catch (error) { await releaseLock(); throw error }
  let released = false
  const assertOwned = async () => {
    if (released || compromised) throw new Error(compromised ?? "Plugin store lock is closed")
    try {
      const current = ownerSchema.parse(parseJsonText(await regularFile(ownerPath), 4096))
      const stat = await lstat(lockPath)
      if (current.token !== token || current.pid !== process.pid || current.hostname !== hostname() || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("Plugin store owner changed")
    } catch (error) { markCompromised(error instanceof Error ? error.message : "Plugin store owner changed"); throw error }
  }
  return {
    assertOwned,
    async release() {
      if (released) return
      try {
        await assertOwned()
        await removeDurably(ownerPath)
        await releaseLock()
      } finally { released = true }
    },
  }
}
