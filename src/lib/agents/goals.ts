/**
 * Long-running goals, in the two shapes the agents keep them: Claude Code
 * records goal state in its transcript (read into the session digest) and
 * takes a `/goal` slash command; Codex exposes goals through its app-server
 * thread API, which Cogpit proxies.
 */

/** The proxied thread-goal endpoint for an agent whose goals live on the CLI. */
export function threadGoalPath(threadId: string): string {
  return `/api/codex/goals/${encodeURIComponent(threadId)}`
}
