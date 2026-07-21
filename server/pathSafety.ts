import { resolve, sep } from "node:path"

/** Return whether a resolved path is the parent itself or one of its descendants. */
export function isWithinDir(parent: string, child: string): boolean {
  const resolved = resolve(child)
  const resolvedParent = resolve(parent)
  return resolved.startsWith(resolvedParent + sep) || resolved === resolvedParent
}
