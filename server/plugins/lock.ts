import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, unlinkSync } from "node:fs"
import { hostname } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import lockfile from "proper-lockfile"
import onExit from "signal-exit"
import { z } from "zod"
import { documentBytes, durableWrite, exists, regularFile, removeDurably } from "./durable"
import { parseJsonText } from "./json"

const ownerProcess = { pid: z.number().int().positive(), token: z.string().uuid(), startedAt: z.number().int().nonnegative() }
const ownerSchema = z.discriminatedUnion("formatVersion", [
  z.strictObject({ formatVersion: z.literal(1), hostname: z.string(), ...ownerProcess }),
  z.strictObject({ formatVersion: z.literal(2), machine: z.string().min(1), boot: z.string().min(1).optional(), ...ownerProcess }),
])
const newerOwnerSchema = z.object({ formatVersion: z.number().int().gt(2) })
type OwnerRecord = z.infer<typeof ownerSchema>
export interface PluginStoreLock { assertOwned(): Promise<void>; release(): Promise<void> }

interface HostIdentity { machine: string; boot?: string }
const run = promisify(execFile)
let hostIdentityPromise: Promise<HostIdentity> | undefined
/** macOS renames its hostname with the network (Mac.lan, <name>.local), so ownership follows the OS install id. */
function hostIdentity(): Promise<HostIdentity> {
  hostIdentityPromise ??= Promise.all([readMachineId().catch(() => undefined), readBootId().catch(() => undefined)]).then(([machine, boot]) => ({
    machine: createHash("sha256").update(machine ?? `hostname:${hostname()}`).digest("hex"),
    ...(boot ? { boot } : {}),
  }))
  return hostIdentityPromise
}
async function readMachineId(): Promise<string | undefined> {
  if (process.platform === "darwin") return /"IOPlatformUUID" = "([^"]+)"/.exec((await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000 })).stdout)?.[1]
  if (process.platform === "win32") {
    const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
    return /MachineGuid\s+REG_SZ\s+(\S+)/.exec((await run(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { timeout: 5000 })).stdout)?.[1]
  }
  return firstNonEmpty(["/etc/machine-id", "/var/lib/dbus/machine-id"])
}
async function readBootId(): Promise<string | undefined> {
  if (process.platform === "darwin") return (await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 5000 })).stdout.trim() || undefined
  if (process.platform === "linux") return firstNonEmpty(["/proc/sys/kernel/random/boot_id"])
  return undefined
}
async function firstNonEmpty(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const value = (await readFile(path, "utf8").catch(() => "")).trim()
    if (value) return value
  }
  return undefined
}

const heldTokens = new Set<string>()
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}
/** A dead owner's pid can belong to another process after a reboot, or to this one after a container restart. */
function ownerRunning(owner: OwnerRecord, host: HostIdentity): boolean {
  if (owner.pid === process.pid) return heldTokens.has(owner.token)
  if (owner.formatVersion === 2 && owner.boot && host.boot && owner.boot !== host.boot) return false
  return alive(owner.pid)
}
async function readOwner(ownerPath: string): Promise<OwnerRecord> {
  let value: unknown
  try { value = parseJsonText(await regularFile(ownerPath), 4096) } catch { value = undefined }
  const owner = ownerSchema.safeParse(value)
  if (owner.success) return owner.data
  if (newerOwnerSchema.safeParse(value).success) throw new Error("Plugin store ownership uses a newer format")
  throw new Error("Plugin store lock has missing or malformed ownership; recovery requires operator inspection")
}

export async function acquirePluginStoreLock(root: string, onCompromised: (reason: string) => void): Promise<PluginStoreLock> {
  const lockPath = join(root, ".store.lock")
  const ownerPath = join(root, "owner.json")
  const host = await hostIdentity()
  for (let attempt = 0; attempt < 2; attempt++) {
    const lockExists = await exists(lockPath)
    const ownerExists = await exists(ownerPath)
    if (!lockExists && !ownerExists) break
    const owner = await readOwner(ownerPath)
    const sameMachine = owner.formatVersion === 2 ? owner.machine === host.machine : owner.hostname === hostname()
    if (sameMachine && ownerRunning(owner, host)) throw new Error(`Plugin store already has a live owner process ${owner.pid}`)
    if (!lockExists) break
    if (!sameMachine) throw new Error("Plugin store belongs to another host; network filesystems are unsupported")
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
  const owner = { formatVersion: 2, machine: host.machine, ...(host.boot ? { boot: host.boot } : {}), pid: process.pid, token, startedAt: Date.now() }
  try {
    await durableWrite(ownerPath, documentBytes(owner), { label: "owner", guard: async () => { if (compromised) throw new Error(compromised) } })
  } catch (error) { await releaseLock(); throw error }
  heldTokens.add(token)
  // Electron's quit terminates the server without closing its stores; proper-lockfile drops the lock directory on exit, and this drops the record.
  const removeExitHook = onExit(() => {
    if (compromised) return
    try { if (JSON.parse(readFileSync(ownerPath, "utf8")).token === token) unlinkSync(ownerPath) } catch { /* the next owner recovers the record */ }
  })
  let released = false
  const assertOwned = async () => {
    if (released || compromised) throw new Error(compromised ?? "Plugin store lock is closed")
    try {
      const current = ownerSchema.parse(parseJsonText(await regularFile(ownerPath), 4096))
      const stat = await lstat(lockPath)
      if (current.token !== token || current.pid !== process.pid || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("Plugin store owner changed")
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
      } finally {
        released = true
        heldTokens.delete(token)
        removeExitHook()
      }
    },
  }
}
