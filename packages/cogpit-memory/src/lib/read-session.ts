import { parseSession } from "./parser"
import { scopeParsedSession } from "./instances"
import { storeForPath } from "./stores"

export function parseTranscript(content: string, filePath: string) {
  return scopeParsedSession(parseSession(content), storeForPath(filePath)?.instanceId ?? "default")
}
