import { webcrypto } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import seeds from "../../../generated/runtime-plugin-seeds/index.json"
import { prepareRuntimePackage } from "../runtimePayload"

const runtime = window as typeof window & { cogpitPlugin?: unknown; process?: unknown }
afterEach(() => { delete runtime.cogpitPlugin })

describe("shipped plugin packages", () => {
  it.each(seeds)("loads $id without host or Node globals", async (seed) => {
    const bytes = Uint8Array.from(atob(seed.payload), (character) => character.charCodeAt(0)).buffer
    const prepared = await prepareRuntimePackage(bytes, seed.payloadDigest, webcrypto as unknown as Crypto)
    expect(prepared.manifest.id).toBe(seed.id)
    expect(prepared.style).toBeTruthy()
    const originalProcess = runtime.process
    Reflect.deleteProperty(runtime, "process")
    try {
      window.eval(prepared.entry)
      expect(typeof runtime.cogpitPlugin).toBe("function")
    } finally {
      if (originalProcess !== undefined) runtime.process = originalProcess
    }
  })
})
