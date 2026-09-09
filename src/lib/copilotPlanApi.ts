import { jsonFetch } from "@/lib/auth"

export async function submitCopilotPlanResponse(
  sessionId: string,
  requestId: string,
  response: {
    approved: boolean
    selectedAction?: string
    feedback?: string
  },
): Promise<boolean> {
  try {
    const result = await jsonFetch(
      `/api/permissions/${encodeURIComponent(sessionId)}/plan`,
      { requestId, ...response },
    )
    return result.ok
  } catch {
    return false
  }
}
