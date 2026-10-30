import { useEffect, useId, useRef, useState } from "react"
import type { ReviewStartRequest } from "@cogpit/plugin-contracts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { WorktreeSetupPanel } from "@/components/WorktreeSetupPanel"
import { useModelOptions } from "@/hooks/useModelOptions"
import { authFetch } from "@/lib/auth"
import { AGENT_KINDS, DEFAULT_AGENT_KIND, descriptorFor, type AgentKind } from "@/lib/agents"
import type { ReviewSessionInput } from "./runtimeClient"

const INPUT = "w-full rounded border bg-background px-2 py-1 text-sm"
const WORKTREE_AGENTS = AGENT_KINDS.filter((kind) => descriptorFor(kind).capabilities.worktrees)

/**
 * The host's confirmation for a plugin's `review.start` (item 9): the user
 * picks the provider, and for "Work on PR" what to do; the host checks out
 * the pinned head in a new worktree and waits for its setup before the
 * agent's first prompt. Cancelling keeps the worktree.
 */
export function ReviewSessionDialog({ pluginName, request, projectPath, start, onStarted, onClose }: {
  pluginName: string
  request: ReviewStartRequest
  projectPath: string | null
  start: (input: ReviewSessionInput, signal: AbortSignal) => Promise<{ dirName: string; fileName: string }>
  onStarted: (session: { dirName: string; fileName: string }) => void
  onClose: () => void
}) {
  const id = useId()
  const guide = request.purpose === "guide"
  const [agent, setAgent] = useState<AgentKind>(WORKTREE_AGENTS.includes(DEFAULT_AGENT_KIND) ? DEFAULT_AGENT_KIND : WORKTREE_AGENTS[0]!)
  const [instanceId, setInstanceId] = useState("default")
  const [model, setModel] = useState("")
  const [instruction, setInstruction] = useState("")
  const [instances, setInstances] = useState<Array<{ id: string; agent: AgentKind; label: string; retired?: boolean }>>([])
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const models = useModelOptions(agent, instanceId)
  useEffect(() => {
    void authFetch("/api/provider-instances").then((response) => response.ok ? response.json() : { instances: [] }).then((body: { instances?: typeof instances }) => setInstances(body.instances ?? []), () => {})
  }, [])
  useEffect(() => () => controller.current?.abort(), [])

  async function confirm() {
    controller.current = new AbortController()
    setStarting(true)
    setError(null)
    try {
      const session = await start({ ...request, agent, instanceId, ...(model ? { model } : {}), ...(!guide && instruction.trim() ? { instruction: instruction.trim() } : {}) }, controller.current.signal)
      onStarted(session)
      onClose()
    } catch (failure) {
      if (!controller.current.signal.aborted) setError(failure instanceof Error ? failure.message : "The session did not start")
    } finally { setStarting(false) }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) { controller.current?.abort(); onClose() } }}>
    <DialogContent>
      <DialogTitle>{guide ? `Generate a review guide for #${request.number}?` : `Work on pull request #${request.number}?`}</DialogTitle>
      <DialogDescription>
        {pluginName} asks to start a session in a new worktree checked out at {request.headSha.slice(0, 7)}.{" "}
        {guide ? "It reads the change and saves a guide on this computer; nothing is posted to GitHub." : "Nothing is pushed or posted unless you ask the agent to."}
      </DialogDescription>
      <div className="flex flex-col gap-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">Provider
            <select className={INPUT} value={agent} disabled={starting} onChange={(event) => { setAgent(event.target.value as AgentKind); setInstanceId("default"); setModel("") }}>
              {WORKTREE_AGENTS.map((kind) => <option key={kind} value={kind}>{descriptorFor(kind).displayName}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">Account
            <select className={INPUT} value={instanceId} disabled={starting} onChange={(event) => setInstanceId(event.target.value)}>
              <option value="default">Default</option>
              {instances.filter((instance) => instance.agent === agent && !instance.retired).map((instance) => <option key={instance.id} value={instance.id}>{instance.label}</option>)}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1">Model
            <select className={INPUT} value={model} disabled={starting} onChange={(event) => setModel(event.target.value)}>
              <option value="">Provider default</option>
              {models.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        {!guide && <>
          <label htmlFor={`${id}-instruction`}>What should the agent do?</label>
          <textarea id={`${id}-instruction`} className={INPUT} rows={3} disabled={starting} value={instruction} placeholder="Read the change and wait for instructions." onChange={(event) => setInstruction(event.target.value)} />
        </>}
        {starting && <WorktreeSetupPanel projectCwd={projectPath} progressOnly compact />}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => { controller.current?.abort(); onClose() }}>{starting ? "Cancel startup" : "Cancel"}</Button>
        <Button disabled={starting} onClick={() => void confirm()}>{starting ? "Preparing worktree…" : guide ? "Generate guide" : "Start session"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
