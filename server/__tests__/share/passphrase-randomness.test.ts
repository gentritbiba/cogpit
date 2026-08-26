// @vitest-environment node
// Isolated from passphrase.test.ts because the crypto mock is module-wide:
// pinning randomInt to 0 would make every passphrase identical.
import { describe, it, expect, vi } from "vitest"
import { randomInt } from "node:crypto"
import { generatePassphrase, PASSPHRASE_WORDS } from "../../share/passphrase"

vi.mock("node:crypto", async (orig) => ({
  ...(await orig<typeof import("node:crypto")>()),
  randomInt: vi.fn(() => 0),
}))

describe("generatePassphrase randomness source", () => {
  it("draws all five components from crypto.randomInt over the full ranges", () => {
    const mock = vi.mocked(randomInt)
    mock.mockClear()

    const passphrase = generatePassphrase()

    expect(mock).toHaveBeenCalledTimes(5)
    for (const call of [1, 2, 3, 4]) {
      expect(mock).toHaveBeenNthCalledWith(call, PASSPHRASE_WORDS.length)
    }
    expect(mock).toHaveBeenNthCalledWith(5, 100)
    // Pins that the drawn number is the index actually used, not discarded.
    const first = PASSPHRASE_WORDS[0]
    expect(passphrase).toBe(`${first}-${first}-${first}-${first}-00`)
  })
})
