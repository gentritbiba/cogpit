import { parseBoardContent, type BoardContent, type SessionBoard } from "../../shared/contracts/board"
import { SESSION_BOARDS_FILE } from "./sessionConfigDir"
import { SessionConfigFile } from "./sessionConfigFile"

/**
 * Boards by the session that keeps them. A board belongs to the agent that
 * sets it, usually a crew's lead; the crew's members show their root's.
 */

let boards = new Map<string, SessionBoard>()

const file = new SessionConfigFile(SESSION_BOARDS_FILE, {
  reset() {
    boards = new Map()
  },
  apply(parsed) {
    const stored = (parsed as { boards?: unknown } | null)?.boards
    if (typeof stored !== "object" || stored === null) return
    for (const [sessionId, entry] of Object.entries(stored)) {
      const content = parseBoardContent(entry)
      const updatedAt = (entry as { updatedAt?: unknown }).updatedAt
      if (content && typeof updatedAt === "number") boards.set(sessionId, { sessionId, ...content, updatedAt })
    }
  },
  snapshot() {
    return { version: 1, boards: Object.fromEntries(boards) }
  },
})

export async function sessionBoard(sessionId: string): Promise<SessionBoard | null> {
  await file.load()
  return boards.get(sessionId) ?? null
}

/** Replace a session's board with `content`. */
export async function setSessionBoard(sessionId: string, content: BoardContent, now = Date.now()): Promise<SessionBoard> {
  await file.load()
  const board: SessionBoard = { sessionId, ...content, updatedAt: now }
  boards.set(sessionId, board)
  await file.persist()
  return board
}

/** Move only the progress, starting a board that has nothing else yet. */
export async function setSessionBoardProgress(
  sessionId: string,
  progress: NonNullable<BoardContent["progress"]>,
  now = Date.now(),
): Promise<SessionBoard> {
  await file.load()
  const current = boards.get(sessionId)
  return setSessionBoard(sessionId, { ...(current ?? { sections: [] }), progress }, now)
}

export async function clearSessionBoard(sessionId: string): Promise<boolean> {
  await file.load()
  if (!boards.delete(sessionId)) return false
  await file.persist()
  return true
}

export function __resetSessionBoardsForTest(): void {
  file.resetForTest()
}
