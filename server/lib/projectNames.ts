/**
 * Human-readable names for a project directory.
 *
 * The dirName encoding is lossy, so everything here is best-effort display
 * text: a caller that can read a session's recorded `cwd` should prefer that.
 */
import { basename } from "node:path"
import { homedir } from "node:os"
import { descriptorFor, descriptorForDirName } from "../../shared/session/agent-descriptors"

const HOME_PREFIX = descriptorFor("claude").dirName.encode(homedir()).replace(/^-/, "").toLowerCase()

/** Last path segment of a cwd, tolerating trailing separators of either flavour. */
export function shortNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  return basename(trimmed) || trimmed || path
}

export function projectDirToReadableName(dirName: string): { path: string; shortName: string } {
  const raw = dirName.replace(/^-/, "")
  const lowerRaw = raw.toLowerCase()

  let shortPart = raw
  const homePrefix = HOME_PREFIX + "-"
  if (lowerRaw.startsWith(homePrefix)) {
    const afterHome = raw.slice(homePrefix.length)
    const lowerAfter = afterHome.toLowerCase()
    const subdirs = ["desktop-", "documents-", "code-", "projects-", "repos-", "dev-"]
    let stripped = false
    for (const sub of subdirs) {
      if (lowerAfter.startsWith(sub)) {
        shortPart = afterHome.slice(sub.length)
        stripped = true
        break
      }
    }
    if (!stripped) {
      shortPart = afterHome
    }
  }

  const shortName = shortPart || raw

  return {
    path: descriptorForDirName(dirName).dirName.decode(dirName) ?? dirName,
    shortName,
  }
}
