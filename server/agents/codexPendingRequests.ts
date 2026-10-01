import type { JsonRpcId } from "./codexAppServerProtocol"

interface PendingServerRequest {
  requestId: JsonRpcId
  threadId: string
  turnId: string | null
  requestedAt: number
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

/** Server requests awaiting an answer, by request id and by the thread that asked. */
export class PendingRequests<T extends PendingServerRequest> {
  private readonly byThread = new Map<string, Map<string, T>>()
  private readonly byRequest = new Map<string, T>()

  get(requestId: JsonRpcId): T | undefined {
    return this.byRequest.get(requestKey(requestId))
  }

  threadIds(): string[] {
    return [...this.byThread.keys()]
  }

  /** Oldest first, across every thread `includesThread` accepts. */
  list(includesThread: (threadId: string) => boolean): T[] {
    return [...this.byThread.entries()]
      .filter(([threadId]) => includesThread(threadId))
      .flatMap(([, requests]) => [...requests.values()])
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  store(request: T): void {
    const key = requestKey(request.requestId)
    this.remove(request.requestId)
    let requests = this.byThread.get(request.threadId)
    if (!requests) {
      requests = new Map()
      this.byThread.set(request.threadId, requests)
    }
    requests.set(key, request)
    this.byRequest.set(key, request)
  }

  remove(requestId: JsonRpcId): void {
    const key = requestKey(requestId)
    const request = this.byRequest.get(key)
    if (!request) return
    this.byRequest.delete(key)
    const requests = this.byThread.get(request.threadId)
    requests?.delete(key)
    if (requests?.size === 0) this.byThread.delete(request.threadId)
  }

  /**
   * The app-server aborts every request a thread still holds when its turn
   * ends, so one it could not tie to a turn goes with whichever turn does.
   */
  removeForTurn(threadId: string, turnId: string): void {
    const requests = this.byThread.get(threadId)
    if (!requests) return
    for (const request of [...requests.values()]) {
      if (request.turnId === turnId || request.turnId === null) this.remove(request.requestId)
    }
  }

  clearThread(threadId: string): void {
    const requests = this.byThread.get(threadId)
    if (!requests) return
    for (const request of requests.values()) {
      this.byRequest.delete(requestKey(request.requestId))
    }
    this.byThread.delete(threadId)
  }

  clear(): void {
    this.byThread.clear()
    this.byRequest.clear()
  }
}
