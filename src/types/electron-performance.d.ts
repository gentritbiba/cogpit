import type { ElectronPerformanceSnapshot } from "@/lib/performanceTypes"

declare global {
  interface Window {
    electronPerformance?: {
      getSnapshot: () => Promise<ElectronPerformanceSnapshot>
    }
  }
}

export {}
