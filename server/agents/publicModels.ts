/**
 * Model ids safe to report in usage data. Vendors publish these, and the CLIs
 * accept their family aliases (`opus`, `sonnet`). Anything else may be a name
 * someone gave a local or fine-tuned model, so it reports as `other`. A routed
 * id such as `anthropic/claude-sonnet-4-5` keeps its last part, and a context
 * marker such as `[1m]` is dropped.
 */
const PUBLIC_MODEL = /^(?:claude|gpt|o[1-9]|codex|gemini|grok|opus|sonnet|haiku|fable)(?:[-._:][a-z0-9]+)*$/

export const OTHER_MODEL = "other"

export function publicModelName(model: string | null | undefined): string | undefined {
  const id = model?.trim().toLowerCase().split("/").pop()?.replace(/\[[a-z0-9]+\]$/, "")
  if (!id) return undefined
  return id.length <= 64 && PUBLIC_MODEL.test(id) ? id : OTHER_MODEL
}
