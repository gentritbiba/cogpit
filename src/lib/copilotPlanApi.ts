import { authFetch } from "@/lib/auth"

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
    const result = await authFetch(
      `/api/permissions/${encodeURIComponent(sessionId)}/plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, ...response }),
      },
    )
    return result.ok
  } catch {
    return false
  }
}
