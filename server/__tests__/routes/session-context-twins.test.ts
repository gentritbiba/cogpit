import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * `server/routes/session-context.ts` and `packages/cogpit-memory/src/commands/context.ts`
 * serialize the same `Turn` into the same JSON for two different callers — the
 * HTTP API and the CLI. Unlike `shared/session/`, neither generates the other:
 * `check:cogpit-memory-sync` does not cover them, and they are kept in step by
 * hand.
 *
 * Each suite pins its own output, so a field added to one and forgotten in the
 * other passes both. Verified: adding `queuedBy` to the server's `queued_prompt`
 * case alone leaves `bun run test` and the cogpit-memory suite green. The
 * `agent_message` case is exactly pinned on both sides and would have been
 * caught; the other nine block kinds are not.
 *
 * So compare the serializers themselves. They are byte-identical today apart
 * from one comment, which is the invariant worth holding: a change to how a
 * block is shaped has to land in both copies, or this test says which one was
 * missed.
 */

// Vitest runs from the repo root, so the two copies resolve off the cwd.
const SERVER_COPY = "server/routes/session-context.ts"
const MEMORY_COPY = "packages/cogpit-memory/src/commands/context.ts"

/** Every function that turns a `Turn` into response JSON. */
const SERIALIZERS = ["mapSubAgentSummary", "mapSubAgentDetail", "mapToolCall", "mapContentBlock"]

/** A top-level `function <name>(…) { … }`, brace-matched to its close. */
function readFunction(relativePath: string, name: string): string {
  const source = readFileSync(resolve(process.cwd(), relativePath), "utf8")
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} not found in ${relativePath}`).toBeGreaterThan(-1)

  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unterminated ${name} in ${relativePath}`)
}

/** Prose is free to differ between the two copies; the emitted shape is not. */
function shapeOnly(fn: string): string[] {
  return fn
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
}

describe("session-context serializers are hand-maintained twins", () => {
  for (const name of SERIALIZERS) {
    it(`${name} emits the same shape in both copies`, () => {
      expect(shapeOnly(readFunction(MEMORY_COPY, name)))
        .toEqual(shapeOnly(readFunction(SERVER_COPY, name)))
    })
  }
})
