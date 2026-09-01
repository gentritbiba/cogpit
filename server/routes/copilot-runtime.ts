import type { ServerResponse } from "node:http"
import {
  copilotRuntime,
  type CopilotRuntime,
} from "../copilot-runtime"
import { sendJson, type UseFn } from "../http"

export type CopilotRuntimeClient = Pick<CopilotRuntime, "getAccountQuota">

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleRuntime(
  res: ServerResponse,
  runtime: CopilotRuntimeClient,
): Promise<void> {
  let quota
  try {
    quota = await runtime.getAccountQuota()
  } catch (error) {
    sendJson(res, 200, {
      available: false,
      quota: null,
      errors: { runtime: errorMessage(error) },
    })
    return
  }

  sendJson(res, 200, {
    available: true,
    quota,
    errors: {},
  })
}

export function registerCopilotRuntimeRoutes(
  use: UseFn,
  runtime: CopilotRuntimeClient = copilotRuntime,
): void {
  use("/api/copilot/runtime", (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()
    void handleRuntime(res, runtime)
  })
}
