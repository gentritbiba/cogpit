/**
 * Lazily initializes and caches the @git-diff-view/shiki highlighter singleton.
 */
import { getDiffViewHighlighter } from "@git-diff-view/shiki"

let highlighterPromise: ReturnType<typeof getDiffViewHighlighter> | null = null

export function getDiffHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = getDiffViewHighlighter()
  }
  return highlighterPromise
}
