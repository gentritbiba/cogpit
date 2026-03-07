import { useState, useRef, useCallback, useEffect, useMemo, memo, useImperativeHandle, forwardRef } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useElapsedTimer } from "@/hooks/useElapsedTimer"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { SlashSuggestions } from "@/components/SlashSuggestions"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"
import { PlanApprovalBar } from "./PlanApprovalBar"
import { UserQuestionBar } from "./UserQuestionBar"
import { useVoiceInput } from "./useVoiceInput"
import { useImageUpload } from "./useImageUpload"
import { InputToolbar, ActionButtons } from "./InputToolbar"

export interface ChatInputHandle {
  toggleVoice: () => void
  focus: () => void
}

/**
 * Auto-resize a textarea to fit its content (max 200px).
 * Returns true if multiline layout is needed.
 *
 * When currently in multiline mode, the textarea is wider (buttons on own row).
 * To prevent oscillation at the boundary, we temporarily shrink the width to
 * simulate the single-line layout before deciding whether to exit multiline.
 */
function autoResize(el: HTMLTextAreaElement | null, currentlyMultiline: boolean): boolean {
  if (!el) return false
  const prev = el.offsetHeight
  el.style.transition = "none"
  el.style.height = "auto"
  const target = Math.min(el.scrollHeight, 200)

  // Decide if we need multiline
  let needsMultiline: boolean
  if (currentlyMultiline) {
    // Temporarily narrow the textarea to what it would be with inline buttons
    // and check if text still wraps. This prevents the oscillation loop where:
    // multiline → wider → text unwraps → exit multiline → narrower → text wraps → ...
    const INLINE_BUTTONS_WIDTH_PX = 140
    const savedW = el.style.width
    el.style.width = `${Math.max(100, el.offsetWidth - INLINE_BUTTONS_WIDTH_PX)}px`
    needsMultiline = el.scrollHeight > 48
    el.style.width = savedW
  } else {
    needsMultiline = target > 44
  }

  if (prev !== target) {
    el.style.height = prev + "px"
    void el.offsetHeight // force layout at old height
    el.style.transition = "height 150ms ease"
    el.style.height = target + "px"
  } else {
    el.style.height = target + "px"
  }
  return needsMultiline
}

function getPlaceholder(isPlanApproval: boolean, isUserQuestion: boolean, isConnected: boolean): string {
  if (isPlanApproval) return "Provide feedback to request changes..."
  if (isUserQuestion) return "Type a custom response..."
  if (isConnected) return "Message... (Enter to send)"
  return "Send a message... (Enter to send)"
}

function getTextareaBorderClass(isPlanApproval: boolean, isUserQuestion: boolean): string {
  if (isPlanApproval) return "border-purple-700/50 focus-within:border-purple-500/30 focus-within:ring-purple-500/20"
  if (isUserQuestion) return "border-pink-700/50 focus-within:border-pink-500/30 focus-within:ring-pink-500/20"
  return "border-border/50 focus-within:border-blue-500/30 focus-within:ring-blue-500/20"
}

export const ChatInput = memo(forwardRef<ChatInputHandle>(function ChatInput(_props, ref) {
  const {
    actions: { handleEditConfig: onEditConfig },
    pendingInteraction,
    slashSuggestions,
    slashSuggestionsLoading,
  } = useSessionContext()
  const { chat: { status, error, isConnected, sendMessage: onSend, interrupt: onInterrupt } } = useSessionChatContext()

  const [text, setText] = useState("")
  const [isMultiline, setIsMultiline] = useState(false)
  const isMultilineRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const updateMultiline = useCallback((v: boolean) => { isMultilineRef.current = v; setIsMultiline(v) }, [])

  const { voiceStatus, voiceProgress, voiceError, toggleVoice, destroyTranscriber } = useVoiceInput({
    onTranscript: (transcript) => {
      setText((prev) => {
        const joined = prev ? prev + " " + transcript : transcript
        requestAnimationFrame(() => updateMultiline(autoResize(textareaRef.current, isMultilineRef.current)))
        return joined
      })
    },
  })

  const { images, isDragOver, removeImage, clearImages, handleDragOver, handleDragLeave, handleDrop, handlePaste } = useImageUpload()

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
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; updateMultiline(autoResize(el, isMultilineRef.current)) }
    })
  }, [updateMultiline])

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    const imagePayload = images.length > 0 ? images.map((img) => ({ data: img.data, mediaType: img.mediaType })) : undefined
    onSend(trimmed, imagePayload)
    setText("")
    clearImages()
    updateMultiline(false)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }, [text, images, onSend, clearImages, updateMultiline])

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

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => { setText(e.target.value); updateMultiline(autoResize(e.target, isMultilineRef.current)) }, [updateMultiline])

  useImperativeHandle(ref, () => ({ toggleVoice, focus: () => textareaRef.current?.focus() }), [toggleVoice])
  useEffect(() => { return () => { destroyTranscriber() } }, [destroyTranscriber])

  const isPlanApproval = pendingInteraction?.type === "plan"
  const isUserQuestion = pendingInteraction?.type === "question"
  const hasContent = text.trim().length > 0 || images.length > 0

  return (
    <div
      className={cn("border-border/50 bg-elevation-1 pt-2.5 pb-0 relative", isDragOver && "ring-2 ring-blue-500/50 ring-inset")}
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

      <div>
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

        <div className={cn(
          "relative bg-elevation-2 border rounded-3xl chat-input-3d",
          getTextareaBorderClass(isPlanApproval, isUserQuestion),
          "focus-within:ring-2",
          isMultiline ? "flex flex-col" : "flex items-end"
        )}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={getPlaceholder(isPlanApproval, isUserQuestion, isConnected)}
            rows={1}
            className={cn(
              "w-full resize-none bg-transparent pl-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
              isMultiline ? "py-3 pr-4" : "py-2.5 pr-2"
            )}
          />
          <div className={cn(
            "flex items-center shrink-0",
            isMultiline ? "px-2 pb-2 justify-end" : "pr-1.5 pb-1.5"
          )}>
            <InputToolbar isPlanApproval={isPlanApproval} isUserQuestion={isUserQuestion} elapsedSec={elapsedSec} />
            <ActionButtons hasContent={hasContent} voiceStatus={voiceStatus} voiceProgress={voiceProgress} voiceError={voiceError} onToggleVoice={toggleVoice} onSubmit={handleSubmit} />
          </div>
        </div>
        {status === "error" && error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
      </div>
    </div>
  )
}))
