import { useLiveEventStream } from "./useLiveEventStream"

/**
 * Subscribe to a team's live updates. `onLost` hears that the server refused
 * to reopen the stream: the caller can no longer see the team's lead session,
 * or the team is gone.
 */
export function useTeamLive(
  teamName: string | null,
  onUpdate: () => void,
  onLost?: () => void,
) {
  const url = teamName ? `/api/team-watch/${encodeURIComponent(teamName)}` : null
  return useLiveEventStream(url, onUpdate, { onLost })
}
