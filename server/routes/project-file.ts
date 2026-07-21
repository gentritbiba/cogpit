import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import type { IncomingMessage } from "node:http"
import { sendJson, type UseFn } from "../http"
import { isWithinDir } from "../helpers"

const MAX_FILE_BYTES = 2 * 1024 * 1024

interface ResolvedProjectFile {
  absolutePath: string
  info: Stats
}

interface ProjectFileWriteBody {
  cwd?: unknown
  path?: unknown
  content?: unknown
  expectedMtimeMs?: unknown
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

async function resolveProjectFile(cwd: string, filePath: string): Promise<ResolvedProjectFile> {
  if (!isAbsolute(cwd)) throw new ProjectFileError(400, "cwd must be an absolute path")
  if (!filePath || isAbsolute(filePath) || filePath.includes("\0")) {
    throw new ProjectFileError(400, "path must be a relative project file")
  }

  let root: string
  try {
    root = await realpath(resolve(cwd))
  } catch {
    throw new ProjectFileError(404, "Project directory not found")
  }

  const candidate = resolve(root, filePath)
  if (!isWithinDir(root, candidate)) throw new ProjectFileError(403, "File is outside the project")

  let absolutePath: string
  try {
    absolutePath = await realpath(candidate)
  } catch {
    throw new ProjectFileError(404, "File not found")
  }
  if (!isWithinDir(root, absolutePath)) throw new ProjectFileError(403, "File is outside the project")

  const info = await stat(absolutePath)
  if (!info.isFile()) throw new ProjectFileError(400, "Path must point to a file")
  if (info.size > MAX_FILE_BYTES) throw new ProjectFileError(413, "File is larger than 2 MB")
  return { absolutePath, info }
}

class ProjectFileError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function respondWithError(res: Parameters<typeof sendJson>[0], error: unknown) {
  if (error instanceof ProjectFileError) {
    return sendJson(res, error.status, { error: error.message })
  }
  return sendJson(res, 500, { error: "Unable to access project file" })
}

function decodeTextFile(buffer: Buffer): string {
  if (buffer.includes(0)) throw new ProjectFileError(415, "Binary files cannot be edited")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    throw new ProjectFileError(415, "File is not valid UTF-8 text")
  }
}

async function writeAtomically(
  absolutePath: string,
  content: string,
  mode: number,
  expectedMtimeMs: number,
) {
  const latest = await stat(absolutePath)
  if (latest.mtimeMs !== expectedMtimeMs) {
    throw new ProjectFileError(409, "File changed on disk. Reload it before saving.")
  }

  const temporaryPath = resolve(dirname(absolutePath), `.${randomUUID()}.cogpit-save`)
  try {
    await writeFile(temporaryPath, content, { encoding: "utf-8", mode })
    const beforeRename = await stat(absolutePath)
    if (beforeRename.mtimeMs !== expectedMtimeMs) {
      throw new ProjectFileError(409, "File changed on disk. Reload it before saving.")
    }
    await rename(temporaryPath, absolutePath)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export function registerProjectFileContentRoutes(use: UseFn) {
  use("/api/project-file", async (req, res, next) => {
    if (req.method === "GET") {
      const url = new URL(req.url || "", "http://localhost")
      const cwd = url.searchParams.get("cwd") ?? ""
      const filePath = url.searchParams.get("path") ?? ""
      try {
        const file = await resolveProjectFile(cwd, filePath)
        const buffer = await readFile(file.absolutePath)
        return sendJson(res, 200, {
          content: decodeTextFile(buffer),
          mtimeMs: file.info.mtimeMs,
          size: file.info.size,
        })
      } catch (error) {
        return respondWithError(res, error)
      }
    }

    if (req.method === "PUT") {
      try {
        const body = await readBody(req) as ProjectFileWriteBody
        if (
          typeof body.cwd !== "string"
          || typeof body.path !== "string"
          || typeof body.content !== "string"
          || typeof body.expectedMtimeMs !== "number"
          || !Number.isFinite(body.expectedMtimeMs)
        ) {
          throw new ProjectFileError(400, "cwd, path, content, and expectedMtimeMs are required")
        }
        if (Buffer.byteLength(body.content, "utf-8") > MAX_FILE_BYTES) {
          throw new ProjectFileError(413, "File is larger than 2 MB")
        }

        const file = await resolveProjectFile(body.cwd, body.path)
        if (file.info.mtimeMs !== body.expectedMtimeMs) {
          throw new ProjectFileError(409, "File changed on disk. Reload it before saving.")
        }
        await writeAtomically(file.absolutePath, body.content, file.info.mode, body.expectedMtimeMs)
        const saved = await stat(file.absolutePath)
        return sendJson(res, 200, { ok: true, mtimeMs: saved.mtimeMs, size: saved.size })
      } catch (error) {
        return respondWithError(res, error)
      }
    }

    return next()
  })
}
