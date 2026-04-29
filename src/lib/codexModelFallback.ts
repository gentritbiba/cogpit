export function isCodexSelectedModelError(message: string | null | undefined): boolean {
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

export async function readErrorMessage(
  res: Response,
  fallback: string
): Promise<string> {
  const payload = await res.json().catch(() => ({ error: fallback })) as { error?: unknown }
  return typeof payload.error === "string" && payload.error
    ? payload.error
    : fallback
}

interface CodexFallbackOpts {
  /** The user-selected model (empty string or undefined means no override). */
  model: string | undefined
  /** Agent kind derived from the dirName — only "codex" triggers the retry. */
  agentKind: string | null
  /**
   * Fallback used when the response body has no usable error message.
   * Can be a string or a function that receives the Response for status-aware messages.
   */
  errorFallback: string | ((res: Response) => string)
  /** Called when the model is rejected so the UI can clear the selection. */
  onModelRejected?: (model: string) => void
}

interface CodexFallbackResult {
  res: Response
  errorMessage: string | null
}

/**
 * Send a request with the selected model, and if the Codex backend rejects the
 * model, automatically retry once without a model override.
 *
 * `sendRequest` receives an optional model string — pass `undefined` to omit.
 */
export async function fetchWithCodexModelFallback(
  sendRequest: (model: string | undefined) => Promise<Response>,
  { model, agentKind, errorFallback, onModelRejected }: CodexFallbackOpts,
): Promise<CodexFallbackResult> {
  const fallback = (r: Response): string =>
    typeof errorFallback === "function" ? errorFallback(r) : errorFallback

  let res = await sendRequest(model || undefined)
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
