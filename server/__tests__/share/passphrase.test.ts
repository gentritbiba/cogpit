// @vitest-environment node
import { describe, it, expect } from "vitest"
import { generatePassphrase, PASSPHRASE_WORDS } from "../../share/passphrase"
import { MIN_PASSWORD_LENGTH } from "../../password-utils"

describe("generatePassphrase", () => {
  it("produces four dash-separated words and a two-digit suffix", () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/)
  })

  it("always clears the password-strength minimum", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassphrase().length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH)
    }
  })

  it("does not repeat within a reasonable sample", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassphrase()))
    expect(seen.size).toBe(500)
  })

  it("draws from a wordlist large enough to be worth guessing", () => {
    // 4 words from N plus 100 suffixes; need >= 2^50 to be brute-force-hostile
    expect(PASSPHRASE_WORDS.length ** 4 * 100).toBeGreaterThan(2 ** 50)
  })

  it("uses only lowercase ascii words with no duplicates in the list", () => {
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length)
    for (const word of PASSPHRASE_WORDS) expect(word).toMatch(/^[a-z]{3,8}$/)
  })
})
