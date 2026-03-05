// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { SearchIndex } from "../search-index"
import { unlinkSync } from "node:fs"

const TEST_DB = "/tmp/test-search-index.db"

describe("SearchIndex", () => {
  afterEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    try { unlinkSync(TEST_DB + "-wal") } catch {}
    try { unlinkSync(TEST_DB + "-shm") } catch {}
  })

  describe("constructor", () => {
    it("creates database with correct schema", () => {
      const index = new SearchIndex(TEST_DB)
      const stats = index.getStats()
      expect(stats.indexedFiles).toBe(0)
      expect(stats.totalRows).toBe(0)
      index.close()
    })
  })
})
