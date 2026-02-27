import type { UseFn } from "../helpers"
import { getConfig } from "../config"
import { execFile } from "node:child_process"
import { stat, writeFile, unlink } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join, basename, dirname } from "node:path"
import { randomBytes } from "node:crypto"

/** Terminals that need --working-directory instead of a positional dir arg */
const WD_FLAG_TERMINALS = new Set(["ghostty", "alacritty", "wezterm", "wezterm-gui", "rio"])

/**
 * Build the right command + args to open a terminal at a directory.
 * Some terminals (Terminal.app, iTerm, Warp) accept a positional dir arg via `open -a`,
 * while modern cross-platform terminals (Ghostty, Alacritty, etc.) need --working-directory.
 */
export function terminalCommand(terminal: string, dirPath: string): { cmd: string; args: string[] } {
  const os = platform()
  const name = basename(terminal).toLowerCase()

  // Binary path (contains /)
  if (terminal.includes("/")) {
    if (name === "kitty") {
      return { cmd: terminal, args: ["--single-instance", "-d", dirPath] }
    }
    return { cmd: terminal, args: ["--working-directory", dirPath] }
  }

  // macOS app name via `open -a`
  if (os === "darwin") {
    if (WD_FLAG_TERMINALS.has(name)) {
      return { cmd: "open", args: ["-a", terminal, "--args", "--working-directory", dirPath] }
    }
    if (name === "kitty") {
      return { cmd: "open", args: ["-a", terminal, "--args", "--single-instance", "-d", dirPath] }
    }
    // Terminal.app, iTerm, Warp: positional arg works fine
    return { cmd: "open", args: ["-a", terminal, dirPath] }
  }

  // Linux / Windows: direct execution
  if (name === "kitty") {
    return { cmd: terminal, args: ["--single-instance", "-d", dirPath] }
  }
  return { cmd: terminal, args: ["--working-directory", dirPath] }
}

const EDITORS = ["cursor", "code", "zed", "windsurf"] as const

function findEditor(): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = platform() === "win32" ? "where" : "which"
    const results: (string | null)[] = new Array(EDITORS.length).fill(null)
    let remaining = EDITORS.length

    for (let i = 0; i < EDITORS.length; i++) {
      const idx = i
      execFile(cmd, [EDITORS[idx]], (err) => {
        if (!err) results[idx] = EDITORS[idx]
        remaining--
        if (remaining === 0) resolve(results.find((r) => r !== null) ?? null)
      })
    }
  })
}

function openWithEditor(editor: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(editor, args, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** Get the git-tracked version of a file at HEAD (throws if not tracked or no commits) */
function getGitHeadContent(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", dirname(filePath), "show", `HEAD:./${basename(filePath)}`],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })
}

export function registerEditorRoutes(use: UseFn) {
  // POST /api/reveal-in-folder — reveal a path in the OS file manager (Finder / Explorer / etc.)
  // Body: { path: string }
  use("/api/reveal-in-folder", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", async () => {
      res.setHeader("Content-Type", "application/json")

      try {
        const { path } = JSON.parse(body)
        if (!path || typeof path !== "string") {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "path string required" }))
          return
        }

        try {
          await stat(path)
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Path does not exist" }))
          return
        }

        const os = platform()
        try {
          if (os === "darwin") {
            await openWithEditor("open", ["-R", path])
          } else if (os === "win32") {
            await openWithEditor("explorer", [`/select,${path}`])
          } else {
            // Linux: open the parent directory (no universal "select" flag)
            await openWithEditor("xdg-open", [dirname(path)])
          }
          res.end(JSON.stringify({ success: true }))
        } catch {
          res.statusCode = 500
          res.end(JSON.stringify({ error: "Failed to reveal path in file manager" }))
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  // POST /api/open-terminal — open the user's default terminal at a directory
  // Body: { path: string }
  use("/api/open-terminal", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", async () => {
      res.setHeader("Content-Type", "application/json")

      try {
        const { path } = JSON.parse(body)
        if (!path || typeof path !== "string") {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "path string required" }))
          return
        }

        try {
          await stat(path)
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Path does not exist" }))
          return
        }

        const os = platform()
        try {
          const configuredTerminal = getConfig()?.terminalApp
          if (configuredTerminal) {
            const { cmd, args } = terminalCommand(configuredTerminal, path)
            await openWithEditor(cmd, args)
          } else if (os === "darwin") {
            const tp = process.env.TERM_PROGRAM?.toLowerCase()
            const termApp = tp === "ghostty" ? "Ghostty"
              : tp === "iterm.app" ? "iTerm"
              : tp === "warpterminal" ? "Warp"
              : tp === "alacritty" ? "Alacritty"
              : tp === "kitty" ? "kitty"
              : "Terminal"
            const { cmd, args } = terminalCommand(termApp, path)
            await openWithEditor(cmd, args)
          } else if (os === "win32") {
            await openWithEditor("cmd.exe", ["/c", "start", "cmd", "/K", `cd /d "${path}"`])
          } else {
            await openWithEditor("x-terminal-emulator", ["--working-directory", path])
          }
          res.end(JSON.stringify({ success: true }))
        } catch {
          res.statusCode = 500
          res.end(JSON.stringify({ error: "Failed to open terminal" }))
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  // POST /api/open-in-editor — open a file or project in the user's default code editor
  // Body: { path: string, mode?: "file" | "diff" }
  //   mode "file" (default): open the file/folder directly
  //   mode "diff": open a side-by-side diff of HEAD vs working copy in the editor
  use("/api/open-in-editor", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", async () => {
      res.setHeader("Content-Type", "application/json")

      try {
        const { path, mode = "file" } = JSON.parse(body)
        if (!path || typeof path !== "string") {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "path string required" }))
          return
        }

        // Validate the path exists
        try {
          await stat(path)
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Path does not exist" }))
          return
        }

        const editor = await findEditor()

        if (mode === "diff") {
          // diff mode: only supported for editors with --diff flag (cursor, code)
          const diffEditor = editor === "cursor" || editor === "code" ? editor : null
          if (!diffEditor) {
            res.statusCode = 422
            res.end(JSON.stringify({ error: "Diff view requires Cursor or VS Code" }))
            return
          }

          let originalContent: string
          try {
            originalContent = await getGitHeadContent(path)
          } catch {
            res.statusCode = 422
            res.end(JSON.stringify({ error: "File is not tracked by git or has no commits" }))
            return
          }

          const tmpFile = join(tmpdir(), `cogpit-diff-${randomBytes(4).toString("hex")}-${basename(path)}`)
          await writeFile(tmpFile, originalContent, "utf8")

          try {
            await openWithEditor(diffEditor, ["--diff", tmpFile, path])
            res.end(JSON.stringify({ success: true, editor: diffEditor, mode: "diff" }))
          } catch {
            res.statusCode = 500
            res.end(JSON.stringify({ error: `Failed to open diff in ${diffEditor}` }))
          } finally {
            // Clean up temp file after a short delay (editor needs time to read it)
            setTimeout(() => unlink(tmpFile).catch(() => {}), 10_000)
          }
          return
        }

        // mode === "file": open file/folder
        if (editor) {
          try {
            await openWithEditor(editor, [path])
            res.end(JSON.stringify({ success: true, editor }))
          } catch {
            res.statusCode = 500
            res.end(JSON.stringify({ error: `Failed to open ${editor}` }))
          }
        } else {
          // Fallback: OS default
          const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open"
          try {
            await openWithEditor(cmd, [path])
            res.end(JSON.stringify({ success: true, editor: cmd }))
          } catch {
            res.statusCode = 500
            res.end(JSON.stringify({ error: "No editor found and OS open failed" }))
          }
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
