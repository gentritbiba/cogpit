import "@testing-library/jest-dom/vitest"

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
