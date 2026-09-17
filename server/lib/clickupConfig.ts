import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { durableWrite, exists, regularFile } from "../plugins/durable"
import { parseJsonText } from "../plugins/json"
import { PluginDataError, type DataGuard } from "../plugins/privateStore"

const tokenSchema = z.string().regex(/^pk_[A-Za-z0-9_]{8,4093}$/)
export const CLICKUP_CONFIG_FILE = join(homedir(), ".cogpit", "clickup.json")
const storedSchema = z.strictObject({ token: tokenSchema.optional(), projects: z.record(z.string().max(4096).refine(isAbsolute), z.string().regex(/^\d{1,128}$/)).optional() }).refine(value => Object.keys(value.projects ?? {}).length <= 1024)
export interface LegacyClickUpConfig { bytes: Buffer; hash: string; token?: string; projects: Record<string, string> }
export function isClickUpToken(value: unknown): value is string { return tokenSchema.safeParse(value).success }
export async function readLegacyClickUpConfig(path: string): Promise<LegacyClickUpConfig | null> {
  if (!isAbsolute(path)) throw new PluginDataError("INVALID_REQUEST", "Legacy configuration requires an explicit absolute path")
  try {
    if (!await exists(path)) return null
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Invalid legacy file")
    const bytes = await readFile(path)
    const config = storedSchema.parse(parseJsonText(bytes, 1024 * 1024))
    return { bytes, hash: createHash("sha256").update(bytes).digest("hex"), token: config.token, projects: config.projects ?? {} }
  } catch { throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Legacy ClickUp configuration requires inspection; the original file was preserved") }
}
export async function backupLegacyClickUpConfig(path: string, config: LegacyClickUpConfig, preparedAt: number, guard: DataGuard): Promise<string> {
  const name = `${basename(path)}.pre-runtime-${new Date(preparedAt).toISOString().replace(/[:.]/g, "-")}-${config.hash.slice(0, 16)}.backup`
  const destination = join(dirname(path), name)
  await guard()
  try {
    if (await exists(destination)) {
      if (createHash("sha256").update(await regularFile(destination)).digest("hex") !== config.hash || process.platform !== "win32" && (await lstat(destination)).mode & 0o077) throw new Error("Invalid backup")
    } else await durableWrite(destination, config.bytes, { label: "legacy-clickup-backup", guard: async () => { await guard() } })
    await guard()
    return name
  } catch (error) {
    if (error instanceof PluginDataError) throw error
    throw new PluginDataError("CAPABILITY_UNAVAILABLE", "The owner-only legacy ClickUp backup could not be verified")
  }
}
