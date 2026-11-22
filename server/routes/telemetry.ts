/**
 * `POST /api/telemetry/feature` — a feature only the renderer sees was used.
 * Only names from `UI_FEATURES` are counted; anything else is refused.
 */
import { isUiFeature } from "../../shared/contracts/telemetry"
import { isRecord } from "../../shared/objects"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { recordTelemetry } from "../telemetry"
import { clientSurface } from "../telemetry/events"

export function registerTelemetryRoutes(use: UseFn) {
  use("/api/telemetry/feature", (req, res, next) => {
    const path = (req.url ?? "").split("?")[0]
    if (req.method !== "POST" || (path !== "" && path !== "/")) return next()
    withJsonBody<unknown>(req, res, (body) => {
      const feature = isRecord(body) ? body.feature : undefined
      if (!isUiFeature(feature)) {
        sendJson(res, 400, { error: "Unknown feature" })
        return
      }
      recordTelemetry("feature.used", { feature, client: clientSurface(req) })
      sendJson(res, 200, { recorded: true })
    })
  })
}
