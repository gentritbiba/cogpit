import type { ToolCall as ParsedToolCall } from "@/lib/types"

/**
 * Compact preview for tools that carry a familiar input key.
 *
 * Preferred over the shared presentation summary, which spells paths out in
 * full; callers fall back to that summary when this returns "".
 */
export function toolInputPreview(tc: ParsedToolCall): string {
  const fp = (tc.input.file_path ?? tc.input.path ?? "") as string
  if (fp) return fp.split("/").pop() || fp
  const cmd = tc.input.command as string | undefined
  if (cmd) return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd
  const pat = tc.input.pattern as string | undefined
  if (pat) return pat.length > 30 ? pat.slice(0, 27) + "..." : pat
  const query = tc.input.query as string | undefined
  if (query) return query.length > 30 ? query.slice(0, 27) + "..." : query
  return ""
}
