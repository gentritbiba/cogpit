function isCodexSelectedModelError(message: string | null | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    lower.includes("issue with the selected model") ||
    (
      lower.includes("selected model") &&
      lower.includes("may not exist or you may not have access")
    ) ||
    lower.includes("run --model to pick a different model")
  )
}

async function readErrorMessage(
  res: Response,
  fallback: string
): Promise<string> {
  const payload = await res.json().catch(() => ({ error: fallback })) as { error?: unknown }
  return typeof payload.error === "string" && payload.error
    ? payload.error
    : fallback
}

interface ModelFallbackOpts {
  /** The user-selected model (empty string or undefined means no override). */
  model: string | undefined
  /** Agent kind derived from the dirName. */
  agentKind: string | null
  /**
   * Fallback used when the response body has no usable error message.
   * Can be a string or a function that receives the Response for status-aware messages.
   */
  errorFallback: string | ((res: Response) => string)
  /** Called when the model is rejected so the UI can clear the selection. */
  onModelRejected?: (model: string) => void
}

interface ModelFallbackResult {
  res: Response
  errorMessage: string | null
}

/**
 * Send a request with the selected model, and if the agent rejects the model,
 * automatically retry once without a model override. Only Codex reports a
 * rejected model in a recognisable way, so only it is retried.
 *
 * `sendRequest` receives an optional model string — pass `undefined` to omit.
 */
export async function fetchWithModelFallback(
  sendRequest: (model: string | undefined) => Promise<Response>,
  { model, agentKind, errorFallback, onModelRejected }: ModelFallbackOpts,
): Promise<ModelFallbackResult> {
  const fallback = (r: Response): string =>
    typeof errorFallback === "function" ? errorFallback(r) : errorFallback

  // Copilot's catalog represents Default as an empty selection that resolves
  // to its synthetic `auto` model. Send that resolution explicitly so an
  // existing session can switch back from a concrete model.
  const requestedModel = agentKind === "copilot" ? model || "auto" : model || undefined
  let res = await sendRequest(requestedModel)
  let errorMessage = res.ok
    ? null
    : await readErrorMessage(res, fallback(res))

  if (
    !res.ok &&
    agentKind === "codex" &&
    model &&
    isCodexSelectedModelError(errorMessage)
  ) {
    onModelRejected?.(model)
    res = await sendRequest(undefined)
    errorMessage = res.ok
      ? null
      : await readErrorMessage(res, fallback(res))
  }

  return { res, errorMessage }
}
