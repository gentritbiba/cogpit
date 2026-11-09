/** Measured row heights, kept outside React so they outlive the list and session switches. */

export function widthBucket(width: number): number {
  return Math.round(width / 16)
}

function layoutKey(bucket: number, expandAll: boolean): string {
  return `${bucket}|${expandAll ? 1 : 0}`
}

export class SessionHeights {
  private readonly entries = new Map<string, { height: number; layout: string }>()
  private readonly totals = new Map<string, { sum: number; count: number }>()

  constructor(private readonly maxRows: number) {}

  get(rowKey: string, bucket: number, expandAll: boolean): number | undefined {
    return this.entries.get(`${rowKey}|${layoutKey(bucket, expandAll)}`)?.height
  }

  set(rowKey: string, bucket: number, expandAll: boolean, height: number): void {
    const layout = layoutKey(bucket, expandAll)
    const key = `${rowKey}|${layout}`
    this.remove(key)
    this.entries.set(key, { height, layout })
    const total = this.totals.get(layout) ?? { sum: 0, count: 0 }
    total.sum += height
    total.count++
    this.totals.set(layout, total)
    if (this.entries.size > this.maxRows) this.remove(this.entries.keys().next().value as string)
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    const total = this.totals.get(entry.layout)!
    total.sum -= entry.height
    total.count--
  }

  /** Mean measured height for this layout, the estimate for rows never measured. */
  average(bucket: number, expandAll: boolean): number | undefined {
    const total = this.totals.get(layoutKey(bucket, expandAll))
    return total && total.count > 0 ? total.sum / total.count : undefined
  }
}

export class HeightCache {
  private readonly sessions = new Map<string, SessionHeights>()

  constructor(private readonly maxSessions = 20, private readonly maxRows = 5000) {}

  forSession(sessionKey: string): SessionHeights {
    let heights = this.sessions.get(sessionKey)
    if (heights) this.sessions.delete(sessionKey)
    else heights = new SessionHeights(this.maxRows)
    this.sessions.set(sessionKey, heights)
    if (this.sessions.size > this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value as string)
    }
    return heights
  }
}

export const timelineHeights = new HeightCache()

/** Heights of items inside windowed rows (blocks of a giant turn, calls of a long group). */
export const blockHeights = new HeightCache(20, 20000)
