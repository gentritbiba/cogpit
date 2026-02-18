import {
  spawn,
  stat,
  lstat,
  join,
} from "../helpers"
import type { UseFn } from "../helpers"

export function registerFileRoutes(use: UseFn) {
  // POST /api/check-files-exist - check which files have been deleted + get line counts via git
  use("/api/check-files-exist", (req, res, next) => {
    if (req.method !== "POST") return next()
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", async () => {
      try {
        const { files, dirs } = JSON.parse(body) as { files?: string[]; dirs?: string[] }
        const fileList = Array.isArray(files) ? files : []
        const dirList = Array.isArray(dirs) ? dirs : []
        if (fileList.length === 0 && dirList.length === 0) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ deleted: [] }))
          return
        }
        const deleted: { path: string; lines: number }[] = []
        // Cache git root lookups per directory
        const gitRootCache = new Map<string, string | null>()

        async function findGitRoot(dir: string): Promise<string | null> {
          if (gitRootCache.has(dir)) return gitRootCache.get(dir)!
          // Walk up to find an existing directory (handles deleted dirs)
          let cwd = dir
          while (cwd && cwd !== "/") {
            try {
              const s = await stat(cwd)
              if (s.isDirectory()) break
            } catch {
              cwd = cwd.substring(0, cwd.lastIndexOf("/")) || "/"
            }
          }
          return new Promise((resolve) => {
            const proc = spawn("git", ["rev-parse", "--show-toplevel"], { cwd })
            let out = ""
            proc.stdout!.on("data", (d: Buffer) => (out += d.toString()))
            proc.on("close", (code) => {
              const root = code === 0 ? out.trim() : null
              gitRootCache.set(dir, root)
              resolve(root)
            })
            proc.on("error", () => {
              gitRootCache.set(dir, null)
              resolve(null)
            })
          })
        }

        function spawnLines(args: string[], cwd: string): Promise<number> {
          return new Promise((resolve) => {
            const proc = spawn("git", args, { cwd })
            let out = ""
            proc.stdout!.on("data", (d: Buffer) => (out += d.toString()))
            proc.on("close", (code) => {
              if (code !== 0 || !out) return resolve(0)
              resolve(out.split("\n").length)
            })
            proc.on("error", () => resolve(0))
          })
        }

        function spawnOutput(args: string[], cwd: string): Promise<string> {
          return new Promise((resolve) => {
            const proc = spawn("git", args, { cwd })
            let out = ""
            proc.stdout!.on("data", (d: Buffer) => (out += d.toString()))
            proc.on("close", () => resolve(out.trim()))
            proc.on("error", () => resolve(""))
          })
        }

        async function getGitLineCount(filePath: string): Promise<number> {
          const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/"
          const gitRoot = await findGitRoot(dir)
          if (!gitRoot) return 0
          const relPath = filePath.startsWith(gitRoot + "/")
            ? filePath.slice(gitRoot.length + 1)
            : filePath

          // 1. Try HEAD (file still in current commit)
          const headLines = await spawnLines(["show", `HEAD:${relPath}`], gitRoot)
          if (headLines > 0) return headLines

          // 2. Find the commit that deleted the file, show from its parent
          const deleteCommit = await spawnOutput(
            ["log", "--diff-filter=D", "-1", "--format=%H", "--", relPath],
            gitRoot
          )
          if (deleteCommit) {
            const lines = await spawnLines(["show", `${deleteCommit}^:${relPath}`], gitRoot)
            if (lines > 0) return lines
          }

          // 3. Find any commit that last touched the file
          const lastCommit = await spawnOutput(
            ["log", "--all", "-1", "--format=%H", "--", relPath],
            gitRoot
          )
          if (lastCommit) {
            return await spawnLines(["show", `${lastCommit}:${relPath}`], gitRoot)
          }

          return 0
        }

        // Check individual files
        for (const f of fileList) {
          if (typeof f !== "string" || f.length === 0) continue
          try {
            await stat(f)
          } catch {
            const lines = await getGitLineCount(f)
            deleted.push({ path: f, lines })
          }
        }

        // Expand rm -rf directories: list files that were in the dir via git
        const seenPaths = new Set(deleted.map((d) => d.path))
        for (const d of dirList) {
          if (typeof d !== "string" || d.length === 0) continue
          // Skip dirs that still exist (not actually deleted)
          try {
            const s = await lstat(d)
            if (s.isDirectory()) continue
          } catch {
            // dir doesn't exist -- expand via git
          }
          const parentDir = d.substring(0, d.lastIndexOf("/")) || "/"
          const gitRoot = await findGitRoot(parentDir)
          if (!gitRoot) continue
          const relDir = d.startsWith(gitRoot + "/")
            ? d.slice(gitRoot.length + 1)
            : d
          // List files that were in this directory across all commits
          const filesInDir = await spawnOutput(
            ["log", "--all", "--pretty=format:", "--name-only", "--diff-filter=ACMR", "--", `${relDir}/`],
            gitRoot
          )
          if (!filesInDir) continue
          const uniqueFiles = [...new Set(filesInDir.split("\n").map((l) => l.trim()).filter(Boolean))]
          for (const relFile of uniqueFiles) {
            const absFile = join(gitRoot, relFile)
            if (seenPaths.has(absFile)) continue
            // Verify it's actually deleted
            try {
              await stat(absFile)
              continue // still exists
            } catch {
              // deleted
            }
            seenPaths.add(absFile)
            const lines = await getGitLineCount(absFile)
            deleted.push({ path: absFile, lines })
          }
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ deleted }))
      } catch {
        res.statusCode = 400
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
