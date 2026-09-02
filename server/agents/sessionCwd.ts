import { getSessionMeta, homedir } from "../helpers"

/**
 * The working directory a resumed session should run in.
 *
 * All three CLIs scope a resume to a project: Claude derives the project
 * directory from cwd, Codex puts it in the thread settings, Copilot needs a
 * `workingDirectory`. A client that omits it is not saying "anywhere" — it is
 * relying on the session already knowing, so the answer is read back out of the
 * transcript. Home is the last resort, and it is a wrong one; it exists only so
 * a resume attempt happens at all.
 */
export async function resolveSessionCwd(
  requested: string | undefined,
  filePath: string | null | undefined,
): Promise<string> {
  if (requested) return requested
  const meta = filePath ? await getSessionMeta(filePath).catch(() => null) : null
  return meta?.cwd || homedir()
}
