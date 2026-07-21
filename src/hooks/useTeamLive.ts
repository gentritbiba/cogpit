import { useLiveEventStream } from "./useLiveEventStream"

export function useTeamLive(
  teamName: string | null,
  onUpdate: () => void
) {
  const url = teamName ? `/api/team-watch/${encodeURIComponent(teamName)}` : null
  return useLiveEventStream(url, onUpdate)
}
