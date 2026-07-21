import { basename, dirname, isAbsolute } from "node:path"
import {
  homedir,
  isWithinDir,
  join,
  readFile,
  resolve,
  unlink,
  writeFile,
} from "../../helpers"
import { lstat, realpath } from "node:fs/promises"

const FORBIDDEN_PREFIXES = [
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/boot/",
  "/proc/",
  "/sys/",
  "/dev/",
  "/var/",
]

export interface UndoFileOperation {
  type: "reverse-edit" | "delete-write" | "apply-edit" | "create-write"
  filePath: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  content?: string
}

interface OriginalFile {
  content: string
  existed: boolean
}

export interface PreparedFileOperations {
  readonly operationCount: number
  readonly originals: ReadonlyMap<string, OriginalFile>
  readonly writes: ReadonlyMap<string, string>
  readonly deletes: ReadonlySet<string>
  readonly touchedPaths: ReadonlySet<string>
}

export class UndoOperationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function hasTraversalSegment(filePath: string): boolean {
  return filePath.split(/[\\/]+/).includes("..")
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && (
    (error as NodeJS.ErrnoException).code === "ENOENT"
    || error.message.includes("ENOENT")
  )
}

function isForbiddenPath(filePath: string): boolean {
  return FORBIDDEN_PREFIXES.some((prefix) => isWithinDir(prefix, filePath))
}

async function resolveSafeOperationPath(
  filePath: string,
  home: string,
  canonicalHome: string,
): Promise<string | null> {
  if (typeof filePath !== "string" || !isAbsolute(filePath) || hasTraversalSegment(filePath)) {
    return null
  }

  const resolved = resolve(filePath)
  if (!isWithinDir(home, resolved) || isForbiddenPath(resolved)) return null

  try {
    const stats = await lstat(resolved)
    if (stats.isSymbolicLink()) return null

    const canonicalTarget = await realpath(resolved)
    return isWithinDir(canonicalHome, canonicalTarget) && !isForbiddenPath(canonicalTarget)
      ? canonicalTarget
      : null
  } catch (error) {
    if (!isMissingPathError(error)) return null
    try {
      const canonicalParent = await realpath(dirname(resolved))
      const canonicalTarget = join(canonicalParent, basename(resolved))
      return isWithinDir(canonicalHome, canonicalTarget) && !isForbiddenPath(canonicalTarget)
        ? canonicalTarget
        : null
    } catch {
      return null
    }
  }
}

function assertOperation(value: unknown): asserts value is UndoFileOperation {
  if (!value || typeof value !== "object") {
    throw new UndoOperationError(400, "Invalid file operation")
  }
  const operation = value as Partial<UndoFileOperation>
  if (typeof operation.filePath !== "string") {
    throw new UndoOperationError(400, "File operation path is required")
  }
  if (operation.type === "reverse-edit" || operation.type === "apply-edit") {
    if (!operation.oldString || typeof operation.newString !== "string") {
      throw new UndoOperationError(400, "Edit operations require non-empty oldString and string newString")
    }
    return
  }
  if (operation.type === "create-write") {
    if (typeof operation.content !== "string") {
      throw new UndoOperationError(400, "create-write operations require string content")
    }
    return
  }
  if (operation.type !== "delete-write") {
    throw new UndoOperationError(400, "Unsupported file operation type")
  }
}

async function readOriginal(filePath: string): Promise<OriginalFile> {
  try {
    return { content: await readFile(filePath, "utf-8"), existed: true }
  } catch (error) {
    if (isMissingPathError(error)) return { content: "", existed: false }
    throw error
  }
}

export async function prepareFileOperations(
  operationValues: unknown,
  options: { allowEmpty?: boolean } = {},
): Promise<PreparedFileOperations> {
  if (!Array.isArray(operationValues) || (!options.allowEmpty && operationValues.length === 0)) {
    throw new UndoOperationError(400, "operations array required")
  }
  for (const operation of operationValues) assertOperation(operation)

  const home = resolve(homedir())
  let canonicalHome: string
  try {
    canonicalHome = await realpath(home)
  } catch {
    throw new UndoOperationError(403, "File operations restricted to home directory")
  }

  const operations: UndoFileOperation[] = []
  for (const operation of operationValues) {
    const safePath = await resolveSafeOperationPath(operation.filePath, home, canonicalHome)
    if (!safePath) {
      throw new UndoOperationError(403, `Invalid file path: ${operation.filePath}`)
    }
    operations.push({ ...operation, filePath: safePath })
  }

  const originals = new Map<string, OriginalFile>()
  const writes = new Map<string, string>()
  const deletes = new Set<string>()

  for (const operation of operations) {
    if (!originals.has(operation.filePath)) {
      originals.set(operation.filePath, await readOriginal(operation.filePath))
    }

    if (operation.type === "reverse-edit" || operation.type === "apply-edit") {
      if (deletes.has(operation.filePath)) {
        throw new UndoOperationError(409, `Conflict: ${operation.filePath} was deleted earlier in the batch`)
      }
      const original = originals.get(operation.filePath)
      if (!original?.existed) {
        throw new UndoOperationError(409, `Conflict: file not found: ${operation.filePath}`)
      }
      let content = writes.get(operation.filePath) ?? original.content
      const oldString = operation.oldString!
      if (operation.replaceAll) {
        if (!content.includes(oldString)) {
          throw new UndoOperationError(409, `Conflict: expected string not found in ${operation.filePath}`)
        }
        content = content.split(oldString).join(operation.newString!)
      } else {
        const occurrences = content.split(oldString).length - 1
        if (occurrences !== 1) {
          throw new UndoOperationError(
            409,
            occurrences === 0
              ? `Conflict: expected string not found in ${operation.filePath}`
              : `Conflict: expected exactly 1 occurrence in ${operation.filePath}, found ${occurrences}`,
          )
        }
        content = content.replace(oldString, operation.newString!)
      }
      writes.set(operation.filePath, content)
      deletes.delete(operation.filePath)
      continue
    }

    if (operation.type === "delete-write") {
      const original = originals.get(operation.filePath)!
      const current = writes.get(operation.filePath) ?? original.content
      if (operation.content !== undefined && original.existed && current !== operation.content) {
        throw new UndoOperationError(409, `Conflict: written file changed externally: ${operation.filePath}`)
      }
      writes.delete(operation.filePath)
      deletes.add(operation.filePath)
      continue
    }

    writes.set(operation.filePath, operation.content!)
    deletes.delete(operation.filePath)
  }

  return {
    operationCount: operations.length,
    originals,
    writes,
    deletes,
    touchedPaths: new Set(originals.keys()),
  }
}

export async function commitFileOperations(batch: PreparedFileOperations): Promise<void> {
  for (const filePath of batch.deletes) {
    if (batch.originals.get(filePath)?.existed) await unlink(filePath)
  }
  for (const [filePath, content] of batch.writes) {
    await writeFile(filePath, content, "utf-8")
  }
}

export async function rollbackFileOperations(
  batch: PreparedFileOperations,
): Promise<string[]> {
  const errors: string[] = []
  for (const [filePath, original] of batch.originals) {
    try {
      if (original.existed) await writeFile(filePath, original.content, "utf-8")
      else await unlink(filePath).catch((error: unknown) => {
        if (!isMissingPathError(error)) throw error
      })
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}
