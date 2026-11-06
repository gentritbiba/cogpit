import { expect, it, vi } from "vitest"
import kit from "../../../generated/view-kit/index.json"

// Its own file: a tree mounted by another test can subscribe to the theme a frame late.
it("re-renders the app on a theme change, keeping its state", async () => {
  const listeners: Array<(theme: { mode: string }) => void> = []
  let mode = "dark"
  Object.assign(window, { cogpit: { get theme() { return { mode, tokens: {} } }, color: () => (mode === "dark" ? "#fff" : "#000"), onTheme: (listener: (theme: { mode: string }) => void) => { listeners.push(listener); return () => {} }, ask: () => {} } })
  const module = { exports: {} as { modules: Record<string, Record<string, unknown>> } }
  new Function("require", "module", "exports", kit.modules.find((entry) => entry.id === "base")!.code)(() => undefined, module, module.exports)
  const modules = module.exports.modules
  const { jsx } = modules["react/jsx-runtime"] as { jsx: (type: unknown, props: Record<string, unknown>) => unknown }
  const { useState } = modules.react as { useState: <T>(value: T) => [T, (value: T) => void] }
  const { themeColor } = modules["cogpit/ui"] as { themeColor: (name: string) => string }
  document.body.innerHTML = `<div id="root"></div>`
  function App() {
    const [clicks, setClicks] = useState(0)
    return jsx("button", { id: "b", "data-color": themeColor("--foreground"), onClick: () => setClicks(clicks + 1), children: String(clicks) })
  }
  ;(modules["cogpit/runtime"] as { mount: (load: () => unknown) => void }).mount(() => ({ default: App }))
  await new Promise((done) => setTimeout(done, 0))
  const button = () => document.getElementById("b")!
  button().click()
  await new Promise((done) => setTimeout(done, 0))
  expect([button().dataset.color, button().textContent]).toEqual(["#fff", "1"])
  // Preact runs effects after paint, so the theme subscription lands a frame later.
  await vi.waitFor(() => expect(listeners).toHaveLength(1))
  mode = "light"
  for (const listener of listeners) listener({ mode })
  await new Promise((done) => setTimeout(done, 0))
  expect([button().dataset.color, button().textContent]).toEqual(["#000", "1"])
  delete (window as { cogpit?: unknown }).cogpit
  })
