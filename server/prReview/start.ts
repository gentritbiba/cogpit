import type { IncomingMessage } from "node:http"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { AGENT_KINDS } from "../../shared/session/agent-descriptors"
import { runtimeFor } from "../agents/runtimes"
import { startTurn } from "../edition"
import { commandScope } from "../lib/durableSend"
import { ErrorCodes, RouteError } from "../lib/routeError"
import { runGit } from "../lib/gitProject"
import { createSession } from "../lib/sessionCreate"
import { assertWorktreeStartAccess } from "../sessionStartup/authorization"
import { defaultDependencies, parsePullPins, repositoryName, resolveRepository, type GitHubDependencies } from "../plugins/integrations/github"
import { guidePrompt, reviewGuides } from "./guides"

/**
 * Starts a session on a pull request's pinned head in a new worktree (item
 * 9): "Work on PR" or the generation of a review guide. The user picked the
 * provider in the host's dialog; the prompt is the host's, never a plugin's.
 */

export const reviewSessionSchema = z.strictObject({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  purpose: z.enum(["work", "guide"]),
  agent: z.enum(AGENT_KINDS as unknown as [string, ...string[]]),
  instanceId: z.string().min(1).max(128).default("default"),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(32).optional(),
  instruction: z.string().max(8000).optional(),
})
export type ReviewSessionRequest = z.infer<typeof reviewSessionSchema>

/** Checks out the pinned head in a fresh worktree, refusing one with changes or a head that moved since. */
export function prepareReviewWorktree(pins: { number: number; headSha: string; baseSha: string; baseBranch: string }, git: (cwd: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string }> = runGit) {
  return async (cwd: string, signal: AbortSignal) => {
    if ((await git(cwd, ["status", "--porcelain"], signal)).stdout.trim()) throw new Error("The new worktree has changes; it was left as it is")
    await git(cwd, ["fetch", "--no-tags", "origin", `+refs/pull/${pins.number}/head:refs/cogpit/pull/${pins.number}`], signal)
    if ((await git(cwd, ["rev-parse", `refs/cogpit/pull/${pins.number}`], signal)).stdout.trim() !== pins.headSha) throw new Error("The pull request changed since it was opened; reload it and start again")
    const hasBase = () => git(cwd, ["cat-file", "-e", `${pins.baseSha}^{commit}`], signal).then(() => true, () => false)
    if (!await hasBase() && pins.baseBranch) await git(cwd, ["fetch", "--no-tags", "origin", pins.baseBranch], signal)
    if (!await hasBase()) throw new Error("The pull request's base commit is not available from origin")
    await git(cwd, ["checkout", "--detach", pins.headSha], signal)
  }
}

function workPrompt(pull: { owner: string; name: string; number: number; headSha: string; baseSha: string }, instruction: string | undefined): string {
  return [
    `This worktree is checked out at the head ${pull.headSha} of pull request #${pull.number} of ${pull.owner}/${pull.name}; its base is ${pull.baseSha}.`,
    `See the change with \`git diff ${pull.baseSha}...${pull.headSha}\`. Do not push or post anything to GitHub unless asked to.`,
    "",
    instruction?.trim() || "Read the change and wait for instructions.",
  ].join("\n")
}

export async function startReviewSession(
  req: IncomingMessage,
  context: { workspacePath: string; principal: string; signal: AbortSignal; authorize: () => Promise<void> },
  input: ReviewSessionRequest,
  dependencies: GitHubDependencies = defaultDependencies,
) {
  const { repository, projectPath } = await resolveRepository(context.workspacePath, dependencies, context.authorize)
  await context.authorize()
  const pins = parsePullPins(await dependencies.githubApi(repository, `repos/${repositoryName(repository)}/pulls/${input.number}`, context.signal), input.number)
  if (pins.headSha !== input.headSha) throw new RouteError(409, ErrorCodes.CONFLICT, "The pull request changed since it was opened; reload it and start again")
  if (pins.state !== "open" && pins.state !== "draft") throw new RouteError(409, ErrorCodes.CONFLICT, "The pull request is no longer open")
  const agent = input.agent as (typeof AGENT_KINDS)[number]
  if (!runtimeFor(agent, input.instanceId).descriptor.capabilities.worktrees) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "This provider cannot start sessions in a new worktree")
  const pull = { ...repository, number: input.number, headSha: pins.headSha, baseSha: pins.baseSha }
  const start = (signal: AbortSignal) => createSession({
    cwd: projectPath,
    agent,
    instanceId: input.instanceId,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    name: input.purpose === "guide" ? `Review guide · PR #${input.number}` : `PR #${input.number} · ${pins.title.slice(0, 80)}`,
    message: input.purpose === "guide" ? guidePrompt({ ...pull, title: pins.title }) : workPrompt(pull, input.instruction),
    worktreeName: `pr-${input.number}-${pins.headSha.slice(0, 8)}-${randomBytes(3).toString("hex")}`,
    setupScope: commandScope(req),
    authorizeStartup: async () => { await context.authorize(); assertWorktreeStartAccess(req) },
    prepareWorktree: prepareReviewWorktree({ ...pins }),
    signal: AbortSignal.any([signal, context.signal]),
  }, (runtime, request) => startTurn(req, Date.now(), runtime, request))
  if (input.purpose === "work") return start(new AbortController().signal)
  return reviewGuides.generate({ principal: context.principal, ...repository, number: input.number }, pins, start) as ReturnType<typeof start>
}
