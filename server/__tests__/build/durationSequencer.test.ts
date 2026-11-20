import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { TestSpecification } from "vitest/node"
import { DurationSequencer, TEST_DURATIONS_FILE } from "../../../build/durationSequencer"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-duration-sequencer-"))
  mkdirSync(join(root, "build"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function spec(path: string): TestSpecification {
  return { moduleId: join(root, path), project: { name: "node" } } as unknown as TestSpecification
}

function paths(specs: TestSpecification[]): string[] {
  return specs.map((each) => each.moduleId.slice(root.length + 1).replaceAll("\\", "/")).sort()
}

async function split(durations: Record<string, number>, files: string[], count: number): Promise<string[][]> {
  writeFileSync(join(root, TEST_DURATIONS_FILE), JSON.stringify(durations))
  const shards: string[][] = []
  for (let index = 1; index <= count; index++) {
    const sequencer = new DurationSequencer({ config: { root, shard: { index, count } } } as never)
    shards.push(paths(await sequencer.shard(files.map(spec))))
  }
  return shards
}

describe("DurationSequencer", () => {
  it("gives every file to exactly one shard", async () => {
    const files = Array.from({ length: 23 }, (_, n) => `server/${n}.test.ts`)
    const shards = await split({}, files, 4)
    expect(shards.flat().sort()).toEqual([...files].sort())
  })

  it("balances by recorded seconds rather than by file count", async () => {
    const shards = await split(
      { "slow.test.ts": 60, "a.test.ts": 20, "b.test.ts": 20, "c.test.ts": 20 },
      ["slow.test.ts", "a.test.ts", "b.test.ts", "c.test.ts"],
      2,
    )
    expect(shards).toEqual([["slow.test.ts"], ["a.test.ts", "b.test.ts", "c.test.ts"]])
  })

  it("weighs a file it has no record of like a typical one", async () => {
    const shards = await split(
      { "a.test.ts": 1, "b.test.ts": 1, "c.test.ts": 1, "d.test.ts": 1 },
      ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "new.test.ts", "newer.test.ts"],
      2,
    )
    expect(shards.map((shard) => shard.length)).toEqual([3, 3])
  })

  it("leaves an unsharded run alone", async () => {
    const files = ["a.test.ts", "b.test.ts"].map(spec)
    const sequencer = new DurationSequencer({ config: { root, shard: undefined } } as never)
    expect(await sequencer.shard(files)).toBe(files)
  })
})
