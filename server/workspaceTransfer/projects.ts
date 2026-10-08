import { realpath, readdir } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { allStores } from "../agents"
import { ErrorCodes, RouteError } from "../lib/routeError"
import type { RepositoryIdentity } from "../../shared/contracts/workspaces"
import { git } from "./git"
import { COMMIT_SHA_RE, portableRemoteIdentity } from "./snapshot"

export function parseIdentity(value: unknown): RepositoryIdentity | undefined {
  if (value === undefined) return undefined
  const identity = value as Partial<RepositoryIdentity> | null
  if (!identity || !Array.isArray(identity.roots) || !identity.roots.length || identity.roots.length > 100
    || !identity.roots.every((sha) => typeof sha === "string" && COMMIT_SHA_RE.test(sha))
    || (identity.origin !== undefined && (typeof identity.origin !== "string" || identity.origin.length > 2048
      || /[\s@?#\\]/.test(identity.origin)))) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid repository identity")
  }
  return { ...(identity.origin ? { origin: identity.origin } : {}), roots: [...new Set(identity.roots)].sort() }
}

export function matchIdentity(caller: RepositoryIdentity, candidate: RepositoryIdentity): "origin" | "roots" | null {
  // Two different origins may be forks of the same root, with different services.
  if (caller.origin && candidate.origin) return caller.origin === candidate.origin ? "origin" : null
  return caller.roots.length === candidate.roots.length && caller.roots.every((sha) => candidate.roots.includes(sha)) ? "roots" : null
}

async function identityAt(path: string): Promise<{ path: string; commonDir: string; identity: RepositoryIdentity } | null> {
  try {
    const root = await realpath((await git(path, ["rev-parse", "--show-toplevel"])).trim())
    const originUrl = await git(root, ["remote", "get-url", "origin"]).then((url) => url.trim(), () => "")
    const origin = portableRemoteIdentity(originUrl)
    const roots = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n").sort()
    const commonDir = await realpath(resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim()))
    return { path: root, commonDir, identity: { ...(origin ? { origin } : {}), roots } }
  } catch { return null }
}

/** Known projects and retained transfer worktrees; no crawl of the user's home. */
export async function checkoutCandidates(workspacesRoot: string): Promise<string[]> {
  const paths: string[] = []
  for (const store of allStores()) {
    for (const project of await store.listProjects()) paths.push(project.path)
  }
  for (const repo of await readdir(workspacesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!repo.isDirectory()) continue
    const root = join(workspacesRoot, repo.name)
    for (const task of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (task.isDirectory() && task.name !== "repo.git") paths.push(join(root, task.name))
    }
  }
  return [...new Set(paths)]
}

export interface CheckoutMatch {
  checkout?: string
  match: "origin" | "roots" | "none" | "ambiguous"
}

export async function findCheckout(identity: RepositoryIdentity, candidates: string[], explicit?: string): Promise<CheckoutMatch> {
  if (explicit && !isAbsolute(explicit)) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "targetCheckout must be absolute")
  const matches = new Map<string, { checkout: string; match: "origin" | "roots" }>()
  for (const path of explicit ? [explicit] : candidates) {
    const candidate = await identityAt(path)
    const match = candidate && matchIdentity(identity, candidate.identity)
    if (candidate && match) {
      const current = matches.get(candidate.commonDir)
      // Several worktrees of one clone are one project. Prefer its main checkout.
      if (!current || candidate.commonDir === join(candidate.path, ".git")) matches.set(candidate.commonDir, { checkout: candidate.path, match })
    }
  }
  if (explicit && !matches.size) throw new RouteError(409, ErrorCodes.CONFLICT, "Target checkout does not match the caller's repository")
  const origins = [...matches.values()].filter(({ match }) => match === "origin")
  const preferred = origins.length ? origins : [...matches.values()]
  if (preferred.length === 1) {
    return preferred[0]
  }
  return { match: matches.size ? "ambiguous" : "none" }
}
