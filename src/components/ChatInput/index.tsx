import { useState, useRef, useCallback, useEffect, useMemo, memo, useImperativeHandle, forwardRef, type ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useElapsedTimer } from "@/hooks/useElapsedTimer"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { SlashSuggestions } from "@/components/SlashSuggestions"
import { FileSuggestions } from "@/components/FileSuggestions"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"
import { PlanApprovalBar } from "./PlanApprovalBar"
import { PermissionRequestBar } from "./PermissionRequestBar"
import { useImageUpload } from "./useImageUpload"
import { InputToolbar, ActionButtons } from "./InputToolbar"
import { ErrorBanner } from "./ErrorBanner"
import { PromptSuggestionBar } from "./PromptSuggestionBar"
import { capabilitiesFor, DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import { findFileMention, replaceFileMention } from "@/lib/fileMentions"
import { useProjectFileSuggestions } from "@/hooks/useProjectFileSuggestions"
import { submitUserQuestionAnswers } from "@/lib/askUserApi"
import { submitCopilotPlanResponse } from "@/lib/copilotPlanApi"
import { useCapability } from "@/hooks/useCapability"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface ChatInputHandle {
  focus: () => void
  /** Get the current input text (for draft text preservation). */
  getText: () => string
  /** Set the input text (for draft text restoration). */
  setText: (text: string) => void
}

interface ChatInputProps {
  /** Whether the selected provider/model accepts image input. */
  allowImages?: boolean
  agentKind?: AgentKind | null
  projectCwd?: string | null
  /** Mobile-only control placed at the leading edge of the composer. */
  leadingAccessory?: ReactNode
  /**
   * Desktop-only session controls rendered along the bottom edge of the card,
   * between the message and the send button. Stacks the composer into two rows.
   */
  footer?: ReactNode
  /** Enables the compact mobile composer treatment. */
  compact?: boolean
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

function getPlaceholder(isPlanApproval: boolean, isUserQuestion: boolean, isConnected: boolean, hasPermissionRequests?: boolean, isSteering?: boolean, compact?: boolean): string {
  if (hasPermissionRequests) return "Resolve approval to continue..."
  if (isPlanApproval) return "Provide feedback to request changes..."
  if (isUserQuestion) return "Type a custom response..."
  if (compact) return isSteering ? "Steer…" : "Message…"
  if (isSteering) return "Steer the active turn… (Enter to send)"
  if (isConnected) return "Message... (Enter to send)"
  return "Send a message... (Enter to send)"
}

function getTextareaBorderClass(isPlanApproval: boolean, isUserQuestion: boolean, hasPermissionRequests?: boolean): string {
  if (hasPermissionRequests) return "border-warning/40 focus-within:border-warning/60 focus-within:ring-warning/15"
  if (isPlanApproval || isUserQuestion) return "border-info/40 focus-within:border-info/60 focus-within:ring-info/15"
  return "border-input focus-within:border-ring focus-within:ring-ring/20"
}

function getTextareaLayoutClass(stacked: boolean, isMultiline: boolean, compact: boolean): string {
  if (stacked) return "px-4 pb-1.5 pt-3.5"
  if (isMultiline) return cn("col-span-2 row-start-1", compact ? "py-2.5 pr-3 pl-2" : "py-3 pr-4 pl-4")
  return cn("col-start-2 row-start-1", compact ? "py-2 pr-1 pl-2" : "py-2.5 pr-2 pl-4")
}

function getActionRowClass(stacked: boolean, isMultiline: boolean): string {
  if (stacked) return "gap-1 px-2 pb-2 pt-0.5"
  if (isMultiline) return "col-start-2 row-start-2 px-1.5 pb-1.5"
  return "col-start-3 row-start-1 pr-1.5 pb-1.5"
}

export const ChatInput = memo(forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({ allowImages = true, agentKind, projectCwd, leadingAccessory, footer, compact = false }, ref) {
  const canAccessHostFiles = useCapability("hostFiles")
  const {
    session,
    isLive,
    actions: { handleEditConfig: onEditConfig },
    pendingInteraction,
    permissionRequests,
    permissionResponding,
    respondPermission,
    respondAllPermissions,
    slashSuggestions,
    slashSuggestionsLoading,
    turnError,
    promptSuggestion,
  } = useSessionContext()
  const { chat: { status, error, isConnected, sendMessage: onSend, interrupt: onInterrupt } } = useSessionChatContext()
  const canInterrupt = isConnected || isLive

  const [text, setText] = useState("")
  const [isMultiline, setIsMultiline] = useState(false)
  const [planResponding, setPlanResponding] = useState(false)
  const [planResponseError, setPlanResponseError] = useState<string | null>(null)
  const planRespondingRequestRef = useRef<string | null>(null)
  const planRequestIdRef = useRef<string | null>(null)
  const isMultilineRef = useRef(false)
  const textRef = useRef("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textRef.current = text }, [text])

  const updateMultiline = useCallback((v: boolean) => { isMultilineRef.current = v; setIsMultiline(v) }, [])

  const { images, isDragOver, imageError, hasUnsupportedAttachments, dismissImageError, removeImage, clearImages, handleDragOver, handleDragLeave, handleDrop, handlePaste } = useImageUpload(allowImages)

  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0)
  const [fileSuggestionsDismissed, setFileSuggestionsDismissed] = useState(false)
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

  const fileMention = useMemo(() => findFileMention(text), [text])
  const showFiles = Boolean(canAccessHostFiles && fileMention && projectCwd && !fileSuggestionsDismissed)
  const fileSuggestions = useProjectFileSuggestions(
    projectCwd,
    fileMention?.query ?? "",
    showFiles,
  )

  useEffect(() => { setSlashSelectedIndex(0) }, [slashFilter])
  useEffect(() => { setFileSelectedIndex(0) }, [fileMention?.query])

  const elapsedSec = useElapsedTimer(isConnected)
  const planRequestId = pendingInteraction?.type === "plan"
    ? pendingInteraction.requestId ?? null
    : null

  useEffect(() => {
    planRequestIdRef.current = planRequestId
    planRespondingRequestRef.current = null
    setPlanResponding(false)
    setPlanResponseError(null)
  }, [planRequestId])

  const submitUserQuestion = useCallback(async (answer: string) => {
    const interaction = pendingInteraction
    if (!session?.sessionId || interaction?.type !== "question") return

    const question = interaction.questions[0]
    if (!question || !answer.trim()) return

    const result = await submitUserQuestionAnswers(
      session.sessionId,
      interaction.toolUseId,
      { [question.question]: answer },
    )

    // The question may no longer be answerable server-side (tool already
    // errored, session restarted, …). Never swallow the user's text — deliver
    // it as a regular message instead so the input can't appear frozen.
    if (!result.ok) onSend(answer)
  }, [pendingInteraction, session?.sessionId, onSend])

  const submitPlanResponse = useCallback(async (
    approved: boolean,
    selectedAction?: string,
    feedback?: string,
  ): Promise<boolean> => {
    const interaction = pendingInteraction
    if (
      interaction?.type === "plan"
      && interaction.provider === "copilot"
      && interaction.requestId
      && session?.sessionId
    ) {
      const requestId = interaction.requestId
      if (planRespondingRequestRef.current) return false
      planRespondingRequestRef.current = requestId
      setPlanResponding(true)
      setPlanResponseError(null)
      try {
        const submitted = await submitCopilotPlanResponse(session.sessionId, requestId, {
          approved,
          ...(selectedAction ? { selectedAction } : {}),
          ...(feedback ? { feedback } : {}),
        })
        if (!submitted && planRequestIdRef.current === requestId) {
          setPlanResponseError("Couldn't send the plan response. Try again.")
        }
        return submitted
      } finally {
        if (planRespondingRequestRef.current === requestId) {
          planRespondingRequestRef.current = null
          setPlanResponding(false)
        }
      }
    }
    onSend(approved ? "yes" : feedback || "no")
    return true
  }, [pendingInteraction, session?.sessionId, onSend])

  const focusComposerAtEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; updateMultiline(autoResize(el, isMultilineRef.current)) }
    })
  }, [updateMultiline])

  const handleSlashSelect = useCallback((suggestion: SlashSuggestion) => {
    setText(`/${suggestion.name} `)
    setSlashSelectedIndex(0)
    focusComposerAtEnd()
  }, [focusComposerAtEnd])

  // Fills the composer and leaves the caret at the end: the prediction is a
  // draft to edit, so it deliberately does not send.
  const applySuggestion = useCallback((suggestion: string) => {
    setText(suggestion)
    focusComposerAtEnd()
  }, [focusComposerAtEnd])

  const handleFileSelect = useCallback((path: string) => {
    if (!fileMention) return
    const nextText = replaceFileMention(text, fileMention, path)
    setText(nextText)
    setFileSuggestionsDismissed(true)
    setFileSelectedIndex(0)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.selectionStart = element.selectionEnd = element.value.length
      updateMultiline(autoResize(element, isMultilineRef.current))
    })
  }, [fileMention, text, updateMultiline])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    if (!allowImages && images.length > 0) return

    if (pendingInteraction?.type === "question") {
      void submitUserQuestion(trimmed)
      setText("")
      updateMultiline(false)
      if (textareaRef.current) textareaRef.current.style.height = "auto"
      return
    }

    if (pendingInteraction?.type === "plan" && pendingInteraction.provider === "copilot") {
      if (!trimmed) return
      const submitted = await submitPlanResponse(false, undefined, trimmed)
      if (!submitted) return
      setText("")
      updateMultiline(false)
      if (textareaRef.current) textareaRef.current.style.height = "auto"
      return
    }

    const imagePayload = allowImages && images.length > 0 ? images.map((img) => ({ data: img.data, mediaType: img.mediaType })) : undefined
    onSend(trimmed, imagePayload)
    setText("")
    clearImages()
    updateMultiline(false)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }, [text, images, allowImages, onSend, clearImages, updateMultiline, pendingInteraction, submitUserQuestion, submitPlanResponse])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showFiles && e.key === "Escape") {
      e.preventDefault()
      setFileSuggestionsDismissed(true)
      return
    }
    if (showFiles && fileSuggestions.files.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setFileSelectedIndex((index) => index < fileSuggestions.files.length - 1 ? index + 1 : 0); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setFileSelectedIndex((index) => index > 0 ? index - 1 : fileSuggestions.files.length - 1); return }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); const selected = fileSuggestions.files[fileSelectedIndex]; if (selected) handleFileSelect(selected); return }
    }
    if (showSlash && filteredSlashList.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashSelectedIndex((i) => i < filteredSlashList.length - 1 ? i + 1 : 0); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashSelectedIndex((i) => i > 0 ? i - 1 : filteredSlashList.length - 1); return }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); const selected = filteredSlashList[slashSelectedIndex]; if (selected) handleSlashSelect(selected); return }
      if (e.key === "Escape") { e.preventDefault(); setText(""); return }
    }
    if (e.key === "Escape" && canInterrupt && onInterrupt) { e.preventDefault(); onInterrupt(); return }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSubmit() }
  }, [handleSubmit, canInterrupt, onInterrupt, showFiles, fileSuggestions.files, fileSelectedIndex, handleFileSelect, showSlash, filteredSlashList, slashSelectedIndex, handleSlashSelect])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => { setText(e.target.value); setFileSuggestionsDismissed(false); updateMultiline(autoResize(e.target, isMultilineRef.current)) }, [updateMultiline])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    getText: () => textRef.current,
    setText: (newText: string) => {
      setText(newText)
      setFileSuggestionsDismissed(false)
      requestAnimationFrame(() => updateMultiline(autoResize(textareaRef.current, isMultilineRef.current)))
    },
  }), [updateMultiline])

  const isPlanApproval = pendingInteraction?.type === "plan"
  const isUserQuestion = pendingInteraction?.type === "question"
  const hasPermissions = permissionRequests.length > 0
  // With session controls inside the card the message always gets its own
  // row, so the inline single-line grid only applies to the mobile composer.
  const stacked = Boolean(footer)
  const hasContent = (text.trim().length > 0 || images.length > 0) && !hasUnsupportedAttachments
  const isSteering = capabilitiesFor(agentKind ?? DEFAULT_AGENT_KIND).midTurnSteering && canInterrupt
  const suggestionListId = showFiles ? "file-suggestions" : showSlash ? "slash-suggestions" : undefined
  const activeSuggestionId = showFiles && fileSuggestions.files[fileSelectedIndex]
    ? `file-suggestion-${fileSelectedIndex}`
    : showSlash && filteredSlashList[slashSelectedIndex]
      ? `slash-suggestion-${slashSelectedIndex}`
      : undefined

  return (
    <div
      className={cn(
        "relative pb-0",
        compact ? "px-2 pt-2" : "px-3 pt-2",
        isDragOver && "ring-2 ring-info/40 ring-inset",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="motion-enter pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-info/40 bg-info/10">
          <span className="text-sm font-medium text-info">Drop images here</span>
        </div>
      )}

      {showSlash && (
        <SlashSuggestions suggestions={filteredSlashList} filter={slashFilter} loading={slashSuggestionsLoading} selectedIndex={slashSelectedIndex} onSelect={handleSlashSelect} onHover={setSlashSelectedIndex} onEdit={onEditConfig} />
      )}

      {showFiles && (
        <FileSuggestions
          files={fileSuggestions.files}
          query={fileMention?.query ?? ""}
          loading={fileSuggestions.loading}
          selectedIndex={fileSelectedIndex}
          onSelect={handleFileSelect}
          onHover={setFileSelectedIndex}
        />
      )}

      <div>
          {isPlanApproval && (
            <PlanApprovalBar
              allowedPrompts={pendingInteraction.allowedPrompts}
              summary={pendingInteraction.summary}
              planContent={pendingInteraction.planContent}
              actions={pendingInteraction.actions}
              recommendedAction={pendingInteraction.recommendedAction}
              responding={planResponding}
              responseError={planResponseError}
              onApprove={(action) => { void submitPlanResponse(true, action) }}
              onReject={() => { void submitPlanResponse(false) }}
            />
          )}

        {/* Sits above the composer it fills. Renders nothing when the CLI sent
            no suggestion, which is most turns. */}
        <PromptSuggestionBar suggestion={promptSuggestion} onAccept={applySuggestion} />

        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={img.id} className="motion-list-item relative group/thumb">
                <img src={img.preview} alt={`Upload ${i + 1}`} className="h-16 w-auto rounded-md border bg-muted object-contain" />
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeImage(i)} className="absolute -right-1.5 -top-1.5 size-5 rounded-full border bg-background p-0 text-muted-foreground opacity-100 hover:bg-destructive hover:text-destructive-foreground sm:opacity-0 sm:group-hover/thumb:opacity-100 sm:focus-visible:opacity-100" aria-label={`Remove image ${i + 1}`}>
                  <X className="size-3" data-icon="icon" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {imageError && (
          <div role="status" aria-live="polite" className="motion-enter mb-2 flex items-center gap-2 text-xs text-warning">
            <span className="flex-1">{imageError}</span>
            {!hasUnsupportedAttachments && (
              <Button type="button" variant="ghost" size="icon-xs" onClick={dismissImageError} className="text-muted-foreground" aria-label="Dismiss image notice">
                <X data-icon="icon" />
              </Button>
            )}
          </div>
        )}

        <div className={cn(
          "relative overflow-hidden border bg-composer-surface/85 shadow-lg shadow-black/5 backdrop-blur-xl transition-[border-color,box-shadow] duration-150",
          stacked ? "rounded-3xl" : "rounded-xl",
          getTextareaBorderClass(isPlanApproval, isUserQuestion, hasPermissions),
          "focus-within:ring-3",
        )}>
          {hasPermissions && (
            <PermissionRequestBar
              key={permissionRequests[0]?.requestId}
              requests={permissionRequests}
              responding={permissionResponding}
              onRespond={respondPermission}
              onRespondAll={respondAllPermissions}
            />
          )}
          <div className={cn(
            "min-w-0",
            stacked ? "flex flex-col" : "grid items-end",
            !stacked && (isMultiline ? "grid-cols-[1fr_auto]" : "grid-cols-[auto_minmax(0,1fr)_auto]"),
          )}>
            {leadingAccessory && (
              <div className={cn(
                "flex shrink-0 items-center",
                isMultiline ? "col-start-1 row-start-2 pl-0.5 pb-0.5" : "col-start-1 row-start-1",
              )}>
                {leadingAccessory}
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => {
                // On mobile, scroll textarea into view after virtual keyboard opens
                setTimeout(() => textareaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 300)
              }}
              placeholder={getPlaceholder(isPlanApproval, isUserQuestion, isConnected, hasPermissions, isSteering, compact)}
              aria-label="Message"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={Boolean(suggestionListId)}
              aria-controls={suggestionListId}
              aria-activedescendant={activeSuggestionId}
              rows={1}
              className={cn(
                "min-h-0 w-full resize-none rounded-none border-0 bg-transparent text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent",
                getTextareaLayoutClass(stacked, isMultiline, compact),
              )}
            />
            <div className={cn(
              "flex shrink-0 items-center justify-end",
              getActionRowClass(stacked, isMultiline),
            )}>
              {footer}
              <InputToolbar isPlanApproval={isPlanApproval} isUserQuestion={isUserQuestion} elapsedSec={elapsedSec} />
              <ActionButtons hasContent={hasContent} onSubmit={handleSubmit} submitLabel={isSteering ? "Steer active turn" : "Send message"} />
            </div>
          </div>
        </div>
        {status === "error" && error && <ErrorBanner key={error} error={error} />}
        {/* Failures with no HTTP response behind them arrive over SSE instead.
            Mutually exclusive with the banner above: the server only publishes
            when nothing is waiting on a response. */}
        {turnError && <ErrorBanner key={turnError} error={turnError} />}
      </div>
    </div>
  )
}))
