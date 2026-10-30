// @vitest-environment node
import { describe, expect, it } from "vitest"
import { tokenize } from "../shiki-engine"

describe("worker Shiki engine", () => {
  it("preserves content and colors with language aliases and both themes", async () => {
    const code = 'const answer: number = 42\nconsole.log("😀", answer)'
    const dark = await tokenize(code, "ts", true)
    const light = await tokenize(code, "typescript", false)
    expect(dark?.map(line => line.map(token => token.content).join("")).join("\n")).toBe(code)
    expect(light?.map(line => line.map(token => token.content).join("")).join("\n")).toBe(code)
    expect(dark?.[0][0].color).not.toBe(light?.[0][0].color)
  })
  it("loads non-default grammars and leaves unknown languages plain", async () => {
    const rust = await tokenize('fn main() { println!("hello"); }', "rust", true)
    expect(rust?.[0].some(token => token.color)).toBe(true)
    expect(await tokenize("hello", "not-a-language", true)).toBeNull()
  })
})
