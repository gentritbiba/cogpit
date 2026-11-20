import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { BaseSequencer, type TestSpecification } from "vitest/node"

/** Seconds each test file took in a full run; `bun scripts/update-test-durations.ts` rewrites it. */
export const TEST_DURATIONS_FILE = "build/testDurations.json"

/**
 * Splits `--shard` runs by how long their files take, not by how many there
 * are. Vitest's own split gives each shard an equal count, and a few files
 * take a minute on a CI runner, so one shard used to run three times as long
 * as another. Every shard sorts the same files the same way, so their parts
 * still cover the suite exactly once.
 */
export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config
    if (!shard) return files
    const durations = JSON.parse(readFileSync(join(root, TEST_DURATIONS_FILE), "utf8")) as Record<string, number>
    // A file the table does not know (new, or the edition's) counts as an average one.
    const known = Object.values(durations)
    const typical = known.length > 0 ? known.reduce((sum, seconds) => sum + seconds, 0) / known.length : 1
    const weighed = files.map((spec) => {
      const path = relative(root, spec.moduleId).replaceAll("\\", "/")
      return { spec, key: `${spec.project.name}:${path}`, seconds: durations[path] ?? typical }
    })
    // Longest first onto the least loaded shard keeps the longest shard short.
    weighed.sort((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const loads = new Array<number>(shard.count).fill(0)
    const mine: TestSpecification[] = []
    for (const { spec, seconds } of weighed) {
      const lightest = loads.indexOf(Math.min(...loads))
      loads[lightest]! += seconds
      if (lightest === shard.index - 1) mine.push(spec)
    }
    return mine
  }
}
