import { constants } from "node:fs"
import { appendFile, lstat, mkdir, open, readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { ErrorCodes, RouteError } from "../lib/routeError"
import { isWithinDir } from "../pathSafety"
import { git } from "./git"

const DEFAULT_PATTERNS = ["**/.env*", "**/.dev.vars", "**/.dev.vars.*"]
const GENERATED_DIRS = ["node_modules", ".next", ".venv", "vendor", ".cache"]
export const MAX_ENVIRONMENT_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 100
const MAGIC = Buffer.from("COGPITENV1\0")

export function environmentError(): RouteError {
  return new RouteError(400, ErrorCodes.INVALID_REQUEST, "Could not provision workspace environment; check the file selection, ignored status, regular files and size limits")
}

export function validEnvironmentPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && /^[A-Za-z0-9_./-]+$/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
}

export function parseEnvPatterns(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 32 || !value.every((pattern) => typeof pattern === "string"
    && pattern.length > 0 && pattern.length <= 256 && /^[A-Za-z0-9_./*?-]+$/.test(pattern)
    && pattern.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git"))) throw environmentError()
  return [...new Set(value)]
}

/** Selection changes the allowlist, never whether caller secrets may be sent. */
export async function envPatterns(repoRoot: string, override?: string[]): Promise<string[]> {
  if (override) return parseEnvPatterns(override)!
  try {
    const config = JSON.parse(await readFile(join(repoRoot, ".cogpit", "workspace.json"), "utf8")) as { envFiles?: unknown }
    return parseEnvPatterns(config.envFiles) ?? DEFAULT_PATTERNS
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_PATTERNS
    throw environmentError()
  }
}

interface EnvironmentFile { path: string; bytes: Buffer }

export async function selectEnvironment(repoRoot: string, override?: string[]): Promise<EnvironmentFile[]> {
  try {
    const patterns = await envPatterns(repoRoot, override)
    if (!patterns.length) return []
    const output = await git(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...patterns.map((pattern) => `:(glob)${pattern}`), ...GENERATED_DIRS.map((dir) => `:(exclude,glob)**/${dir}/**`)])
    const paths = [...new Set(output.split("\0").filter(Boolean))].sort()
    if (paths.length > MAX_FILES) throw environmentError()
    const root = await realpath(repoRoot)
    const files: EnvironmentFile[] = []
    let total = 0
    for (const path of paths) {
      if (!validEnvironmentPath(path)) throw environmentError()
      const source = join(root, path)
      const info = await lstat(source)
      if (!info.isFile() || info.size > MAX_FILE_BYTES || !isWithinDir(root, await realpath(source))) throw environmentError()
      const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = await file.readFile()
        total += bytes.length
        if (bytes.length > MAX_FILE_BYTES || total > MAX_ENVIRONMENT_BYTES) throw environmentError()
        files.push({ path, bytes })
      } finally { await file.close() }
    }
    return files
  } catch { throw environmentError() }
}

/** Binary framing keeps secret bytes out of JSON requests and responses. */
export function encodeEnvironment(files: EnvironmentFile[]): Buffer {
  const chunks = [MAGIC]
  for (const file of files) {
    const name = Buffer.from(file.path)
    const header = Buffer.alloc(8)
    header.writeUInt32BE(name.length, 0)
    header.writeUInt32BE(file.bytes.length, 4)
    chunks.push(header, name, file.bytes)
  }
  const encoded = Buffer.concat(chunks)
  if (encoded.length > MAX_ENVIRONMENT_BYTES) throw environmentError()
  return encoded
}

export function decodeEnvironment(bytes: Buffer): EnvironmentFile[] {
  if (bytes.length > MAX_ENVIRONMENT_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw environmentError()
  const files: EnvironmentFile[] = []
  const paths = new Set<string>()
  let offset = MAGIC.length
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || files.length >= MAX_FILES) throw environmentError()
    const nameSize = bytes.readUInt32BE(offset)
    const size = bytes.readUInt32BE(offset + 4)
    offset += 8
    if (!nameSize || nameSize > 1024 || size > MAX_FILE_BYTES || offset + nameSize + size > bytes.length) throw environmentError()
    const path = bytes.subarray(offset, offset + nameSize).toString("utf8")
    if (!validEnvironmentPath(path) || paths.has(path)) throw environmentError()
    paths.add(path)
    offset += nameSize
    files.push({ path, bytes: bytes.subarray(offset, offset + size) })
    offset += size
  }
  return files
}

export async function installEnvironment(worktree: string, files: EnvironmentFile[]): Promise<string[]> {
  try {
    const paths = files.map((file) => file.path)
    if (!paths.length) return []
    const root = await realpath(worktree)
    // Never overwrite anything in the caller's snapshot, including symlinks.
    const tracked = await git(root, ["ls-files", "-z", "--", ...paths.map((path) => `:(literal)${path}`)])
    if (tracked) throw environmentError()
    for (const file of files) {
      if (!validEnvironmentPath(file.path)) throw environmentError()
      const destination = join(root, file.path)
      let parent = root
      for (const segment of file.path.split("/").slice(0, -1)) {
        parent = join(parent, segment)
        const existing = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        })
        if (existing && !existing.isDirectory()) throw environmentError()
        if (!existing) await mkdir(parent, { mode: 0o700 })
      }
      if (!isWithinDir(root, await realpath(dirname(destination)))) throw environmentError()
      const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await output.writeFile(file.bytes) } finally { await output.close() }
    }
    // Git excludes are outside every worktree and cannot be returned as code.
    const exclude = resolve(root, (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim())
    await mkdir(dirname(exclude), { recursive: true })
    await appendFile(exclude, `\n${paths.map((path) => `/${path}`).join("\n")}\n`, { mode: 0o600 })
    const ignored = await git(root, ["check-ignore", "--stdin", "-z"], { input: `${paths.join("\0")}\0` })
    if (new Set(ignored.split("\0").filter(Boolean)).size !== paths.length) throw environmentError()
    return paths
  } catch { throw environmentError() }
}
