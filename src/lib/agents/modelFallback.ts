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

interface ResponseError {
  message: string
  code: string | null
}

async function readError(
  res: Response,
  fallback: string
): Promise<ResponseError> {
  const payload = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown }
  return {
    message: typeof payload.error === "string" && payload.error ? payload.error : fallback,
    code: typeof payload.code === "string" ? payload.code : null,
  }
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
  signal?: AbortSignal
  onDeliveryError?: (message: string) => void
  onReceiptSettled?: () => void
}

interface ModelFallbackResult {
  res: Response
  errorMessage: string | null
  /** The server's machine-readable `code` for a failed response, when it sent one. */
  errorCode: string | null
  observingReceipt: boolean
  /** The durable command the server accepted, when it queued one. */
  receipt: CommandReceipt | null
}

async function readReceipt(res: Response): Promise<CommandReceipt | null> {
  if (res.status !== 202) return null
  const accepted = await res.clone().json().catch(() => null) as { receipt?: CommandReceipt } | null
  return accepted?.receipt ?? null
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
  options: ModelFallbackOpts,
): Promise<ModelFallbackResult> {
  const { model, agentKind, errorFallback, onModelRejected } = options
  const fallback = (r: Response): string =>
    typeof errorFallback === "function" ? errorFallback(r) : errorFallback

  // Copilot's catalog represents Default as an empty selection that resolves
  // to its synthetic `auto` model. Send that resolution explicitly so an
  // existing session can switch back from a concrete model.
  const requestedModel = agentKind === "copilot" ? model || "auto" : model || undefined
  let res = await sendRequest(requestedModel)
  let error = res.ok ? null : await readError(res, fallback(res))
  let observingReceipt = false

  let receipt = await readReceipt(res)
  if (receipt && agentKind === "codex" && model) { observingReceipt = true; observeModelRejection(receipt, sendRequest, options) }

  if (
    !res.ok &&
    agentKind === "codex" &&
    model &&
    isCodexSelectedModelError(error?.message)
  ) {
    onModelRejected?.(model)
    res = await sendRequest(undefined)
    error = res.ok ? null : await readError(res, fallback(res))
    receipt = await readReceipt(res)
  }

  return { res, errorMessage: error?.message ?? null, errorCode: error?.code ?? null, observingReceipt, receipt }
}

function observeModelRejection(receipt: CommandReceipt, sendRequest: (model: string | undefined) => Promise<Response>, options: ModelFallbackOpts): void {
  const owner = conversationStateFor(receipt.sessionId)
  let stopped = false
  let unsubscribe = () => {}
  const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); unsubscribe(); options.signal?.removeEventListener("abort", stop); options.onReceiptSettled?.() }
  const timer = setTimeout(stop, 24 * 60 * 60 * 1000)
  const inspect = () => {
    if (stopped) return
    const state = owner.snapshot()
    if (options.signal?.aborted || state.error === "Account or device changed" || /Queue unavailable \((401|403|404)\)/.test(state.error ?? "")) { stop(); return }
    if (state.freshness !== "current") return
    const current = state.commands.find((command) => command.id === receipt.id)
    if (!current || !["failed", "completed", "cancelled", "unknown"].includes(current.state)) return
    stop()
    if (current.state !== "failed" || current.errorCode !== "MODEL_REJECTED" || current.delivery || current.turnId || state.conversation?.revision !== receipt.bindingRevision || state.conversation.binding.sessionId !== receipt.sessionId) return
    options.onModelRejected?.(options.model!)
    void sendRequest(undefined).then(async (response) => {
      if (!response.ok) options.onDeliveryError?.((await readError(response, "The default model could not accept the message")).message)
    }).catch((error: unknown) => { options.onDeliveryError?.(error instanceof Error ? error.message : "Fallback delivery could not be confirmed") })
  }
  unsubscribe = owner.subscribe(inspect)
  options.signal?.addEventListener("abort", stop, { once: true })
  inspect()
}
import { conversationStateFor } from "../conversationState"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
