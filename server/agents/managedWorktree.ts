import { runManagedCommand } from "../lib/managedCommand"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { validateInitializedDirectory } from "../worktreeSetup/project"
import { AgentRuntimeError, type StartSessionRequest } from "./runtimeTypes"
import { descriptorFor } from "../../shared/session/agent-descriptors"

/** Used only by transports that cannot initialize a native worktree without submitting a prompt. */
export async function prepareManagedWorktree(request: StartSessionRequest): Promise<StartSessionRequest> {
  if (!request.worktreeName || !request.beforeFirstTurn) return request
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(request.worktreeName) || request.worktreeName === "." || request.worktreeName === "..") throw new AgentRuntimeError(400, "INVALID_REQUEST", "Invalid worktree name")
  request.signal?.throwIfAborted()
  const suffix = randomUUID().slice(0, 8)
  const name = `${request.worktreeName.slice(0, 28)}-${suffix}`
  const parent = join(request.cwd, ".worktrees")
  await mkdir(parent, { recursive: true })
  const cwd = join(parent, name)
  let output = ""
  const code = await runManagedCommand({ cwd: request.cwd, file: "git", args: ["worktree", "add", "-b", `worktree-${name}`, cwd, "HEAD"], signal: request.signal ?? new AbortController().signal, timeoutMs: 120_000, output: (text) => { output = (output + text).slice(-8000) } })
  if (code !== 0) throw new AgentRuntimeError(500, "SPAWN_FAILED", output.trim() || "Could not initialize the managed worktree")
  await validateInitializedDirectory(request.cwd, cwd)
  return { ...request, worktreeName: undefined, cwd, dirName: descriptorFor("codex").dirName.encode(cwd) }
}
