// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CORE_PRINCIPAL_HEADER, CORE_PROTOCOL_VERSION, CORE_SECRET_HEADER, parseHandshake } from "../../core/protocol"

const rustProtocol = readFileSync(join(__dirname, "../../../crates/core-protocol/src/lib.rs"), "utf8")

function rustConstant(name: string): string {
  const match = new RegExp(`pub const ${name}: [^=]+= "?([^";]+)"?;`).exec(rustProtocol)
  if (!match) throw new Error(`${name} is not in core-protocol`)
  return match[1]
}

describe("core protocol", () => {
  it("matches the Rust contract", () => {
    expect(rustConstant("SECRET_HEADER")).toBe(CORE_SECRET_HEADER)
    expect(rustConstant("PRINCIPAL_HEADER")).toBe(CORE_PRINCIPAL_HEADER)
    expect(Number(rustConstant("PROTOCOL_VERSION"))).toBe(CORE_PROTOCOL_VERSION)
  })

  it("refuses a handshake from another protocol version", () => {
    expect(parseHandshake(`{"port":1,"version":"0.1.0","protocol":${CORE_PROTOCOL_VERSION}}`).port).toBe(1)
    expect(() => parseHandshake(`{"port":1,"version":"0.0.9","protocol":${CORE_PROTOCOL_VERSION + 1}}`))
      .toThrow(/bun run build:core/)
    expect(() => parseHandshake("listening")).toThrow(/unreadable/)
    expect(() => parseHandshake(`{"port":0,"version":"0.1.0","protocol":1}`)).toThrow(/invalid/)
  })
})
