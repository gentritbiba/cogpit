import type { IncomingMessage, ServerResponse } from "node:http"
import type { SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import { descriptorForDirName } from "../../shared/session/agent-descriptors"
import { resolveTranscriptSession, type TranscriptSession } from "../agents/transcriptSession"
import type { SessionAddress, SubagentFileInfo } from "../agents/types"
import { resolveSessionFilePath } from "../sessionPaths"
import { editionModule } from "./registry"
import type { AuthorizedSession, VisibilityCheck } from "./types"

/** What `authorizeTranscript` allowed: the session checked and the transcript to act on. */
export interface AuthorizedTranscript extends AuthorizedSession {
  /**
   * The file the access check resolved, else the owning store's resolution of
   * the address; null when the store serves no transcript there.
   */
  filePath: string | null
  /**
   * The checked session's id, as the address spells it, when the transcript
   * allowed is that session's own. Null for one filed under the session — a
   * sub-agent's or a workflow's — whatever its name spells, and for a file the
   * store does not serve.
   */
  transcriptSessionId: string | null
}

/** Reads nothing: the check already placed the file. */
function ownTranscriptSessionId(address: SessionAddress, session: AuthorizedSession, filePath: string | null): string | null {
  if (filePath === null || !session.isRootTranscript) return null
  const spelled = descriptorForDirName(address.dirName).sessionFile.sessionId(address.fileName)
  return spelled?.toLowerCase() === session.sessionId.toLowerCase() ? spelled : null
}

/**
 * `authorizeSession` for a transcript address, with the transcript it allows.
 * A handler acts on that file and session only, never on what the address
 * spells. Null after a refusal, which the check has answered.
 */
export async function authorizeTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  address: SessionAddress,
  needed: SessionAccessLevel,
): Promise<AuthorizedTranscript | null> {
  const session = await editionModule().access.authorizeSession(req, res, address, needed)
  if (session === null) return null
  const filePath = session.filePath ?? await resolveSessionFilePath(address.dirName, address.fileName)
  return { ...session, filePath, transcriptSessionId: ownTranscriptSessionId(address, session, filePath) }
}

/** Keeps the child transcripts, of those a store listed under a session, that the caller may see. */
export type ChildTranscriptFilter = <T extends SubagentFileInfo>(children: readonly T[]) => Promise<T[]>

/** Keeps every child transcript: for a reader that answers for no one caller. */
export const everyChildTranscript: ChildTranscriptFilter = async (children) => [...children]

/**
 * The transcript at `address`, when `check` shows the session it really
 * belongs to; null when that is hidden or the store serves no transcript there.
 */
export async function visibleTranscript(check: VisibilityCheck, address: SessionAddress): Promise<TranscriptSession | null> {
  const transcript = await resolveTranscriptSession(address.dirName, address.fileName)
  return transcript !== null && await check(transcript.sessionId, transcript.hint) !== "hidden" ? transcript : null
}

/**
 * A child filed under its session goes with that session. One a store keeps
 * apart (it has a `fileName`) may be a session of its own, written by an agent
 * whose sub-agents run as sessions, and is checked as the session its file
 * really is: that session's own record, not its parent's, decides. Personal
 * edition keeps every child without reading anything.
 */
export function visibleChildTranscripts(req: IncomingMessage, dirName: string): ChildTranscriptFilter {
  const check = editionModule().access.visibilityFor(req)
  if (check.everything) return everyChildTranscript
  const visible = async ({ fileName }: SubagentFileInfo): Promise<boolean> =>
    fileName === undefined || await visibleTranscript(check, { dirName, fileName }) !== null
  return async (children) => {
    const shown = await Promise.all(children.map(visible))
    return children.filter((_, index) => shown[index])
  }
}
