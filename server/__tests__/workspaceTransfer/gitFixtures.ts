import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

const TEST_IDENTITY = ["-c", "user.name=Cogpit Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"]

export async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await execFile("git", [...TEST_IDENTITY, ...args], { cwd })).stdout.trim()
}

export async function tempDir(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(path)
  return path
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await gitOut(repo, ["add", "-A"])
  await gitOut(repo, ["commit", "-q", "-m", message])
  return gitOut(repo, ["rev-parse", "HEAD"])
}

/** A repository at `<temp>/<name>` with one commit of `files`. */
export async function makeRepo(files: Record<string, string>, name = "project"): Promise<string> {
  const repo = join(await tempDir("cogpit-transfer-"), name)
  await mkdir(repo)
  await gitOut(repo, ["init", "-q", "-b", "main"])
  await writeFiles(repo, files)
  await commitAll(repo, "initial")
  return repo
}

/** Everything that would reveal a change to the user's index or working tree. */
export async function repoState(repo: string) {
  return {
    status: await gitOut(repo, ["status", "--porcelain=v2", "--untracked-files=all"]),
    staged: await gitOut(repo, ["diff", "--cached"]),
    unstaged: await gitOut(repo, ["diff"]),
    head: await gitOut(repo, ["rev-parse", "HEAD"]),
  }
}
