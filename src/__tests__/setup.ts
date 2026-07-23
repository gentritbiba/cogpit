import "@testing-library/jest-dom/vitest"

// Mock crypto.randomUUID for deterministic tests
let uuidCounter = 0

export function resetUUIDCounter() {
  uuidCounter = 0
}

// Provide deterministic UUIDs in tests when needed
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => `test-uuid-${++uuidCounter}` },
  })
}

// jsdom lacks ResizeObserver (needed by react-zoom-pan-pinch)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom lacks Element.getAnimations (reached by @base-ui ScrollArea once ResizeObserver exists)
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => []
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
