import { getSessionMeta, homedir } from "../helpers"
import { sessionFolderProblem } from "../lib/folders"
import { AgentRuntimeError } from "./runtimeTypes"

/**
 * The working directory a resumed session should run in.
 *
 * All three CLIs scope a resume to a project: Claude derives the project
 * directory from cwd, Codex puts it in the thread settings, Copilot needs a
 * `workingDirectory`. A client that omits it is not saying "anywhere" — it is
 * relying on the session already knowing, so the answer is read back out of the
 * transcript. Home is the last resort, and it is a wrong one; it exists only so
 * a resume attempt happens at all. A folder deleted since the session last ran
 * is refused here, before a CLI fails to spawn in it with an error about itself.
 */
export async function resolveSessionCwd(
  requested: string | undefined,
  filePath: string | null | undefined,
): Promise<string> {
  const meta = requested || !filePath ? null : await getSessionMeta(filePath).catch(() => null)
  const cwd = requested || meta?.cwd || homedir()
  const missing = await sessionFolderProblem(cwd)
  if (missing) throw new AgentRuntimeError(400, "INVALID_REQUEST", missing)
  return cwd
}
