import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { PluggableList } from "unified"

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
      className="text-blue-400 underline decoration-blue-400/40 hover:decoration-blue-400 cursor-pointer transition-colors"
      title={href}
      {...props}
    >
      {children}
    </a>
  )
}

export const markdownComponents: Components = {
  a: ExternalLink,
}

export const markdownPlugins: PluggableList = [remarkGfm]
