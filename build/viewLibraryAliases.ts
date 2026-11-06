import { join } from "node:path"
import type { Alias } from "vite"
import { root } from "../scripts/lib/sourceFiles"

/**
 * The files an interactive view can load, by `@view-lib/<name>`. The packages'
 * export maps only expose their ES entries, but a view needs the browser
 * builds: the UMD globals and Three.js's minified modules.
 */
const FILES: Readonly<Record<string, string>> = {
  d3: "d3/dist/d3.min.js",
  katex: "katex/dist/katex.min.js",
  "katex-auto-render": "katex/dist/contrib/auto-render.min.js",
  three: "three/build/three.module.min.js",
  "three-core": "three/build/three.core.min.js",
  "three-orbit-controls": "three/examples/jsm/controls/OrbitControls.js",
}

/** Asset imports, not packages: the dev server must not try to pre-bundle them. */
export const VIEW_LIBRARY_IDS = Object.keys(FILES).flatMap((name) => [`@view-lib/${name}`, `@view-lib/${name}?raw`])

export function viewLibraryAliases(checkout = root): Alias[] {
  return Object.entries(FILES).map(([name, file]) => ({
    find: new RegExp(`^@view-lib/${name}(?=\\?|$)`),
    replacement: join(checkout, "node_modules", file),
  }))
}
