import { renderComposerMessage, validateContext, type ComposerDraft } from "../../../shared/session/composerContext"

export const MAX_ATTACHMENT_BYTES = 3_500_000

export function combineContext(current: ComposerDraft, incoming: ComposerDraft): ComposerDraft {
  const context = [...current.context]
  for (const item of incoming.context) {
    const existing = context.find((old) => old.id === item.id)
    if (existing && renderComposerMessage({ text: "", context: [existing] }) !== renderComposerMessage({ text: "", context: [item] })) throw new Error("Context changed. Remove the existing item before pasting its replacement")
    if (!existing) context.push(item)
  }
  const refusal = validateContext(context)
  if (refusal) throw new Error(refusal)
  return { ...current, context }
}
