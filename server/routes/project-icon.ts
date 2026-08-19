import { createReadStream } from "node:fs"
import { isAbsolute } from "node:path"
import { iconContentType, resolveProjectIcon } from "../lib/projectIcon"
import { sendJson, type UseFn } from "../http"

/**
 * Serves the icon a project already ships, so the sidebar can identify projects
 * without asking the user to pick anything.
 *
 * Deliberately does not go through the git project resolver: that shells out to
 * `git` to locate a repository root, and an icon lookup should not cost a
 * subprocess. The resolver canonicalises the root itself and refuses anything
 * outside it.
 */
export function registerProjectIconRoutes(use: UseFn) {
  use("/api/project-icon", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "", "http://localhost")
    const cwd = url.searchParams.get("cwd") ?? ""
    if (!isAbsolute(cwd)) {
      return sendJson(res, 400, { error: "cwd must be an absolute path" })
    }

    const icon = await resolveProjectIcon(cwd)
    const contentType = icon ? iconContentType(icon) : null
    if (!icon || !contentType) {
      return sendJson(res, 404, { error: "Project has no icon" })
    }

    res.statusCode = 200
    res.setHeader("Content-Type", contentType)
    // Short enough that swapping a project's favicon shows up without a
    // restart, long enough that scrolling a project list costs nothing.
    res.setHeader("Cache-Control", "private, max-age=300")

    const stream = createReadStream(icon)
    stream.once("error", (error) => {
      if (!res.headersSent) sendJson(res, 404, { error: "Project has no icon" })
      else res.destroy(error)
    })
    stream.pipe(res)
  })
}
