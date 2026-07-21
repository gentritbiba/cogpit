import { useLiveEventStream } from "./useLiveEventStream"

/**
 * Subscribe to SSE workflow updates for a session (or a specific run).
 * Mirrors useTeamLive: the server emits {type:"update"} on debounced fs
 * changes; we call onUpdate to refetch and track a live indicator.
 *
 * @param runId  when provided, watch only that run; otherwise watch the whole
 *               session for new/changed workflows.
 */
export function useWorkflowLive(
  dirName: string | null,
  sessionId: string | null,
  runId: string | null,
  onUpdate: () => void,
): { isLive: boolean } {
  let url: string | null = null
  if (dirName && sessionId) {
    url = `/api/workflow-watch/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}`
    if (runId) url += `/${encodeURIComponent(runId)}`
  }
  return useLiveEventStream(url, onUpdate)
}
