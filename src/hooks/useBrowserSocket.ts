import { useCallback, useEffect, useRef, useState } from "react"
import { devicePrefix } from "@/lib/device"
import { decodeFrame, type FrameHeader } from "../../shared/browser/frames"
import type {
  BrowserClientMessage,
  BrowserServerMessage,
  BrowserTab,
} from "../../shared/browser/protocol"

/**
 * The viewer half of the `/__browser` transport: one socket per selected
 * browser, JSON state in one direction, JPEG frames in the other. Connect,
 * backoff and teardown mirror `usePtySocket`; the frame path is what differs.
 */

type StatusMessage = Extract<BrowserServerMessage, { type: "status" }>
type PageMessage = Extract<BrowserServerMessage, { type: "page" }>

export type BrowserSocketStatus = "idle" | "connecting" | "connected" | "disconnected"

/**
 * A decoded frame, holding either a bitmap or an object url — never both,
 * never neither. Whoever paints it releases it; see `releaseFrame`.
 */
export interface BrowserFrame {
  bitmap: ImageBitmap | null
  blobUrl: string | null
  header: FrameHeader
}

export interface UseBrowserSocket {
  status: BrowserSocketStatus
  state: StatusMessage | null
  page: PageMessage | null
  tabs: BrowserTab[]
  followed: string | null
  frame: BrowserFrame | null
  lastFrameAt: number | null
  /** Last `error` message from the transport, cleared by the next status. */
  error: string | null
  send: (message: BrowserClientMessage) => void
}

const INITIAL_RECONNECT_DELAY = 500
const MAX_RECONNECT_DELAY = 5000
const NO_TABS: BrowserTab[] = []

function socketUrl(session: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  // devicePrefix() routes the socket to a remote device via the hub proxy
  // ("/hub/<id>/__browser"); "" for the local device.
  const prefix = devicePrefix()
  return `${protocol}//${window.location.host}${prefix}/__browser?session=${encodeURIComponent(session)}`
}

function parseServerMessage(raw: string): BrowserServerMessage | null {
  try {
    return JSON.parse(raw) as BrowserServerMessage
  } catch {
    return null
  }
}

function sameStatus(a: StatusMessage, b: StatusMessage): boolean {
  return a.state === b.state && a.session === b.session && a.message === b.message
}

function samePage(a: PageMessage, b: PageMessage): boolean {
  return a.targetId === b.targetId && a.url === b.url && a.title === b.title
    && a.canGoBack === b.canGoBack && a.canGoForward === b.canGoForward
}

function sameTabs(a: BrowserTab[], b: BrowserTab[]): boolean {
  return a.length === b.length && a.every((tab, index) => (
    tab.targetId === b[index].targetId && tab.url === b[index].url && tab.title === b[index].title
  ))
}

/**
 * A frame holds a decoder resource. The hook frees the frames it never shows;
 * a frame it hands out belongs to whoever paints it, which frees it once it is
 * off screen — a bitmap closed while a paint is still pending throws.
 */
export function releaseFrame(frame: BrowserFrame | null): void {
  if (!frame) return
  frame.bitmap?.close()
  if (frame.blobUrl) URL.revokeObjectURL(frame.blobUrl)
}

/**
 * `onClipboard` carries text the page copied. It is held in a ref, so a caller
 * that re-creates it never reconnects the socket.
 */
export function useBrowserSocket(
  session: string | null,
  onClipboard?: (text: string) => void,
): UseBrowserSocket {
  const [status, setStatus] = useState<BrowserSocketStatus>("idle")
  const [state, setState] = useState<StatusMessage | null>(null)
  const [page, setPage] = useState<PageMessage | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>(NO_TABS)
  const [followed, setFollowed] = useState<string | null>(null)
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const frameRef = useRef<BrowserFrame | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onClipboardRef = useRef(onClipboard)
  useEffect(() => {
    onClipboardRef.current = onClipboard
  }, [onClipboard])

  useEffect(() => {
    setState(null)
    setPage(null)
    setTabs(NO_TABS)
    setFollowed(null)
    setError(null)
    setFrame(null)
    setLastFrameAt(null)

    if (session === null) {
      setStatus("idle")
      return
    }
    const name = session

    // Frames decode asynchronously; `run` is what a late resolution checks
    // itself against, so a torn-down session never paints and never leaks.
    const run = { alive: true, issued: 0, applied: 0 }
    let delay = INITIAL_RECONNECT_DELAY

    // Showing a frame hands its bitmap to the viewer; only a frame nobody ever
    // saw is freed here, plus whatever is still out when the session ends.
    function show(next: BrowserFrame, sequence: number): void {
      if (!run.alive || sequence <= run.applied) {
        releaseFrame(next)
        return
      }
      run.applied = sequence
      frameRef.current = next
      setFrame(next)
      setLastFrameAt(Date.now())
    }

    function receiveFrame(buffer: ArrayBuffer): void {
      let header: FrameHeader
      let blob: Blob
      try {
        const decoded = decodeFrame(new Uint8Array(buffer))
        header = decoded.header
        blob = new Blob([decoded.jpeg], { type: "image/jpeg" })
      } catch {
        return
      }
      const sequence = ++run.issued
      if (typeof createImageBitmap !== "function") {
        show({ bitmap: null, blobUrl: URL.createObjectURL(blob), header }, sequence)
        return
      }
      void createImageBitmap(blob).then(
        (bitmap) => show({ bitmap, blobUrl: null, header }, sequence),
        () => undefined,
      )
    }

    function receiveText(raw: string): void {
      const message = parseServerMessage(raw)
      if (!message) return
      switch (message.type) {
        case "status":
          setState((previous) => (previous && sameStatus(previous, message) ? previous : message))
          setError(null)
          break
        case "page":
          setPage((previous) => (previous && samePage(previous, message) ? previous : message))
          break
        case "tabs":
          setTabs((previous) => (sameTabs(previous, message.tabs) ? previous : message.tabs))
          setFollowed(message.followed)
          break
        case "error":
          setError(message.message)
          break
        case "clipboard":
          onClipboardRef.current?.(message.text)
          break
      }
    }

    function connect(): void {
      if (!run.alive) return
      const existing = wsRef.current
      if (existing && existing.readyState !== WebSocket.CLOSED) return

      setStatus("connecting")
      const ws = new WebSocket(socketUrl(name))
      ws.binaryType = "arraybuffer"
      wsRef.current = ws

      ws.onopen = () => {
        if (!run.alive) {
          ws.close()
          return
        }
        delay = INITIAL_RECONNECT_DELAY
        setStatus("connected")
      }

      ws.onmessage = (event: MessageEvent) => {
        if (!run.alive) return
        if (typeof event.data === "string") receiveText(event.data)
        else if (event.data instanceof ArrayBuffer) receiveFrame(event.data)
      }

      ws.onclose = () => {
        if (!run.alive) return
        wsRef.current = null
        setStatus("disconnected")
        const wait = delay
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY)
        reconnectTimerRef.current = setTimeout(connect, wait)
      }
    }

    connect()

    return () => {
      run.alive = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onclose = null
        ws.close()
      }
      releaseFrame(frameRef.current)
      frameRef.current = null
    }
  }, [session])

  const send = useCallback((message: BrowserClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }, [])

  return { status, state, page, tabs, followed, frame, lastFrameAt, error, send }
}
