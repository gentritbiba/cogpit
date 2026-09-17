import { useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "./utils.js"

export function Description({ body, openExternal }: { body: string; openExternal?: (url: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const long = body.length > 700 || body.split("\n").length > 12
  return (
    <div className="max-w-[72ch]">
      <div className={cn("break-words text-xs leading-5 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_code]:font-mono [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold", long && !expanded && "max-h-52 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => {
            let url: URL | null = null
            try { url = new URL(href ?? "") } catch { /* Relative links have no provider origin. */ }
            return url?.protocol === "https:" && !url.username && !url.password && openExternal
              ? <button type="button" className="text-left underline underline-offset-2" onClick={() => openExternal(url.href)}>{children}</button>
              : <span>{children}</span>
          },
          img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
        }}>{body}</ReactMarkdown>
      </div>
      {long && <button type="button" className="mt-1 text-[11px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {expanded ? "Show less" : "Show full description"}
      </button>}
    </div>
  )
}
