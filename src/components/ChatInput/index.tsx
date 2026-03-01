import { useState, useRef, useCallback, useEffect, useMemo, memo, useImperativeHandle, forwardRef } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useElapsedTimer } from "@/hooks/useElapsedTimer"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { SlashSuggestions } from "@/components/SlashSuggestions"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"
import { deriveSessionStatus, getStatusLabel } from "@/lib/sessionStatus"
import { PlanApprovalBar } from "./PlanApprovalBar"
import { UserQuestionBar } from "./UserQuestionBar"
import { useVoiceInput } from "./useVoiceInput"
import { useImageUpload } from "./useImageUpload"
import { InputToolbar, ActionButtons } from "./InputToolbar"

export interface ChatInputHandle {
  toggleVoice: () => void
  focus: () => void
}

/** Auto-resize a textarea to fit its content (max 200px). */
function autoResize(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = "auto"
  el.style.height = Math.min(el.scrollHeight, 200) + "px"
}

function getPlaceholder(isPlanApproval: boolean, isUserQuestion: boolean, isConnected: boolean): string {
  if (isPlanApproval) return "Provide feedback to request changes..."
  if (isUserQuestion) return "Type a custom response..."
  if (isConnected) return "Message... (Enter to send)"
  return "Send a message... (Enter to send)"
}

function getTextareaBorderClass(isPlanApproval: boolean, isUserQuestion: boolean): string {
  if (isPlanApproval) return "border-purple-700/50 focus:border-purple-500/30 focus:ring-purple-500/20"
  if (isUserQuestion) return "border-pink-700/50 focus:border-pink-500/30 focus:ring-pink-500/20"
  return "border-border/50 focus:border-blue-500/30 focus:ring-blue-500/20"
}

function AgentStatusBar({ status, toolName }: { status: string; toolName?: string }) {
  const label = getStatusLabel(status as "idle" | "thinking" | "tool_use" | "processing", toolName)
  if (!label) return null

  const dotColor = status === "tool_use" ? "bg-blue-400" : "bg-amber-400"

  return (
    <div className="flex items-center gap-2 mb-1.5 px-1">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", dotColor)} />
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", dotColor)} />
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

export const ChatInput = memo(forwardRef<ChatInputHandle>(function ChatInput(_props, ref) {
  const {
    session,
    isLive,
    actions: { handleEditConfig: onEditConfig },
    pendingInteraction,
    slashSuggestions,
    slashSuggestionsLoading,
  } = useSessionContext()
  const { chat: { status, error, isConnected, sendMessage: onSend, interrupt: onInterrupt } } = useSessionChatContext()

  // Derive agent status from raw messages — no stored state
  const agentStatus = useMemo(() => {
    if (!session || !isLive) return null
    return deriveSessionStatus(session.rawMessages as Array<{ type: string; [key: string]: unknown }>)
  }, [session, isLive])

  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { voiceStatus, voiceProgress, voiceError, toggleVoice, destroyTranscriber } = useVoiceInput({
    onTranscript: (transcript) => {
      setText((prev) => {
        const joined = prev ? prev + " " + transcript : transcript
        requestAnimationFrame(() => autoResize(textareaRef.current))
        return joined
      })
    },
  })

  const { images, isDragOver, removeImage, clearImages, handleDragOver, handleDragLeave, handleDrop, handlePaste } = useImageUpload()

  // Slash suggestions state
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const showSlash = text.startsWith("/") && !text.includes(" ")
  const slashFilter = showSlash ? text.slice(1) : ""
  const filteredSlashList = useMemo(() => {
    if (!showSlash) return []
    const query = slashFilter.toLowerCase()
    const filtered = slashSuggestions.filter((s) => {
      if (!query) return true
      return s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
    })
    const commands = filtered.filter((s) => s.type === "command")
    const skills = filtered.filter((s) => s.type === "skill")
    return [...commands, ...skills]
  }, [showSlash, slashFilter, slashSuggestions])

  useEffect(() => { setSlashSelectedIndex(0) }, [slashFilter])

  const elapsedSec = useElapsedTimer(isConnected)

  const handleSlashSelect = useCallback((suggestion: SlashSuggestion) => {
    setText(`/${suggestion.name} `)
    setSlashSelectedIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; autoResize(el) }
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    const imagePayload = images.length > 0 ? images.map((img) => ({ data: img.data, mediaType: img.mediaType })) : undefined
    onSend(trimmed, imagePayload)
    setText("")
    clearImages()
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }, [text, images, onSend, clearImages])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showSlash && filteredSlashList.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashSelectedIndex((i) => i < filteredSlashList.length - 1 ? i + 1 : 0); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashSelectedIndex((i) => i > 0 ? i - 1 : filteredSlashList.length - 1); return }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); const selected = filteredSlashList[slashSelectedIndex]; if (selected) handleSlashSelect(selected); return }
      if (e.key === "Escape") { e.preventDefault(); setText(""); return }
    }
    if (e.key === "Escape" && isConnected && onInterrupt) { e.preventDefault(); onInterrupt(); return }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }, [handleSubmit, isConnected, onInterrupt, showSlash, filteredSlashList, slashSelectedIndex, handleSlashSelect])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => { setText(e.target.value); autoResize(e.target) }, [])

  useImperativeHandle(ref, () => ({ toggleVoice, focus: () => textareaRef.current?.focus() }), [toggleVoice])
  useEffect(() => { return () => { destroyTranscriber() } }, [destroyTranscriber])

  const isPlanApproval = pendingInteraction?.type === "plan"
  const isUserQuestion = pendingInteraction?.type === "question"
  const hasContent = text.trim().length > 0 || images.length > 0

  return (
    <div
      className={cn("border-t border-border/50 bg-elevation-1 px-3 py-2.5 relative", isDragOver && "ring-2 ring-blue-500/50 ring-inset")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-blue-500/40 rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <span className="text-sm text-blue-400 font-medium">Drop images here</span>
        </div>
      )}

      {showSlash && (
        <SlashSuggestions suggestions={filteredSlashList} filter={slashFilter} loading={slashSuggestionsLoading} selectedIndex={slashSelectedIndex} onSelect={handleSlashSelect} onHover={setSlashSelectedIndex} onEdit={onEditConfig} />
      )}

      <div className="mx-auto max-w-3xl">
        {agentStatus && agentStatus.status !== "idle" && (
          <AgentStatusBar status={agentStatus.status} toolName={agentStatus.toolName} />
        )}

        {isPlanApproval && <PlanApprovalBar allowedPrompts={pendingInteraction.allowedPrompts} onApprove={() => onSend("yes")} onSend={onSend} />}
        {isUserQuestion && <UserQuestionBar questions={pendingInteraction.questions} onSend={onSend} />}

        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <div key={i} className="relative group/thumb">
                <img src={img.preview} alt={`Upload ${i + 1}`} className="h-16 w-auto rounded-lg border border-border/50 object-contain bg-muted" />
                <button onClick={() => removeImage(i)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-red-900 hover:border-red-600" aria-label={`Remove image ${i + 1}`}>
                  <X className="w-3 h-3 text-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={getPlaceholder(isPlanApproval, isUserQuestion, isConnected)}
              rows={1}
              className={cn("w-full resize-none rounded-xl border elevation-1 px-3.5 py-2.5 text-sm text-foreground", "placeholder:text-muted-foreground focus:outline-none focus:ring-2", getTextareaBorderClass(isPlanApproval, isUserQuestion), "transition-colors duration-200")}
            />
            <InputToolbar isPlanApproval={isPlanApproval} isUserQuestion={isUserQuestion} elapsedSec={elapsedSec} />
          </div>
          <ActionButtons hasContent={hasContent} voiceStatus={voiceStatus} voiceProgress={voiceProgress} voiceError={voiceError} onToggleVoice={toggleVoice} onSubmit={handleSubmit} />
        </div>
        {status === "error" && error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
      </div>
    </div>
  )
}))
