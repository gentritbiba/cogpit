import type { ViewLibraryName } from "./document"

export interface ViewLibrary {
  name: ViewLibraryName
  code: string
}

/** The sandbox draws math with the browser's MathML, so KaTeX needs no stylesheet or fonts. */
const KATEX_MATHML = `;(() => {
  const { render, renderToString } = katex
  const mathml = (options) => ({ output: "mathml", ...options })
  katex.render = (tex, element, options) => render(tex, element, mathml(options))
  katex.renderToString = (tex, options) => renderToString(tex, mathml(options))
})();`

/** Each library's code, as its own chunk fetched the first time a view uses it. */
const SOURCES: Readonly<Record<ViewLibraryName, () => Promise<string>>> = {
  d3: async () => (await import("@view-lib/d3?raw")).default,
  katex: async () => {
    const [katex, autoRender] = await Promise.all([import("@view-lib/katex?raw"), import("@view-lib/katex-auto-render?raw")])
    return [katex.default, KATEX_MATHML, autoRender.default].join("\n;\n")
  },
  // The module build imports its core by relative path, which a blob URL cannot resolve.
  three: async () => (await import("@view-lib/three?raw")).default.replaceAll(`"./three.core.min.js"`, `"three/core"`),
  "three-core": async () => (await import("@view-lib/three-core?raw")).default,
  "three-orbit-controls": async () => (await import("@view-lib/three-orbit-controls?raw")).default,
}

export function loadViewLibraries(names: Iterable<ViewLibraryName>): Promise<ViewLibrary[]> {
  return Promise.all([...names].map(async (name) => ({ name, code: await SOURCES[name]() })))
}
