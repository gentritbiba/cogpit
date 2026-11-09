import { filterVisible } from "../edition"
import { sendJson, type UseFn } from "../http"
import { crewRootOf } from "../lib/crew"
import { allSessionBoards } from "../lib/sessionBoards"
import { sessionParents } from "../lib/sessionOrigins"
import type { ListedBoard } from "../../shared/contracts/board"
import { requestScope } from "./requestScope"

export function registerSessionBoardRoutes(use: UseFn): void {
  // GET /api/session-boards — every board the caller may see, the most
  // recently updated first, each placed in its keeper's crew
  use("/api/session-boards", async (req, res, next) => {
    const path = (req.url ?? "").split("?")[0]
    if (req.method !== "GET" || (path !== "" && path !== "/")) return next()
    const [boards, parents] = await Promise.all([allSessionBoards(), sessionParents()])
    const visible = await filterVisible(req, boards, ({ sessionId }) => ({ sessionId }), requestScope(req))
    sendJson(res, 200, {
      boards: visible.map((board): ListedBoard => {
        const link = parents.get(board.sessionId)
        return {
          ...board,
          rootId: crewRootOf(board.sessionId, parents),
          ...(link && { parentSessionId: link.parentSessionId }),
          ...(link?.name && { name: link.name }),
        }
      }),
    })
  })
}
