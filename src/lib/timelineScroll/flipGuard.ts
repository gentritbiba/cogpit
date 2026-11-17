/**
 * Plan changes allowed in one browser task. A plan change re-renders inside
 * the commit that caused it, and React gives up after 50 such nested updates
 * (error #185), so a plan that keeps flipping waits for the next frame instead.
 */
const MAX_CHANGES_PER_TASK = 12

export class FlipGuard {
  private changes = 0
  private resetQueued = false
  private frame: number | null = null

  /** True when a plan change may publish now; otherwise `retry` runs on the next frame. */
  allow(retry: () => void): boolean {
    if (!this.resetQueued) {
      this.resetQueued = true
      setTimeout(() => {
        this.changes = 0
        this.resetQueued = false
      })
    }
    if (++this.changes <= MAX_CHANGES_PER_TASK) return true
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null
      retry()
    })
    return false
  }
}
