import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, GitCommandError, GIT_TRANSFER_TIMEOUT_MS } from "./git"

/** A bundle file on disk and the one ref it carries; fetch that ref out of it. */
export interface TransferBundle {
  path: string
  /** `refs/cogpit/transfer/<random>`, pointing at the bundled tip. */
  ref: string
}

/** The subset of `candidates` that name commits present in the repository. */
async function localCommits(repoRoot: string, candidates: readonly string[]): Promise<string[]> {
  const unique = [...new Set(candidates)]
  if (unique.length === 0) return []
  const output = await git(repoRoot, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: `${unique.join("\n")}\n`,
  })
  return output
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type]) => type === "commit")
    .map(([sha]) => sha)
}

/**
 * Write a bundle of `tip` minus everything reachable from the `exclude`
 * commits the receiver already has. Returns null when that leaves nothing to
 * send. The caller owns the returned file.
 */
export async function createBundle(
  repoRoot: string,
  tip: string,
  exclude: readonly string[],
): Promise<TransferBundle | null> {
  const token = randomBytes(8).toString("hex")
  const ref = `refs/cogpit/transfer/${token}`
  const path = join(tmpdir(), `cogpit-transfer-${token}.bundle`)
  const prerequisites = await localCommits(repoRoot, exclude)

  await git(repoRoot, ["update-ref", ref, tip])
  try {
    await git(repoRoot, ["bundle", "create", path, ref, "--stdin"], {
      input: prerequisites.map((sha) => `^${sha}\n`).join(""),
      timeout: GIT_TRANSFER_TIMEOUT_MS,
    })
    return { path, ref }
  } catch (error) {
    await rm(path, { force: true })
    if (error instanceof GitCommandError && /empty bundle/i.test(error.stderr)) return null
    throw error
  } finally {
    await git(repoRoot, ["update-ref", "-d", ref]).catch(() => undefined)
  }
}

/** Fetch `ref` out of a bundle into `intoRef`, overwriting it. Works in bare repositories. */
export async function fetchBundle(repoDir: string, bundlePath: string, ref: string, intoRef: string): Promise<void> {
  await git(
    repoDir,
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundlePath, `+${ref}:${intoRef}`],
    { timeout: GIT_TRANSFER_TIMEOUT_MS },
  )
}
