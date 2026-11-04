// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest"
import { publishTurnError } from "../../agents/codexAppServer"
import { _resetForTests, subscribe, type StreamBusEvent } from "../../lib/streamBus"

const THREAD_ID = "019fff00-1111-7222-8333-444444444444"

function errorsFor(error: unknown): StreamBusEvent[] {
  const events: StreamBusEvent[] = []
  subscribe(THREAD_ID, (event) => events.push(event))
  publishTurnError({ method: "error", params: { threadId: THREAD_ID, error } })
  return events
}

beforeEach(() => _resetForTests())

describe("publishTurnError", () => {
  it("forwards app-server errors to the watching client", () => {
    expect(errorsFor({ message: "response stream disconnected" })).toContainEqual({
      type: "turn_error",
      message: "response stream disconnected",
    })
  })

  it("names a missing login while Codex is still retrying it", () => {
    expect(errorsFor({
      message: "Reconnecting... 2/5",
      additionalDetails: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } },
    })).toContainEqual({ type: "turn_error", message: "Codex isn't signed in." })
  })

  it("ignores notifications that are not errors", () => {
    const events: StreamBusEvent[] = []
    subscribe(THREAD_ID, (event) => events.push(event))
    publishTurnError({ method: "turn/completed", params: { threadId: THREAD_ID } })
    expect(events.filter((event) => event.type === "turn_error")).toEqual([])
  })
})
