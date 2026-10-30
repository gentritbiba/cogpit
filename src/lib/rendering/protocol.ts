import type { ThemedToken } from "shiki/core"
import type { DiffLine } from "./diff"

export type RenderInput =
  | { kind: "diff"; oldString: string; newString: string }
  | { kind: "highlight"; code: string; lang: string; isDark: boolean }
export type RenderOutput = DiffLine[] | ThemedToken[][] | null
export interface RenderRequest { id: number; input: RenderInput }
export type RenderResponse = { id: number; result: RenderOutput; error?: false } | { id: number; error: true }

// Conservative retained-memory estimates include strings, array slots and objects.
export function outputBytes(result: RenderOutput): number {
  if (!result) return 0
  let bytes = 32 + result.length * 8
  for (const line of result) {
    if (Array.isArray(line)) {
      bytes += 32 + line.length * 8
      for (const token of line) bytes += 128 + token.content.length * 2 + (token.color?.length ?? 0) * 2
    } else bytes += 96 + line.text.length * 2
  }
  return bytes
}
