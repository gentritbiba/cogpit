// @vitest-environment node
import { describe, expect, it } from "vitest"
import { buildView, formatBuildError } from "../../views/build"
import type { ViewKitIndex } from "../../views/kit"
import type { ViewSourceFile } from "../../../shared/views/stored"

const KIT: ViewKitIndex = {
  modules: [
    { id: "base", provides: ["react", "react/jsx-runtime", "cogpit/ui", "cogpit/runtime"], always: true, code: "exports.modules = {}", css: ".ck-base{}" },
    { id: "charts", provides: ["cogpit/charts"], always: false, code: "exports.modules = {}", css: ".ck-charts{}" },
  ],
}

const APP = `import { Card } from "cogpit/ui"\nexport default function App() { return <Card title="x" /> }\n`

function build(files: ViewSourceFile[]) {
  return buildView({ title: "Test <view>", files }, KIT)
}

/** The module payload a built page carries. */
function payload(html: string): { kit: { id: string }[]; modules: { name: string; kind: string; map?: Record<string, string>; value?: unknown; code?: string }[]; entry: string } {
  const json = /<script type="application\/json" id="cogpit-view-modules">([\s\S]*?)<\/script>/.exec(html)![1]!
  return JSON.parse(json)
}

describe("buildView", () => {
  it("compiles what App.tsx reaches into one page with the kit it needs", () => {
    const result = build([
      { path: "App.tsx", text: `import { Bars } from "./components/Bars"\nimport data from "./data.json"\nimport "./styles.css"\nexport default function App() { return <Bars rows={data.rows} /> }` },
      { path: "components/Bars.tsx", text: `import { formatValue } from "cogpit/ui"\nexport const Bars = ({ rows }: { rows: number[] }) => <p>{rows.map(formatValue).join()}</p>` },
      { path: "data.json", text: `{"rows":[1,2]}` },
      { path: "styles.css", text: `p{color:red}` },
      { path: "unused.tsx", text: `export const nope = (` },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { kit, modules, entry } = payload(result.html)
    expect(entry).toBe("App.tsx")
    expect(kit.map((module) => module.id)).toEqual(["base"])
    expect(modules.map((module) => module.name).sort()).toEqual(["App.tsx", "components/Bars.tsx", "data.json", "styles.css"])
    expect(modules.find((module) => module.name === "App.tsx")!.map).toEqual({ "./components/Bars": "components/Bars.tsx", "./data.json": "data.json", "./styles.css": "styles.css" })
    expect(modules.find((module) => module.name === "data.json")!.value).toEqual({ rows: [1, 2] })
    expect(result.html).toContain("<title>Test &#60;view&#62;</title>")
    expect(result.html).toContain(".ck-base{}")
    expect(result.html).not.toContain(".ck-charts{}")
  })

  it("brings an optional kit module only when the view imports it", () => {
    const result = build([{ path: "App.tsx", text: `import { LineChart } from "cogpit/charts"\nexport default () => <LineChart />` }])
    expect(result.ok && payload(result.html).kit.map((module) => module.id)).toEqual(["base", "charts"])
  })

  it("keeps the agent's code from closing the page's scripts", () => {
    const result = build([{ path: "App.tsx", text: `export default function App() { return <p>{"</script><script>alert(1)</script><!--"}</p> }` }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const json = /id="cogpit-view-modules">([\s\S]*?)<\/script>/.exec(result.html)![1]!
    expect(json).not.toMatch(/<\/script|<!--/i)
    expect(payload(result.html).modules[0]!.code).toContain("</script><script>alert(1)</script><!--")
  })

  it("reports every unresolved import with its file", () => {
    const result = build([
      { path: "App.tsx", text: `import _ from "lodash"\nimport { X } from "./missing"\nexport default function App() { return <p>{_.x}{X}</p> }` },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    const messages = result.errors.map(formatBuildError)
    expect(messages).toEqual([
      expect.stringMatching(/^App\.tsx: Cannot import "lodash": a view has no network or npm\. Use react, react\/jsx-runtime, cogpit\/ui, cogpit\/charts/),
      `App.tsx: Cannot find "./missing" in the view's files`,
    ])
  })

  it("refuses the kit's own runtime and paths above the view", () => {
    const result = build([{ path: "App.tsx", text: `import { mount } from "cogpit/runtime"\nimport secret from "../../view.json"\nexport default () => <p>{String(mount)}{String(secret)}</p>` }])
    expect(result.ok ? [] : result.errors.map(formatBuildError)).toEqual([
      expect.stringContaining(`Cannot import "cogpit/runtime"`),
      `App.tsx: Cannot find "../../view.json" in the view's files`,
    ])
  })

  it("points a syntax error at its line and column", () => {
    const result = build([{ path: "App.tsx", text: APP }, { path: "Broken.tsx", text: "export const x = 1\nexport const y = (\n" }, { path: "Main.tsx", text: "" }])
    expect(result.ok).toBe(true)
    const broken = build([{ path: "App.tsx", text: `export default function App() {\n  return <div>{</div>\n}` }])
    expect(broken.ok ? null : broken.errors[0]).toMatchObject({ file: "App.tsx", line: 2 })
    expect(broken.ok ? "" : formatBuildError(broken.errors[0]!)).toMatch(/^App\.tsx:2:\d+: /)
  })

  it("needs App.tsx with a default export and valid JSON", () => {
    expect(build([{ path: "Main.tsx", text: APP }])).toEqual({ ok: false, errors: [{ message: expect.stringContaining("needs App.tsx") }] })
    expect(build([{ path: "App.tsx", text: "export const App = () => null" }])).toMatchObject({ ok: false, errors: [{ file: "App.tsx", message: expect.stringContaining("default export") }] })
    const json = build([{ path: "App.tsx", text: `import d from "./d.json"\nexport default () => <p>{d}</p>` }, { path: "d.json", text: "{nope" }])
    expect(json).toMatchObject({ ok: false, errors: [{ file: "d.json", message: expect.stringContaining("Invalid JSON") }] })
  })

  it("accepts plain JavaScript and JSX entries", () => {
    expect(build([{ path: "App.jsx", text: `export default function App() { return <p>hi</p> }` }]).ok).toBe(true)
    expect(build([{ path: "App.js", text: `import { jsx } from "react/jsx-runtime"\nexport default function App() { return jsx("p", { children: "hi" }) }` }]).ok).toBe(true)
  })

  it("brings each real kit module only for the imports it provides", () => {
    const kitOf = (imports: string) => {
      const result = buildView({ title: "x", files: [{ path: "App.tsx", text: `${imports}\nexport default () => null` }] })
      return result.ok ? payload(result.html).kit.map((module) => module.id) : result.errors.map(formatBuildError)
    }
    expect(kitOf(`import { useState } from "react"`)).toEqual(["base"])
    expect(kitOf(`import { LineChart } from "cogpit/charts"\nconsole.log(LineChart)`)).toEqual(["base", "charts"])
    expect(kitOf(`import katex from "katex"\nimport { Tex } from "cogpit/math"\nconsole.log(katex, Tex)`)).toEqual(["base", "math"])
    expect(kitOf(`import * as THREE from "three"\nimport { OrbitControls } from "three/addons/controls/OrbitControls.js"\nconsole.log(THREE, OrbitControls)`)).toEqual(["base", "scene"])
    expect(kitOf(`import * as d3 from "d3"\nconsole.log(d3)`)).toEqual(["base", "d3"])
  })

  it("reads imports from code, not from strings or comments that mention one", () => {
    const result = build([{ path: "App.tsx", text: `// Example: require("example") or import x from "lodash"
const shown = 'require("left-pad")'
export default function App() { return <p title={\`require("x")\`}>{shown}{"import y from 'z'"}</p> }` }])
    expect(result.ok ? [] : result.errors.map(formatBuildError)).toEqual([])
  })

  it("accepts an entry that re-exports its default from another file", () => {
    for (const app of [`export { default } from "./Root"`, `import Root from "./Root"\nexport { Root as default }`]) {
      const result = build([{ path: "App.tsx", text: app }, { path: "Root.tsx", text: `export default function Root() { return <p>root</p> }` }])
      expect(result.ok ? [] : result.errors.map(formatBuildError), app).toEqual([])
    }
    const missing = build([{ path: "App.tsx", text: `export const App = () => null\nexport type { App as Default }` }])
    expect(missing.ok ? [] : missing.errors.map(formatBuildError)).toEqual(["App.tsx: Needs a default export: the component to show"])
  })
})

