import { memo, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"

function compactHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function CompactHeading({ children }: { children?: ReactNode }) {
    return <Tag className="mt-2 mb-1 text-xs font-semibold text-foreground first:mt-0">{children}</Tag>
  }
}

/**
 * Markdown components that are safe to re-render while the source is still
 * being written. Syntax highlighting would retokenize an unfinished fence on
 * every stream flush, and incomplete image paths would issue bad requests.
 */
const streamingMarkdownComponents: Components = {
  ...markdownComponents,
  code({ className, children }) {
    const isInline = !className && typeof children === "string" && !children.includes("\n")
    if (isInline) {
      return (
        <code className="text-[0.9em] font-mono px-1 py-0.5 rounded bg-elevation-2 text-orange-600 dark:text-orange-300">
          {children}
        </code>
      )
    }
    return (
      <pre className="my-1.5 overflow-x-auto rounded border border-border/40 bg-elevation-1 p-2 text-[11px] leading-[1.5] font-mono">
        <code>{String(children).replace(/\n$/, "")}</code>
      </pre>
    )
  },
  img: () => null,
}

const compactStreamingMarkdownComponents: Components = {
  ...streamingMarkdownComponents,
  h1: compactHeading("h1"),
  h2: compactHeading("h2"),
  h3: compactHeading("h3"),
  h4: compactHeading("h4"),
  h5: compactHeading("h5"),
  h6: compactHeading("h6"),
}

interface StreamingMarkdownProps {
  text: string
  compactHeadings?: boolean
}

/** Parse live text immediately, while avoiding expensive/incomplete assets. */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  compactHeadings = false,
}: StreamingMarkdownProps) {
  return (
    <ReactMarkdown
      components={compactHeadings ? compactStreamingMarkdownComponents : streamingMarkdownComponents}
      remarkPlugins={markdownPlugins}
    >
      {text}
    </ReactMarkdown>
  )
})
