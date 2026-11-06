/**
 * The `cogpit/math` kit module: KaTeX drawn as the browser's own MathML, so it
 * needs no stylesheet or fonts. Also provides `katex`, set to MathML output.
 */
import katexLibrary, { type KatexOptions } from "katex"
import type { CSSProperties } from "react"

const mathml = (options?: KatexOptions): KatexOptions => ({ output: "mathml", throwOnError: false, ...options })

const katex = {
  ...katexLibrary,
  render: (tex: string, element: HTMLElement, options?: KatexOptions) => katexLibrary.render(tex, element, mathml(options)),
  renderToString: (tex: string, options?: KatexOptions) => katexLibrary.renderToString(tex, mathml(options)),
}

/** A TeX formula, inline by default; `block` centers it on its own line. */
export function Tex({ children, tex, block = false, className, style }: { children?: string; tex?: string; block?: boolean; className?: string; style?: CSSProperties }) {
  const html = katex.renderToString(tex ?? children ?? "", { displayMode: block })
  const Tag = block ? "div" : "span"
  return <Tag className={["ck-tex", block && "ck-tex-block", className].filter(Boolean).join(" ")} style={style} dangerouslySetInnerHTML={{ __html: html }} />
}

export const modules = {
  "cogpit/math": { Tex },
  katex: { ...katex, default: katex },
}
