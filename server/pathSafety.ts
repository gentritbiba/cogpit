import { resolve, sep } from "node:path"

/**
 * Windows filesystems are case-insensitive, so `C:\Users\x` and `c:\users\x`
 * name the same directory. POSIX filesystems are not, and folding case there
 * would let `/HOME/user` escape a `/home/user` containment check.
 */
function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path
}

/** Return whether a resolved path is the parent itself or one of its descendants. */
export function isWithinDir(parent: string, child: string): boolean {
  const resolved = comparablePath(resolve(child))
  const resolvedParent = comparablePath(resolve(parent))
  return resolved.startsWith(resolvedParent + sep) || resolved === resolvedParent
}
