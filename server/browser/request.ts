import type { BrowserRequest, BrowserRequestResult } from "../../shared/browser/types"
import { MAX_URL_LENGTH } from "../../shared/browser/protocol"
import { isRecord } from "../../shared/objects"
import { CdpConnection } from "./cdp"
import { isRunning, readDevToolsEndpoint } from "./daemons"
import { assertNamedBrowser } from "./paths"

export class BrowserRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = "BrowserRequestError"
  }
}

export function parseBrowserRequest(body: Record<string, unknown>): BrowserRequest {
  if (typeof body.url !== "string" || body.url.length > MAX_URL_LENGTH) {
    throw new BrowserRequestError("url must be an absolute HTTP(S) URL", 400)
  }
  let url: URL
  try {
    url = new URL(body.url)
  } catch {
    throw new BrowserRequestError("url must be an absolute HTTP(S) URL", 400)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new BrowserRequestError("url must use HTTP(S) without embedded credentials", 400)
  }
  if (body.method !== undefined && body.method !== "GET" && body.method !== "HEAD") {
    throw new BrowserRequestError("method must be GET or HEAD", 400)
  }
  if (body.targetId !== undefined && (typeof body.targetId !== "string" || !body.targetId || body.targetId.length > 200)) {
    throw new BrowserRequestError("targetId must be a nonempty tab ID", 400)
  }
  if (Object.keys(body).some((key) => !["url", "method", "targetId"].includes(key))) {
    throw new BrowserRequestError("Only url, method and targetId are supported", 400)
  }
  url.hash = ""
  return { url: url.href, method: body.method ?? "GET", targetId: body.targetId }
}

interface RequestDeps {
  isRunning: typeof isRunning
  endpoint: typeof readDevToolsEndpoint
  connect: (url: string) => Promise<Pick<CdpConnection, "send" | "close">>
}

const defaultDeps: RequestDeps = {
  isRunning,
  endpoint: readDevToolsEndpoint,
  connect: (url) => CdpConnection.connect(url),
}

interface Target {
  targetId: string
  type: string
  url: string
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function requestExpression(request: BrowserRequest): string {
  // Runs in an isolated world so a site's replacement of window.fetch cannot intercept it.
  return `(async () => {
    const url = ${JSON.stringify(request.url)};
    if (location.origin !== new URL(url).origin) return { error: "The tab changed origin. Open the requested site and retry." };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: ${JSON.stringify(request.method)},
        credentials: "same-origin", mode: "same-origin", redirect: "manual",
        cache: "no-store", signal: controller.signal
      });
      const state = response.type === "opaqueredirect" ? "navigation-required"
        : response.headers.get("cf-mitigated") === "challenge" ? "challenge-required" : "complete";
      const metadata = { state, url: response.url || url, status: response.status,
        headers: Object.fromEntries(response.headers) };
      if (state !== "complete") {
        controller.abort();
        return { ...metadata, body: "", truncated: false };
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let body = "", bytes = 0, truncated = false;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = 2 * 1024 * 1024 - bytes;
          body += decoder.decode(value.subarray(0, remaining), { stream: true });
          bytes += value.length;
          if (bytes > 2 * 1024 * 1024) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
        body += decoder.decode();
      }
      return { ...metadata, body, truncated };
    } catch (error) {
      return { error: controller.signal.aborted ? "Browser request timed out after 8 seconds"
        : "Browser request failed. Check the tab, network and site policy." };
    } finally {
      clearTimeout(timer);
    }
  })()`
}

export async function requestInBrowser(
  name: string,
  input: BrowserRequest,
  deps: RequestDeps = defaultDeps,
): Promise<BrowserRequestResult> {
  assertNamedBrowser(name)
  const request = parseBrowserRequest(input as unknown as Record<string, unknown>)
  const origin = new URL(request.url).origin
  if (!await deps.isRunning(name)) throw new BrowserRequestError(`Open the ${name} browser first`, 409)
  const endpoint = deps.endpoint(name)
  if (!endpoint) throw new BrowserRequestError(`The ${name} browser is unavailable`, 409)
  const connection = await deps.connect(endpoint.browserWsUrl)
  try {
    const { targetInfos } = await connection.send<{ targetInfos: Target[] }>("Target.getTargets")
    const targets = targetInfos.filter((target) => target.type === "page"
      && originOf(target.url) === origin
      && (request.targetId === undefined || request.targetId === target.targetId))
    if (targets.length !== 1) {
      throw new BrowserRequestError(targets.length === 0
        ? `Open ${origin} in the ${name} browser and complete any human verification first`
        : "Several tabs match this origin. Supply targetId to choose one", 409)
    }
    const target = targets[0]
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId, flatten: true,
    })
    const { frameTree } = await connection.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId)
    const { executionContextId } = await connection.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id, worldName: "cogpit-browser-request",
    }, sessionId)
    const evaluated = await connection.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression: requestExpression(request), contextId: executionContextId,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    const value = evaluated.result?.value
    if (evaluated.exceptionDetails || !isRecord(value)) {
      throw new BrowserRequestError("The browser could not complete the request. Check the selected tab", 502)
    }
    if (typeof value.error === "string") throw new BrowserRequestError(value.error, 502)
    return { ...value, browser: name, targetId: target.targetId } as BrowserRequestResult
  } finally {
    connection.close()
  }
}
