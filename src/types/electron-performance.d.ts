import type { ElectronPerformanceSnapshot } from "../../shared/contracts/performance"

declare global {
  interface Window {
    electronPerformance?: {
      getSnapshot: () => Promise<ElectronPerformanceSnapshot>
    }
  }
}

export {}
