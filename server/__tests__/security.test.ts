// @vitest-environment node
import { describe, it, expect } from "vitest"
import { randomBytes, createHash } from "node:crypto"
import { hashPassword, verifyPassword, isPasswordHashed } from "../security"

describe("hashPassword", () => {
  it("produces a string starting with the $sha256$ prefix", () => {
    const hash = hashPassword("somepassword123")
    expect(hash.startsWith("$sha256$")).toBe(true)
  })

  it("produces a string with a colon-separated salt and hash after the prefix", () => {
    const hash = hashPassword("somepassword123")
    const inner = hash.slice("$sha256$".length)
    const parts = inner.split(":")
    expect(parts).toHaveLength(2)
    // salt: 32 hex chars, hash: 64 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/)
  })

  it("produces a different hash each call (salt randomness)", () => {
    const h1 = hashPassword("samepassword123")
    const h2 = hashPassword("samepassword123")
    expect(h1).not.toBe(h2)
  })
})

describe("verifyPassword", () => {
  it("returns true for a matching plaintext + hash pair", () => {
    const hash = hashPassword("correcthorsebattery")
    expect(verifyPassword("correcthorsebattery", hash)).toBe(true)
  })

  it("returns false for a wrong password against a hash", () => {
    const hash = hashPassword("correcthorsebattery")
    expect(verifyPassword("wrongpassword", hash)).toBe(false)
  })

  it("re-hashing the same password produces a different hash that still verifies", () => {
    const h1 = hashPassword("mysecretword1234")
    const h2 = hashPassword("mysecretword1234")
    expect(h1).not.toBe(h2)
    expect(verifyPassword("mysecretword1234", h1)).toBe(true)
    expect(verifyPassword("mysecretword1234", h2)).toBe(true)
  })

  it("handles legacy format (no prefix, salt:hash) for backward compat", () => {
    // Simulate a hash produced by the old hashPassword that lacked the $sha256$ prefix.
    // Old format: <32-hex-salt>:<64-hex-sha256>
    const salt = randomBytes(16).toString("hex") // 32 hex chars
    const password = "legacypassword123"
    const hash = createHash("sha256").update(salt + password).digest("hex")
    const legacyStored = `${salt}:${hash}`

    expect(verifyPassword(password, legacyStored)).toBe(true)
    expect(verifyPassword("wrongpassword", legacyStored)).toBe(false)
  })

  it("returns true for plaintext fallback (stored value has no colon)", () => {
    // Very old plaintext passwords stored before any hashing
    expect(verifyPassword("plaintextpass", "plaintextpass")).toBe(true)
    expect(verifyPassword("wrongpass", "plaintextpass")).toBe(false)
  })
})

describe("isPasswordHashed", () => {
  it("returns true for a freshly hashed password", () => {
    const hash = hashPassword("mypassword12345")
    expect(isPasswordHashed(hash)).toBe(true)
  })

  it("returns false for a plaintext password", () => {
    expect(isPasswordHashed("plaintextpassword")).toBe(false)
    expect(isPasswordHashed("mypassword12345")).toBe(false)
  })

  it("returns false for a short string that cannot be a hash", () => {
    expect(isPasswordHashed("short")).toBe(false)
    expect(isPasswordHashed("")).toBe(false)
  })

  it("returns true for legacy hashed format (salt:hash, no prefix)", () => {
    const salt = randomBytes(16).toString("hex")
    const hash = createHash("sha256").update(salt + "pw").digest("hex")
    expect(isPasswordHashed(`${salt}:${hash}`)).toBe(true)
  })

  it("returns false for a plaintext password that contains a colon but is not a hash", () => {
    // e.g. "pass:word" — colon not at position 32, so not confused with legacy hash
    expect(isPasswordHashed("pass:word")).toBe(false)
    expect(isPasswordHashed("user:pass")).toBe(false)
  })
})
