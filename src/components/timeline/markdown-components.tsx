import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { PluggableList } from "unified"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"

/**
 * Custom link component that opens URLs in the default browser
 * via window.open(), which Electron intercepts via setWindowOpenHandler.
 */
function ExternalLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (href) {
      e.preventDefault()
      window.open(href, "_blank")
    }
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-blue-600 dark:text-blue-400 underline decoration-blue-500/30 hover:decoration-blue-500/60 cursor-pointer transition-colors"
      title={href}
      {...props}
    >
      {children}
    </a>
  )
}

export const markdownComponents: Components = {
  // ── Code ───────────────────────────────────────────────────────────────────
  code: MarkdownCodeBlock,

  pre({ children }) {
    // react-markdown wraps code blocks in <pre><code>. We handle all
    // styling inside MarkdownCodeBlock, so the <pre> wrapper should be transparent.
    return <>{children}</>
  },

  // ── Links (Electron-aware) ────────────────────────────────────────────────
  a: ExternalLink,

  // ── Headings ───────────────────────────────────────────────────────────────
  h1({ children }) {
    return (
      <h1 className="text-xl font-semibold mt-6 mb-3 pb-2 border-b border-border/40 text-foreground first:mt-0">
        {children}
      </h1>
    )
  },
  h2({ children }) {
    return (
      <h2 className="text-lg font-semibold mt-5 mb-2 pb-1.5 border-b border-border/30 text-foreground first:mt-0">
        {children}
      </h2>
    )
  },
  h3({ children }) {
    return (
      <h3 className="text-base font-semibold mt-4 mb-2 text-foreground first:mt-0">
        {children}
      </h3>
    )
  },
  h4({ children }) {
    return (
      <h4 className="text-sm font-semibold mt-3 mb-1.5 text-foreground first:mt-0">
        {children}
      </h4>
    )
  },
  h5({ children }) {
    return (
      <h5 className="text-sm font-medium mt-3 mb-1 text-foreground first:mt-0">
        {children}
      </h5>
    )
  },
  h6({ children }) {
    return (
      <h6 className="text-xs font-medium mt-3 mb-1 text-muted-foreground first:mt-0">
        {children}
      </h6>
    )
  },

  // ── Paragraph ──────────────────────────────────────────────────────────────
  p({ children }) {
    return (
      <p className="my-2 leading-relaxed text-foreground/90 first:mt-0 last:mb-0">
        {children}
      </p>
    )
  },

  // ── Blockquote ─────────────────────────────────────────────────────────────
  blockquote({ children }) {
    return (
      <blockquote className="my-3 pl-4 border-l-[3px] border-blue-400/40 bg-blue-500/5 rounded-r-md py-2 pr-3 text-foreground/80 [&>p]:my-1">
        {children}
      </blockquote>
    )
  },

  // ── Lists ──────────────────────────────────────────────────────────────────
  ul({ children }) {
    return (
      <ul className="my-2 pl-6 space-y-1 list-disc marker:text-muted-foreground/50 [&_ul]:my-1 [&_ol]:my-1">
        {children}
      </ul>
    )
  },
  ol({ children }) {
    return (
      <ol className="my-2 pl-6 space-y-1 list-decimal marker:text-muted-foreground/50 [&_ul]:my-1 [&_ol]:my-1">
        {children}
      </ol>
    )
  },
  li({ children }) {
    return (
      <li className="text-foreground/90 leading-relaxed pl-1">
        {children}
      </li>
    )
  },

  // ── Horizontal Rule ────────────────────────────────────────────────────────
  hr() {
    return <hr className="my-4 border-border/40" />
  },

  // ── Table (GitHub-style) ───────────────────────────────────────────────────
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border/40">
        <table className="w-full text-sm border-collapse">
          {children}
        </table>
      </div>
    )
  },
  thead({ children }) {
    return (
      <thead className="bg-elevation-2/60">
        {children}
      </thead>
    )
  },
  tbody({ children }) {
    return <tbody className="divide-y divide-border/30">{children}</tbody>
  },
  tr({ children }) {
    return (
      <tr className="hover:bg-elevation-2/30 transition-colors even:bg-elevation-1/50">
        {children}
      </tr>
    )
  },
  th({ children }) {
    return (
      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/40">
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td className="px-3 py-2 text-foreground/90">
        {children}
      </td>
    )
  },

  // ── Inline styles ──────────────────────────────────────────────────────────
  strong({ children }) {
    return <strong className="font-semibold text-foreground">{children}</strong>
  },
  em({ children }) {
    return <em className="italic text-foreground/90">{children}</em>
  },
  del({ children }) {
    return <del className="line-through text-muted-foreground">{children}</del>
  },

  // ── Images ─────────────────────────────────────────────────────────────────
  img({ src, alt }) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-3 max-w-full rounded-lg border border-border/30"
      />
    )
  },

  // ── Task list items (GFM checkboxes) ───────────────────────────────────────
  input({ checked, ...rest }) {
    return (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="mr-2 rounded border-border accent-blue-500"
        {...rest}
      />
    )
  },
}

export const markdownPlugins: PluggableList = [remarkGfm]
