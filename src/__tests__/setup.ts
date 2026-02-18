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
