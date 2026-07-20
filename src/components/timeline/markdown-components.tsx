import { useState } from "react"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { PluggableList } from "unified"
import { authUrl } from "@/lib/auth"
import { openInEditor } from "@/components/FileChangesPanel/open-in-editor"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
])

/** True when the src looks like a local absolute file path to an image */
function isLocalImagePath(src: string | undefined): boolean {
  if (!src) return false
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) return false
  if (!src.startsWith("/")) return false
  const dot = src.lastIndexOf(".")
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(src.slice(dot).toLowerCase())
}

/**
 * Rewrite local image paths to go through the API proxy. `authUrl` applies the
 * active device prefix and appends the auth token for remote clients — fixing a
 * pre-existing bug where remote <img> loads were token-less (and so 401'd) and
 * routing the request to the active device via the hub proxy. Only the proxy
 * URL is wrapped; external/data URLs pass through untouched so the token is
 * never leaked to a third-party host.
 */
function resolveImageSrc(src: string | undefined): string | undefined {
  if (!src) return src
  if (isLocalImagePath(src)) return authUrl(`/api/local-file?path=${encodeURIComponent(src)}`)
  return src
}

interface LocalFileTarget {
  path: string
  line?: number
  column?: number
}

/** Parse an absolute filesystem link, including optional :line:column or #LxCy. */
export function parseLocalFileHref(href: string | undefined): LocalFileTarget | null {
  if (!href) return null

  let target = href
  if (target.toLowerCase().startsWith("file://")) {
    try {
      const fileUrl = new URL(target)
      target = `${fileUrl.pathname}${fileUrl.hash}`
    } catch {
      return null
    }
  }

  const isPosixPath = target.startsWith("/") && !target.startsWith("//")
  const isWindowsPath = /^\/?[a-z]:[\\/]/i.test(target)
  if (!isPosixPath && !isWindowsPath) return null

  let line: number | undefined
  let column: number | undefined

  const fragmentLocation = target.match(/#L(\d+)(?:C(\d+))?$/i)
  if (fragmentLocation) {
    line = Number(fragmentLocation[1])
    column = fragmentLocation[2] ? Number(fragmentLocation[2]) : undefined
    target = target.slice(0, -fragmentLocation[0].length)
  } else {
    const suffixLocation = target.match(/:(\d+)(?::(\d+))?$/)
    if (suffixLocation) {
      line = Number(suffixLocation[1])
      column = suffixLocation[2] ? Number(suffixLocation[2]) : undefined
      target = target.slice(0, -suffixLocation[0].length)
    }
  }

  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }

  // file:///C:/path is represented as /C:/path by URL.pathname.
  if (/^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1)

  return { path: target, line, column }
}

/**
 * Opens filesystem links in the configured code editor and web URLs in the
 * default browser (Electron intercepts window.open for external navigation).
 */
function ExternalLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return

    e.preventDefault()
    const fileTarget = parseLocalFileHref(href)
    if (fileTarget) {
      openInEditor(fileTarget.path, "file", {
        line: fileTarget.line,
        column: fileTarget.column,
      })
    } else {
      window.open(href, "_blank")
    }
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-primary underline decoration-primary/30 hover:decoration-primary/60 cursor-pointer transition-colors"
      title={href}
      {...props}
    >
      {children}
    </a>
  )
}

/**
 * Image component that proxies local file paths through /api/local-file
 * and supports click-to-expand in a dialog.
 */
function LocalImage({ src, alt }: { src?: string; alt?: string }) {
  const [expanded, setExpanded] = useState(false)
  const resolved = resolveImageSrc(src)

  return (
    <>
      <img
        src={resolved}
        alt={alt ?? ""}
        className="my-3 max-w-full max-h-96 rounded-lg border border-border/30 cursor-pointer hover:border-border/60 transition-colors"
        onClick={() => setExpanded(true)}
      />
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <img
            src={resolved}
            alt={alt ?? ""}
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
          />
        </div>
      )}
    </>
  )
}

/**
 * Regex to detect bare image file paths on their own line.
 * Matches absolute paths like /tmp/screenshot.png that aren't already in markdown image syntax.
 * Generated from IMAGE_EXTENSIONS to keep the two in sync.
 */
const EXT_PATTERN = [...IMAGE_EXTENSIONS].map(e => e.slice(1)).join("|")
const BARE_IMAGE_PATH_RE = new RegExp(`^([ \\t]*)(\\/[^\\s]+\\.(?:${EXT_PATTERN}))[ \\t]*$`, "gim")

/**
 * Pre-processes markdown text to convert bare image file paths into markdown image syntax.
 * e.g. "/tmp/screenshot.png" becomes "![/tmp/screenshot.png](/tmp/screenshot.png)"
 */
export function preprocessImagePaths(text: string): string {
  return text.replace(BARE_IMAGE_PATH_RE, (_match, indent, path) => {
    return `${indent}![${path}](${path})`
  })
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
      <p className="my-1.5 leading-[1.55] text-foreground/90 first:mt-0 last:mb-0 md:my-2 md:leading-relaxed">
        {children}
      </p>
    )
  },

  // ── Blockquote ─────────────────────────────────────────────────────────────
  blockquote({ children }) {
    return (
      <blockquote className="my-2 rounded-r-md border-l-[3px] border-blue-400/40 bg-blue-500/5 py-1.5 pl-3 pr-2.5 text-foreground/80 [&>p]:my-1 md:my-3 md:py-2 md:pl-4 md:pr-3">
        {children}
      </blockquote>
    )
  },

  // ── Lists ──────────────────────────────────────────────────────────────────
  ul({ children }) {
    return (
      <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-muted-foreground/50 [&_ol]:my-1 [&_ul]:my-1 md:my-2 md:space-y-1 md:pl-6">
        {children}
      </ul>
    )
  },
  ol({ children }) {
    return (
      <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-muted-foreground/50 [&_ol]:my-1 [&_ul]:my-1 md:my-2 md:space-y-1 md:pl-6">
        {children}
      </ol>
    )
  },
  li({ children }) {
    return (
      <li className="pl-1 leading-[1.55] text-foreground/90 md:leading-relaxed">
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
  img: LocalImage,

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
