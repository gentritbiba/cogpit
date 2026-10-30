import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Mic, Square, X } from "lucide-react"
import type { PluginConnectionStatus } from "@cogpit/plugin-contracts"
import type { InstalledPlugin } from "../../shared/contracts/plugins"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/Spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PluginRequestError } from "./runtimeClient"
import { useComposerPlugins } from "./RuntimePluginActions"
import { DictationWaveform } from "./dictation/DictationWaveform"
import { canRecord, MAX_DICTATION_SECONDS, startRecording, type Recording } from "./dictation/recorder"

export type DictationState =
  | { status: "idle" | "starting" | "recording" | "transcribing" }
  | { status: "failed"; message: string; retry: boolean }

export interface ComposerDictation {
  title: string
  state: DictationState
  start(): void
  /** Stops recording and hands the transcript to the composer, which sends it when `send` is set. */
  finish(send: boolean): void
  /** Discards the take, or dismisses a failure. */
  cancel(): void
  retry(): void
  level(): number
}

interface Take { abort: AbortController; recording?: Recording; wav?: Blob; send: boolean; timer?: ReturnType<typeof setTimeout> }
type Runtime = NonNullable<ReturnType<typeof useComposerPlugins>>["runtime"]

async function withLease<T>(runtime: Runtime, plugin: InstalledPlugin, signal: AbortSignal, run: (leaseId: string) => Promise<T>): Promise<T> {
  const lease = await runtime.client.lease(plugin.id, runtime.project?.id ?? null, crypto.randomUUID(), signal, runtime.project ? runtime.workspacePath : null)
  try { return await run(lease.id) }
  finally { void runtime.client.revokeLease(lease.id).catch(() => {}) }
}

function microphoneFailure(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow Cogpit to use the microphone, then try again."
  if (name === "NotFoundError") return "No microphone was found."
  if (name === "NotReadableError") return "Another app is using the microphone."
  return "The microphone could not be started."
}

/**
 * Dictation for the composer, provided by the first enabled plugin that declares it. Cogpit records the
 * microphone itself, because plugin frames are sandboxed without an origin and cannot; the plugin only
 * names the service that turns the recording into text.
 */
export function useComposerDictation(onTranscript: (text: string, send: boolean) => void): ComposerDictation | null {
  const composer = useComposerPlugins()
  const plugin = composer && canRecord() ? composer.plugins.find(candidate => candidate.manifest.contributes.dictation) : undefined
  const [state, setState] = useState<DictationState>({ status: "idle" })
  const take = useRef<Take | null>(null)
  const latest = useRef({ runtime: composer?.runtime, plugin, onTranscript })
  useLayoutEffect(() => { latest.current = { runtime: composer?.runtime, plugin, onTranscript } })

  const end = useCallback((next: DictationState = { status: "idle" }) => {
    const current = take.current
    take.current = null
    if (current) { current.abort.abort(); clearTimeout(current.timer); current.recording?.cancel() }
    setState(next)
  }, [])
  const transcribe = useCallback((current: Take) => {
    const { runtime, plugin } = latest.current
    if (!runtime || !plugin || !current.wav) return
    setState({ status: "transcribing" })
    void withLease(runtime, plugin, current.abort.signal, leaseId => runtime.client.dictate(leaseId, current.wav!, current.abort.signal)).then(text => {
      if (take.current !== current) return
      take.current = null
      if (!text.trim()) { setState({ status: "failed", message: "No speech was heard.", retry: false }); return }
      setState({ status: "idle" })
      latest.current.onTranscript(text.trim(), current.send)
    }, (error: unknown) => {
      if (take.current !== current) return
      const code = error instanceof PluginRequestError ? error.code : ""
      setState({ status: "failed", retry: true, message: code === "CONNECTION_REQUIRED" || code === "RESOURCE_REQUIRED" ? `Connect the speech service in Plugins, under ${plugin.manifest.name}.`
        : code === "RATE_LIMITED" ? "Too many recordings are being transcribed. Try again in a moment."
        : code === "INVALID_RESPONSE" ? "The speech service returned no transcript."
        : "The speech service didn't answer. Try again." })
    })
  }, [])
  const finish = useCallback((send: boolean) => {
    const current = take.current
    const recording = current?.recording
    if (!current || !recording) return
    clearTimeout(current.timer)
    current.recording = undefined
    current.send = send
    setState({ status: "transcribing" })
    recording.stop().then(wav => {
      if (take.current !== current) return
      current.wav = wav
      transcribe(current)
    }, () => { if (take.current === current) end({ status: "failed", message: "Nothing was recorded.", retry: false }) })
  }, [end, transcribe])
  const start = useCallback(() => {
    const { runtime, plugin } = latest.current
    const dictation = plugin?.manifest.contributes.dictation
    if (take.current || !runtime || !plugin || !dictation) return
    const current: Take = { abort: new AbortController(), send: false }
    take.current = current
    setState({ status: "starting" })
    const configured = withLease(runtime, plugin, current.abort.signal, leaseId => runtime.client.call(leaseId,
      { protocol: 1, type: "request", id: "dictation", method: "connections.status", params: { handle: dictation.connection } }, current.abort.signal))
      .then(status => (status as PluginConnectionStatus).configured, () => true)
    startRecording().then(async recording => {
      const ready = await configured
      if (take.current !== current) { recording.cancel(); return }
      if (!ready) { recording.cancel(); end({ status: "failed", message: `Connect the speech service in Plugins, under ${plugin.manifest.name}.`, retry: false }); return }
      current.recording = recording
      current.timer = setTimeout(() => finish(false), MAX_DICTATION_SECONDS * 1000)
      setState({ status: "recording" })
    }, (error: unknown) => { if (take.current === current) end({ status: "failed", message: microphoneFailure(error), retry: false }) })
  }, [end, finish])
  const retry = useCallback(() => { if (take.current?.wav) transcribe(take.current) }, [transcribe])
  const level = useCallback(() => take.current?.recording?.level() ?? 0, [])

  // A different host, user, plugin version, project or session must not receive this take.
  const target = plugin && composer ? JSON.stringify([composer.runtime.activation, plugin.id, plugin.selectedDigest, composer.runtime.project?.id, composer.sessionId]) : ""
  useEffect(() => () => end(), [target, end])
  const cancel = useCallback(() => end(), [end])

  const dictation = plugin?.manifest.contributes.dictation
  return dictation ? { title: dictation.title, state, start, finish, cancel, retry, level } : null
}

export function DictationButton({ dictation, onStart }: { dictation: ComposerDictation; onStart?: () => void }) {
  return <Tooltip>
    <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground hover:text-foreground"
      aria-label={dictation.title} onClick={() => { dictation.start(); onStart?.() }} />}>
      <Mic data-icon="inline-start" />
    </TooltipTrigger>
    <TooltipContent>{dictation.title}</TooltipContent>
  </Tooltip>
}

/** Replaces the composer's plugin buttons while a take is in progress: level meter, then Stop (insert). Send is the composer's own button. */
export function DictationBar({ dictation }: { dictation: ComposerDictation }) {
  const { state } = dictation
  if (state.status === "idle") return null
  if (state.status === "failed") return <div role="alert" className="flex min-w-0 items-center gap-1 text-xs text-destructive">
    <span className="max-w-64 truncate" title={state.message}>{state.message}</span>
    {state.retry && <Button type="button" size="xs" variant="ghost" onClick={dictation.retry}>Retry</Button>}
    <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label="Dismiss" onClick={dictation.cancel}><X data-icon="icon" /></Button>
  </div>
  return <div className="flex items-center gap-2">
    <span role="status" className="sr-only">{state.status === "transcribing" ? "Transcribing" : "Recording"}</span>
    {state.status === "transcribing"
      ? <span className="flex h-6 w-28 items-center justify-center gap-1.5 text-xs text-muted-foreground"><Spinner className="size-3" />Transcribing</span>
      : <DictationWaveform level={dictation.level} />}
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="secondary" size="icon-sm" className="rounded-full" disabled={state.status !== "recording"}
        aria-label="Stop and insert text" onClick={() => dictation.finish(false)} />}>
        <Square data-icon="inline-start" className="fill-current" />
      </TooltipTrigger>
      <TooltipContent>Stop and insert text · Esc discards</TooltipContent>
    </Tooltip>
  </div>
}
