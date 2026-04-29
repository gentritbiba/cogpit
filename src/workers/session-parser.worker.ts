import { parseSession, parseSessionAppend } from "@/lib/parser"
import type { ParsedSession } from "@/lib/types"

export type WorkerRequest =
  | { type: "parse"; id: number; text: string }
  | { type: "append"; id: number; existing: ParsedSession; newText: string }

export type WorkerResponse =
  | { type: "result"; id: number; session: ParsedSession }
  | { type: "error"; id: number; error: string }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    let session: ParsedSession
    if (msg.type === "parse") {
      session = parseSession(msg.text)
    } else {
      session = parseSessionAppend(msg.existing, msg.newText)
    }
    self.postMessage({ type: "result", id: msg.id, session } satisfies WorkerResponse)
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
}
