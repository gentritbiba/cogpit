import { describe, expect, it } from "vitest"
import kit from "../../../generated/view-kit/index.json"
import { VIEW_KIT_MODULES } from "../modules"
import { parseViewReference, formatViewReference, isViewId } from "../../../shared/views/stored"

/** Evaluates a prebuilt kit module the way a view's loader does. */
function evaluate(code: string, provided: Record<string, unknown> = {}): Record<string, Record<string, unknown>> {
  const module = { exports: {} as { modules: Record<string, Record<string, unknown>> } }
  new Function("require", "module", "exports", code)((name: string) => provided[name], module, module.exports)
  return module.exports.modules
}

describe("view kit bundle", () => {
  it("builds every module the registry lists, providing exactly what it declares", () => {
    expect(kit.modules.map((module) => module.id)).toEqual(VIEW_KIT_MODULES.map((spec) => spec.id))
    const base = evaluate(kit.modules[0]!.code)
    for (const module of kit.modules) {
      const required: string[] = []
      const provided = module.always ? {} : new Proxy(base, { get: (target, name: string) => { required.push(name); return target[name] } })
      expect(Object.keys(evaluate(module.code, provided)).sort(), module.id).toEqual([...module.provides].sort())
      // A module shares only what every view has; it bundles anything else it uses.
      for (const name of required) expect(kit.modules[0]!.provides, `${module.id} requires ${name}`).toContain(name)
    }
  })

  it("keeps the base light and lets optional modules share its React", () => {
    const [base, ...optional] = kit.modules
    expect(base!.always).toBe(true)
    expect(base!.code.length).toBeLessThan(64 * 1024)
    expect(optional.every((module) => !module.always)).toBe(true)
    const charts = kit.modules.find((module) => module.id === "charts")!
    expect(charts.code).toContain(`require("react")`)
    expect(charts.code.length).toBeLessThan(100 * 1024)
  })

  it("renders a React-style app with the base components", async () => {
    const modules = evaluate(kit.modules.find((module) => module.id === "base")!.code)
    type Element = (type: unknown, props: Record<string, unknown>) => unknown
    const { jsx, jsxs } = modules["react/jsx-runtime"] as { jsx: Element; jsxs: Element }
    const { useState } = modules.react as { useState: <T>(value: T) => [T, (value: T) => void] }
    const ui = modules["cogpit/ui"] as Record<string, unknown>
    document.body.innerHTML = `<div id="root"></div>`
    function App() {
      const [count, setCount] = useState(2)
      return jsxs(ui.Card, { title: "Counter", children: [
        jsx(ui.Stat, { label: "Count", value: count * 1000 }),
        jsx(ui.Button, { variant: "primary", onClick: () => setCount(count + 1), children: "Add" }),
      ] })
    }
    ;(modules["cogpit/runtime"] as { mount: (load: () => unknown) => void }).mount(() => ({ default: App }))
    await new Promise((done) => setTimeout(done, 0))
    expect(document.querySelector(".ck-card-title")?.textContent).toBe("Counter")
    expect(document.querySelector(".ck-stat-value")?.textContent).toBe((2000).toLocaleString())
    ;(document.querySelector(".ck-button") as HTMLButtonElement).click()
    await new Promise((done) => setTimeout(done, 0))
    expect(document.querySelector(".ck-stat-value")?.textContent).toBe((3000).toLocaleString())
  })

  it("shows a readable error when the app has no component to mount", async () => {
    // Browsers that run views all have reportError; jsdom does not.
    window.reportError ??= (error: unknown) => { window.dispatchEvent(new ErrorEvent("error", { error })) }
    document.body.innerHTML = `<div id="root"></div>`
    const errors: unknown[] = []
    const listen = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault() }
    window.addEventListener("error", listen)
    const modules = evaluate(kit.modules.find((module) => module.id === "base")!.code)
    ;(modules["cogpit/runtime"] as { mount: (load: () => unknown) => void }).mount(() => ({}))
    await new Promise((done) => setTimeout(done, 0))
    window.removeEventListener("error", listen)
    expect(document.querySelector(".ck-error")?.textContent).toContain("App.tsx must export a default component")
    expect(errors).toHaveLength(1)
  })
})

describe("stored view references", () => {
  it("reads only a whole `<id>@<n>` body", () => {
    expect(parseViewReference(" sales-funnel@3\n")).toEqual({ id: "sales-funnel", version: 3 })
    for (const body of ["sales-funnel@0", "sales-funnel@", "Sales@1", "a--b@1", "<p>x@1</p>", "x@1 y", "x@12345678"]) {
      expect(parseViewReference(body), body).toBeNull()
    }
    expect(formatViewReference({ id: "a-b", version: 2 })).toBe("a-b@2")
    expect(isViewId("a".repeat(48))).toBe(true)
    expect(isViewId("a".repeat(49))).toBe(false)
  })
})
