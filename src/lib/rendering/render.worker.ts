import { computeDiff } from "./diff"
import { tokenize } from "./shiki-engine"
import { outputBytes, type RenderRequest, type RenderResponse } from "./protocol"

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<RenderRequest>) => void
  postMessage: (message: RenderResponse) => void
}
scope.onmessage = async ({ data: { id, input } }) => {
  try {
    const result = input.kind === "diff"
      ? computeDiff(input.oldString, input.newString)
      : await tokenize(input.code, input.lang, input.isDark)
    scope.postMessage({ id, result: input.kind === "highlight" && outputBytes(result) > 4 * 1024 * 1024 ? null : result })
  } catch {
    // Recreate poisoned highlighters too (for example after a failed grammar import).
    scope.postMessage({ id, error: true })
  }
}
