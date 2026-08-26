// @vitest-environment node
import { describe, it, expect } from "vitest"
import { generatePassphrase, PASSPHRASE_WORDS } from "../../share/passphrase"
import { MIN_PASSWORD_LENGTH } from "../../password-utils"

/**
 * True when `a` and `b` differ by exactly one insertion, deletion, substitution
 * or adjacent transposition (Damerau-Levenshtein distance 1).
 */
function isOneEditApart(a: string, b: string): boolean {
  if (a.length === b.length) {
    const differing: number[] = []
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) differing.push(i)
    }
    if (differing.length === 1) return true
    // Transpositions stay in scope because the class they catch is the
    // transatlantic -el/-le and -er/-re homophones (mantel/mantle,
    // meter/metre), not typos. Narrowing this to plain Levenshtein loses them.
    const [first, second] = differing
    return (
      differing.length === 2 &&
      second === first + 1 &&
      a[first] === b[second] &&
      a[second] === b[first]
    )
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  if (long.length - short.length !== 1) return false
  let i = 0
  while (i < short.length && short[i] === long[i]) i++
  return short.slice(i) === long.slice(i + 1)
}

describe("generatePassphrase", () => {
  it("produces four dash-separated words and a two-digit suffix", () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/)
  })

  it("always clears the password-strength minimum", () => {
    const shortest = Math.min(...PASSPHRASE_WORDS.map((w) => w.length))
    expect(shortest * 4 + 6).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH)
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

  it("holds no pair of words one edit apart", () => {
    const byLength = new Map<number, string[]>()
    for (const word of PASSPHRASE_WORDS) {
      const bucket = byLength.get(word.length)
      if (bucket) bucket.push(word)
      else byLength.set(word.length, [word])
    }

    const collisions: string[] = []
    for (const [length, words] of byLength) {
      // An edit-distance-1 partner is the same length or one letter longer.
      const candidates = [...words, ...(byLength.get(length + 1) ?? [])]
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const other = candidates[j]
          if (isOneEditApart(words[i], other)) collisions.push(`${words[i]}/${other}`)
        }
      }
    }

    expect(collisions, `words one edit apart: ${collisions.join(", ")}`).toEqual([])
  })
})
