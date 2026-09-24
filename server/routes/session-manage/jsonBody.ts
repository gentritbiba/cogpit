import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpBodyError, readJsonBody, sendJson } from "../../http"
import { sendAgentError } from "../agentErrors"

/**
 * Read a JSON body and hand it to `handleBody`. An oversized body gets its 413;
 * any other unreadable body goes to `handleReadError`, and a handler that throws
 * before answering gets the agent error response.
 */
export function handleJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  handleBody: (body: T) => void | Promise<void>,
  handleReadError: (error: unknown) => void,
  options: { allowEmpty?: boolean } = {},
): void {
  void (async () => {
    let body: T
    try {
      body = await readJsonBody<T>(req, options)
    } catch (error) {
      if (error instanceof HttpBodyError && error.statusCode === 413) {
        sendJson(res, error.statusCode, { error: error.message })
      } else {
        handleReadError(error)
      }
      return
    }

    try {
      await handleBody(body)
    } catch (error) {
      if (!res.headersSent) sendAgentError(res, error, "Request failed")
    }
  })()
}
