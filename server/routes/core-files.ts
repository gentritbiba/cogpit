import { forwardToCore } from "../core"
import type { UseFn } from "../http"

/**
 * The files and git routes live in the Rust core (`crates/core-files`). Each
 * keeps its route id here, so authentication and edition policies apply
 * before the request is forwarded.
 */
function forward(use: UseFn, mount: string, corePath: string, methods: readonly string[] = ["GET"]) {
  use(mount, (req, res, next) => {
    if (!methods.includes(req.method ?? "")) return next()
    return forwardToCore(req, res, `/v1/files${corePath}`)
  })
}

export function registerLocalFileRoutes(use: UseFn) {
  forward(use, "/api/local-file", "/local-file")
}

export function registerFileContentRoutes(use: UseFn) {
  forward(use, "/api/file-content", "/file-content")
}

export function registerProjectFileRoutes(use: UseFn) {
  forward(use, "/api/project-files/tree", "/project-files/tree")
  forward(use, "/api/project-files", "/project-files")
}

export function registerProjectFileContentRoutes(use: UseFn) {
  forward(use, "/api/project-file", "/project-file", ["GET", "PUT"])
}

export function registerGitStatusRoutes(use: UseFn) {
  forward(use, "/api/git-status", "/git-status")
}

export function registerGitDiffRoutes(use: UseFn) {
  forward(use, "/api/git-diff", "/git-diff")
}
