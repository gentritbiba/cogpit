import { randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import { open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { DeviceUnreachableError } from "../hub/device-client"
import { callDevice, DeviceRequestError, deviceJson, openDeviceStream } from "../hub/deviceRequest"
import {
  WORKSPACE_BUNDLE_REF_HEADER,
  WORKSPACE_UPLOAD_CHUNK_BYTES,
  type WorkspaceExportResponse,
  type WorkspaceImportResponse,
  type WorkspaceProbeResponse,
  type WorkspaceUploadCreated,
  type WorkspaceUploadProgress,
} from "../../shared/contracts/workspaces"
import { createBundle, fetchBundle } from "./bundle"
import { isValidBundleRef, sanitizeTaskName } from "./deviceStore"
import { git, GIT_TRANSFER_TIMEOUT_MS } from "./git"
import { COMMIT_SHA_RE, snapshotWorkspace, type WorkspaceSnapshot } from "./snapshot"

/**
 * The hub's half of handing a task to another machine: send a repository —
 * HEAD plus uncommitted work — to a device as a fresh worktree, and later fetch
 * what the session there did back as a local branch. The user's own working
 * tree and index are never touched in either direction.
 */

/** What the hub keeps about a handed-over workspace, to bring it back later. */
export interface Handoff {
  repoRoot: string
  /** The commit that was sent; the device's work is everything after it. */
  base: string
  workspaceId: string
  /** The local branch the device's work comes back to. */
  branch: string
}

export interface SentWorkspace {
  handoff: Handoff
  snapshot: WorkspaceSnapshot
  /** Where the session starts on the device. */
  remoteCwd: string
  remoteBranch: string
}

export interface ReturnedWork {
  branch: string
  /** Whether `branch` now points at the returned work (see `fetchWorkspaceBack`). */
  branchUpdated: boolean
  /** Always points at the returned work. */
  ref: string
  base: string
  tip: string
  files: Array<{ path: string; additions: number; deletions: number }>
}

/** Hub-side refs of a handoff, named like its branch: `cogpit/<device>/<task>`. */
function handoffRefs(handoff: Handoff) {
  const key = handoff.branch.replace(/^cogpit\//, "")
  return {
    /** Keeps the sent snapshot from being garbage-collected. */
    base: `refs/cogpit/handoffs/${key}`,
    /** The latest work fetched back. */
    returned: `refs/cogpit/returns/${key}`,
    branch: `refs/heads/${handoff.branch}`,
  }
}

const UPLOAD_ATTEMPTS = 3

function tempBundlePath(): string {
  return join(tmpdir(), `cogpit-return-${randomBytes(8).toString("hex")}.bundle`)
}

/** Upload a file in chunks the device's body limit accepts, resuming after a dropped chunk. */
async function upload(deviceId: string, path: string): Promise<string> {
  const { uploadId } = await deviceJson<WorkspaceUploadCreated>(deviceId, "POST", "/api/workspaces/uploads")
  const file = await open(path)
  try {
    const { size } = await file.stat()
    const chunk = Buffer.alloc(WORKSPACE_UPLOAD_CHUNK_BYTES)
    let offset = 0
    let failures = 0
    while (offset < size) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset)
      try {
        const response = await callDevice(deviceId, {
          method: "PUT",
          path: `/api/workspaces/uploads/${uploadId}?offset=${offset}`,
          body: chunk.subarray(0, bytesRead),
          contentType: "application/octet-stream",
          timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
        })
        offset = (JSON.parse(response.body.toString("utf8")) as WorkspaceUploadProgress).size
        failures = 0
      } catch (error) {
        const stored = error instanceof DeviceRequestError && error.status === 409
          ? (error.body as Partial<WorkspaceUploadProgress> | undefined)?.size
          : undefined
        if (typeof stored === "number") offset = stored
        else if (!(error instanceof DeviceUnreachableError) || ++failures >= UPLOAD_ATTEMPTS) throw error
      }
    }
    return uploadId
  } finally {
    await file.close()
  }
}

/** A short lowercase branch-safe name from a device name or a task's first words. */
function slug(label: string, maxLength = 40): string {
  return sanitizeTaskName(label.toLowerCase().slice(0, maxLength))
}

/** Send `cwd`'s repository to a device as a new worktree named after `task`. */
export async function sendWorkspace(
  deviceId: string,
  deviceName: string,
  cwd: string,
  task: string,
  /** Stable across retries, so the device imports the workspace once. */
  requestId: string,
): Promise<SentWorkspace> {
  const snapshot = await snapshotWorkspace(cwd)
  const { commits } = await deviceJson<WorkspaceProbeResponse>(deviceId, "POST", "/api/workspaces/probe", {
    repoKey: snapshot.repoKey,
  })
  const bundle = await createBundle(snapshot.repoRoot, snapshot.snapshot, commits)
  let imported: WorkspaceImportResponse
  try {
    const uploadId = bundle ? await upload(deviceId, bundle.path) : undefined
    imported = await deviceJson<WorkspaceImportResponse>(deviceId, "POST", "/api/workspaces/import", {
      repoKey: snapshot.repoKey,
      ...(bundle ? { uploadId, bundleRef: bundle.ref } : {}),
      snapshot: snapshot.snapshot,
      task: slug(task),
      subdir: snapshot.subdir,
      requestId,
    }, { timeoutMs: GIT_TRANSFER_TIMEOUT_MS })
  } finally {
    if (bundle) await rm(bundle.path, { force: true })
  }

  const remoteTask = imported.workspaceId.split("/").pop()!
  const handoff: Handoff = {
    repoRoot: snapshot.repoRoot,
    base: snapshot.snapshot,
    workspaceId: imported.workspaceId,
    branch: `cogpit/${slug(deviceName)}/${remoteTask}`,
  }
  await git(snapshot.repoRoot, ["update-ref", handoffRefs(handoff).base, snapshot.snapshot])
  return {
    handoff,
    snapshot,
    remoteCwd: imported.cwd,
    remoteBranch: imported.branch,
  }
}

async function changedFiles(repoRoot: string, base: string, tip: string): Promise<ReturnedWork["files"]> {
  const numstat = await git(repoRoot, ["diff", "--numstat", "-z", "--no-renames", base, tip])
  const files: ReturnedWork["files"] = []
  for (const entry of numstat.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry)
    if (!match) continue
    files.push({
      path: match[3],
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    })
  }
  return files
}

async function resolveRef(repoRoot: string, ref: string): Promise<string | null> {
  return (await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "")).trim() || null
}

async function checkedOut(repoRoot: string, branchRef: string): Promise<boolean> {
  const worktrees = await git(repoRoot, ["worktree", "list", "--porcelain"])
  return worktrees.split("\n").includes(`branch ${branchRef}`)
}

/**
 * Point the handoff branch at the returned work when that loses nothing: the
 * branch is new, or it only fast-forwards and is not checked out anywhere
 * (moving a checked-out branch would leave that working tree behind it).
 */
async function advanceBranch(repoRoot: string, branchRef: string, tip: string): Promise<boolean> {
  const current = await resolveRef(repoRoot, branchRef)
  if (current === tip) return true
  if (current) {
    const fastForward = await git(repoRoot, ["merge-base", "--is-ancestor", current, tip]).then(() => true, () => false)
    if (!fastForward || await checkedOut(repoRoot, branchRef)) return false
  }
  // The expected old value makes this a no-op if the branch moved meanwhile.
  return git(repoRoot, ["update-ref", branchRef, tip, current ?? ""]).then(() => true, () => false)
}

/**
 * Fetch the device's worktree — commits and uncommitted work alike — into a
 * private ref, then move the handoff branch there if that is safe. Unchanged
 * work since the last return transfers nothing.
 */
export async function fetchWorkspaceBack(deviceId: string, handoff: Handoff): Promise<ReturnedWork> {
  const refs = handoffRefs(handoff)
  const previous = await resolveRef(handoff.repoRoot, refs.returned)
  const exported = await deviceJson<WorkspaceExportResponse>(deviceId, "POST", "/api/workspaces/export", {
    workspaceId: handoff.workspaceId,
    exclude: previous ? [handoff.base, previous] : [handoff.base],
  }, { timeoutMs: GIT_TRANSFER_TIMEOUT_MS })
  if (!COMMIT_SHA_RE.test(exported.tip)) throw new Error("The device returned an invalid commit")

  if (exported.downloadId) {
    const response = await openDeviceStream(deviceId, `/api/workspaces/downloads/${encodeURIComponent(exported.downloadId)}`, {
      timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
    })
    const ref = response.headers[WORKSPACE_BUNDLE_REF_HEADER.toLowerCase()]
    if (typeof ref !== "string" || !isValidBundleRef(ref)) {
      response.destroy()
      throw new Error("The device returned a bundle without a valid ref")
    }
    const path = tempBundlePath()
    try {
      await pipeline(response, createWriteStream(path))
      await fetchBundle(handoff.repoRoot, path, ref, refs.returned)
    } finally {
      await rm(path, { force: true })
    }
  } else if (exported.tip !== previous) {
    // Nothing to send means this repository already has the commit.
    await git(handoff.repoRoot, ["update-ref", refs.returned, exported.tip])
  }

  const tip = await resolveRef(handoff.repoRoot, refs.returned)
  if (!tip) throw new Error("The returned work did not arrive")
  return {
    branch: handoff.branch,
    branchUpdated: await advanceBranch(handoff.repoRoot, refs.branch, tip),
    ref: refs.returned,
    base: handoff.base,
    tip,
    files: await changedFiles(handoff.repoRoot, handoff.base, tip),
  }
}

/**
 * Delete the device's worktree and this repository's private refs; the branch
 * stays. The returned ref stays too when the branch could not take the work,
 * because it is then the only thing keeping that work reachable.
 */
export async function discardWorkspace(deviceId: string, handoff: Handoff): Promise<void> {
  const refs = handoffRefs(handoff)
  const returned = await resolveRef(handoff.repoRoot, refs.returned)
  const onBranch = !returned || await git(
    handoff.repoRoot,
    ["merge-base", "--is-ancestor", returned, refs.branch],
  ).then(() => true, () => false)
  await deviceJson(deviceId, "POST", "/api/workspaces/remove", { workspaceId: handoff.workspaceId })
  for (const ref of onBranch ? [refs.base, refs.returned] : [refs.base]) {
    await git(handoff.repoRoot, ["update-ref", "-d", ref]).catch(() => undefined)
  }
}

/** The first lines of the handed-over session's prompt: where it is and what comes back. */
export function handoffBriefing(sent: SentWorkspace, from: string): string {
  const { snapshot } = sent
  const source = `${snapshot.branch ?? "a detached HEAD"} at ${snapshot.head.slice(0, 12)}`
  return [
    `[Cogpit] This task was handed over from ${from}. You are in a git worktree of ${snapshot.repoName} on branch ${sent.remoteBranch}, created from ${source}${
      snapshot.dirty ? `, with the user's uncommitted changes committed on top as ${snapshot.snapshot.slice(0, 12)}` : ""
    }.`,
    "Files git ignores (typically .env files, dependencies and build output) were not copied; install or recreate what you need.",
    `When you finish, everything in this worktree, committed or not, is sent back to ${from}. Leave it in the state you want returned.`,
  ].join(" ")
}
