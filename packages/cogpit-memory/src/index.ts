/**
 * cogpit-memory library — exports for cogpit integration.
 *
 * Usage from cogpit:
 *   import { SearchIndex } from "../packages/cogpit-memory"
 *   const index = new SearchIndex("~/.claude/cogpit-memory/search-index.db")
 *   index.startWatching(dirs.PROJECTS_DIR)
 */

// Core
export { SearchIndex, type IndexStats, type SearchHit } from "./lib/search-index"
export {
  parseSession,
  parseSessionAppend,
  getUserMessageText,
  getUserMessageImages,
  type ParseSessionOptions,
} from "./lib/parser"
export { DEFAULT_DB_PATH, dirs } from "./lib/dirs"

// Commands
export { searchSessions, type SearchOptions, type SearchResponse } from "./commands/search"
export { getSessionOverview, getTurnDetail, getAgentOverview, getAgentTurnDetail } from "./commands/context"
export { listSessions, currentSession, type SessionSummary, type SessionsOptions } from "./commands/sessions"
export { indexStats, indexRebuild } from "./commands/index-cmd"

// Types
export type { ParsedSession, Turn, ToolCall, SubAgentMessage, SessionStats } from "./lib/types"
