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
  // The newest regex target ran this call into the text around it in V8; Oniguruma and ES2018 split it out.
  it("tokenizes a CSS function call inside a keyframe as the function it is", async () => {
    const lines = await tokenize("@keyframes rise {\n  from { transform: translate3d(0, 4px, 0); }\n}", "css", true)
    expect(lines?.[1].map(token => token.content)).toContain("translate3d")
  })
  it("keeps a YAML comment holding non-ASCII text one comment", async () => {
    const lines = await tokenize("# Deploy — prod 🚀\nkey: value", "yaml", true)
    expect(lines?.[0].map(token => token.content)).toEqual(["# Deploy — prod 🚀"])
  })
  it("loads non-default grammars and leaves unknown languages plain", async () => {
    const rust = await tokenize('fn main() { println!("hello"); }', "rust", true)
    expect(rust?.[0].some(token => token.color)).toBe(true)
    expect(await tokenize("hello", "not-a-language", true)).toBeNull()
  })
})
