import { useEffect } from "react"
import { reportUiFeature } from "@/lib/telemetry"
import type { UiFeature } from "../../shared/contracts/telemetry"

/** Count `feature` each time it opens. */
export function useReportFeature(feature: UiFeature | undefined, open: boolean): void {
  useEffect(() => {
    if (feature && open) reportUiFeature(feature)
  }, [feature, open])
}
