import { useEffect, useRef, useState } from "react"
import { Volume2 } from "lucide-react"
import { evaluateCompatibility } from "@cogpit/plugin-contracts"
import { useSessionChatContextOptional, useSessionContextOptional } from "@/contexts/SessionContext"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/Spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clientRuntimeDescriptor } from "./runtimeClient"
import { useRuntimeContributions } from "./RuntimePluginContributions"

/** Enabled, compatible plugins that may add controls to the open session's composer, or null when none may. */
export function useComposerPlugins() {
  const runtime = useRuntimeContributions()
  const session = useSessionContextOptional()
  const chat = useSessionChatContextOptional()
  const sessionId = session?.session?.sessionId
  const status = runtime?.status
  if (!runtime?.activation || !status?.store.available || status.safeMode || !chat || !sessionId || session?.permissions.send === false) return null
  const plugins = status.store.plugins.filter(plugin => plugin.enabled
    && (plugin.scope.type === "all" || !!runtime.project && plugin.scope.projectIds.includes(runtime.project.id))
    && evaluateCompatibility(plugin.manifest, clientRuntimeDescriptor(), status.runtime, { allowPrerelease: plugin.manifest.publisher.startsWith("dev-") }).compatible)
  return { runtime, chat: chat.chat, sessionId, plugins }
}
type ComposerPlugins = NonNullable<ReturnType<typeof useComposerPlugins>>

export function RuntimePluginActions() {
  const composer = useComposerPlugins()
  return composer ? <PluginActions composer={composer} /> : null
}

function PluginActions({ composer }: { composer: ComposerPlugins }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef({ epoch: 0, locked: false })
  const { chat, sessionId, runtime: { activation } } = composer
  useEffect(() => { const state = request.current; state.epoch++; state.locked = false; setBusy(null); setError(null); return () => { state.epoch++; state.locked = false } }, [sessionId, activation])
  const actions = composer.plugins.flatMap(plugin => (plugin.manifest.contributes.sessionActions ?? []).map(action => ({ ...action, key: `${plugin.id}:${action.id}` })))
  if (!actions.length) return null
  const disabled = !!busy
  async function invoke(action: typeof actions[number]) {
    const state = request.current
    if (disabled || state.locked) return
    state.locked = true
    const id = ++state.epoch
    setBusy(action.key); setError(null)
    try { if (!await chat.sendMessage(action.prompt) && state.epoch === id) setError("The request could not be sent. Try again when the session is ready.") }
    catch { if (state.epoch === id) setError("The request could not be sent.") }
    finally { if (state.epoch === id) { state.locked = false; setBusy(null) } }
  }
  return <div className="flex flex-wrap items-center gap-1">
    {actions.map(action => action.icon
      ? <Tooltip key={action.key}>
          <TooltipTrigger render={<Button type="button" size="icon-sm" variant="ghost" className="rounded-full text-muted-foreground hover:text-foreground"
            disabled={disabled} aria-busy={busy === action.key} aria-label={action.title} onClick={() => { void invoke(action) }} />}>
            {busy === action.key ? <Spinner className="size-4" /> : <Volume2 data-icon="inline-start" />}
          </TooltipTrigger>
          <TooltipContent>{action.title}</TooltipContent>
        </Tooltip>
      : <Button key={action.key} type="button" size="xs" variant="ghost" className="text-muted-foreground hover:text-foreground" disabled={disabled} aria-busy={busy === action.key} onClick={() => { void invoke(action) }}>{busy === action.key ? "Sending…" : action.title}</Button>)}
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
  </div>
}
