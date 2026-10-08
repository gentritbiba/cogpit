import "@testing-library/jest-dom/vitest"
import { afterAll, beforeEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const databaseClosers = vi.hoisted(() => new Set<() => void>())
vi.mock("../../server/orchestration/database", async (original) => {
  const actual = await original<typeof import("../../server/orchestration/database")>()
  return { ...actual, openDatabase: (...args: Parameters<typeof actual.openDatabase>) => {
    const database = actual.openDatabase(...args)
    const nativeClose = database.close.bind(database)
    const close = () => { nativeClose(); databaseClosers.delete(close) }
    database.close = close
    databaseClosers.add(close)
    return database
  } }
})

const orchestrationRoots = new Set<string>()
const initialOrchestrationRoot = mkdtempSync(join(tmpdir(), "cogpit-vitest-orchestration-"))
orchestrationRoots.add(initialOrchestrationRoot)
process.env.COGPIT_ORCHESTRATION_ROOT = initialOrchestrationRoot
beforeEach(() => { const root = mkdtempSync(join(tmpdir(), "cogpit-vitest-orchestration-")); orchestrationRoots.add(root); process.env.COGPIT_ORCHESTRATION_ROOT = root })
afterAll(async () => {
  if (typeof window === "undefined") {
    const { closeOrchestrationStore } = await import("../../server/orchestration/storage")
    closeOrchestrationStore()
  }
  for (const close of databaseClosers) close()
  for (const root of orchestrationRoots) rmSync(root, { recursive: true, force: true })
})

// No power fails under test, and a real flush costs milliseconds per durable
// write on macOS. The suites that check what reaches the disk unmock it.
vi.mock("../../server/lib/diskSync", () => ({
  syncFile: async () => {},
  syncDirectory: async () => {},
}))

// jsdom lacks ResizeObserver (needed by react-zoom-pan-pinch)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom lacks pointer capture (used by drag handling on the browser viewport canvas)
if (typeof Element !== "undefined" && typeof Element.prototype.setPointerCapture === "undefined") {
  const captured = new WeakMap<Element, Set<number>>()
  Element.prototype.setPointerCapture = function setPointerCapture(pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>()
    ids.add(pointerId)
    captured.set(this, ids)
  }
  Element.prototype.releasePointerCapture = function releasePointerCapture(pointerId: number) {
    captured.get(this)?.delete(pointerId)
  }
  Element.prototype.hasPointerCapture = function hasPointerCapture(pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false
  }
}

// jsdom lacks Element.getAnimations (reached by @base-ui ScrollArea once ResizeObserver exists)
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => []
}

// jsdom lacks matchMedia (reached by useIsMobile and viewTransitions)
if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// Mock localStorage for auth tests
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
})()

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock })
