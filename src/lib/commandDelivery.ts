import { authFetch, jsonFetch } from "./auth"

/** Retries an interrupted HTTP exchange with the same durable command id. */
export async function deliverCommand(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const commandId = typeof body.commandId === "string" ? body.commandId : crypto.randomUUID()
  const content = { ...body, commandId }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await (signal ? authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(content), signal }) : jsonFetch(url, content))
      if (response.ok) window.dispatchEvent(new CustomEvent("cogpit-command-accepted", { detail: { commandId, sessionId: body.sessionId } }))
      return response
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      if (signal?.aborted || attempt >= 1) throw new Error(`Delivery could not be confirmed. Your draft is retained. Check receipt ${commandId} before sending again.`, { cause: error })
    }
  }
}
