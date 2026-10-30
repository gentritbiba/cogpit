import { useState, useSyncExternalStore, useLayoutEffect, useRef, useCallback, useEffect, useMemo, memo, useImperativeHandle, forwardRef, type ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { SlashSuggestions } from "@/components/SlashSuggestions"
import { FileSuggestions } from "@/components/FileSuggestions"
import type { SlashSuggestion } from "../../../shared/contracts/projectTools"
import { PlanApprovalBar } from "./PlanApprovalBar"
import { PermissionRequestBar } from "./PermissionRequestBar"
import { attachmentSrc, useImageUpload, type UploadedImage } from "./useImageUpload"
import { deviceScopedKey } from "@/lib/device"
import { combineContext } from "./composerEditing"
import { unsentRecovery, downloadUnsentBackup } from "./unsentRecovery"
import { ContextChips } from "./ContextChips"
import { contextRefusal, validateContext, EMPTY_DRAFT, isDraftEmpty, parseComposerMessage, renderComposerMessage, type ComposerAttachment, type ComposerContextItem, type ComposerDraft } from "../../../shared/session/composerContext"
import { ActionButtons } from "./ActionButtons"
import { registerComposer, emitComposerEvent, dispatchComposerKey, type ComposerHandle, type ComposerSnapshot } from "@/plugins/composerBridge"
import { RuntimePluginActions } from "@/plugins/RuntimePluginActions"
import { DictationBar, DictationButton, useComposerDictation } from "@/plugins/RuntimeDictation"
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
  /**
   * Add a context item, with the images it brings, to the draft. Returns why
   * it could not be added (a bound was reached), or null. Adding an item whose
   * id the draft already holds keeps the draft as it is.
   */
  addContext: (item: ComposerContextItem, attachments?: ComposerAttachment[]) => string | null
  /** Everything the composer holds, serializable: text, context and image bytes. */
  getDraft: () => ComposerDraft
  /** Replace what the composer holds with `draft`. */
  setDraft: (draft: ComposerDraft) => void
}

interface ChatInputProps {
  /** Whether the selected provider/model accepts image input. */
  allowImages?: boolean
  agentKind?: AgentKind | null
  projectCwd?: string | null
  /** Provider/workspace identity for a pending composer. */
  composerIdentity?: string | null
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

export const ChatInput = memo(forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(props, ref) {
  const { session, sessionSource } = useSessionContext()
  const identity = JSON.stringify([sessionSource?.dirName ?? props.composerIdentity ?? props.agentKind ?? "", session?.sessionId ?? "pending"])
  const scope = JSON.stringify([deviceScopedKey("composer-v1"), props.projectCwd ?? session?.cwd ?? "", identity])
  return <ScopedChatInput key={scope} {...props} scope={scope} ref={ref} />
}))

const ScopedChatInput = forwardRef<ChatInputHandle, ChatInputProps & { scope: string }>(function ScopedChatInput({ scope, allowImages = true, agentKind, projectCwd, leadingAccessory, footer, compact = false }, ref) {
  const recovery = useMemo(() => unsentRecovery(scope), [scope])
  const snapshot = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot)
  const initial = useRef(snapshot.draft).current
  const mounted = useRef(true)
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

  const [text, setText] = useState(initial.text)
  const [isMultiline, setIsMultiline] = useState(false)
  const [planResponding, setPlanResponding] = useState(false)
  const [planResponseError, setPlanResponseError] = useState<string | null>(null)
  const planRespondingRequestRef = useRef<string | null>(null)
  const planRequestIdRef = useRef<string | null>(null)
  const isMultilineRef = useRef(false)
  const textRef = useRef(initial.text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  textRef.current = text

  const updateMultiline = useCallback((v: boolean) => { isMultilineRef.current = v; setIsMultiline(v) }, [])

  const { images, isDragOver, imageError, hasUnsupportedAttachments, uploading, dismissImageError, removeImage, clearImages, restoreImages, attachImages, removeContextImages, handleDragOver, handleDragLeave, handleDrop, handlePaste: handleImagePaste } = useImageUpload(allowImages, initial.attachments)
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [context, setContext] = useState<ComposerContextItem[]>(initial.context)
  const contextRef = useRef(context)
  contextRef.current = context
  const [contextError, setContextError] = useState<string | null>(null)
  const openQuoteSource = useSessionContext().actions.handleOpenQuoteSource

  const draftNow = useCallback((): ComposerDraft => ({ v: 1, text: textRef.current, context: contextRef.current, attachments: imagesRef.current }), [])
  const applyDraft = useCallback((value: ComposerDraft) => {
    const draft = structuredClone(value)
    textRef.current = draft.text
    contextRef.current = draft.context
    imagesRef.current = draft.attachments
    setText(draft.text)
    setContext(draft.context)
    clearImages()
    if (draft.attachments.length) restoreImages(draft.attachments)
    setContextError(validateContext(draft.context))
  }, [clearImages, restoreImages])

  const uploadingRef = useRef(false)
  uploadingRef.current = Boolean(uploading)
  const inFlight = useRef(new Set<string>())
  const revision = useRef({ token: crypto.randomUUID() as string, value: "" })
  const composer = useMemo<ComposerHandle>(() => ({
    snapshot(): ComposerSnapshot {
      const draft = structuredClone(draftNow())
      const busy = uploadingRef.current || inFlight.current.size > 0
      const value = JSON.stringify([draft, busy])
      if (value !== revision.current.value) revision.current = { token: crypto.randomUUID(), value }
      const [, cwd, identity] = JSON.parse(scope) as [string, string, string]
      return { token: revision.current.token, scope: { key: scope, cwd: cwd || null, identity }, draft, busy, uploading: uploadingRef.current }
    },
    replace(draft, expectedToken) {
      const current = this.snapshot()
      if (current.token !== expectedToken || current.busy || !mounted.current) return null
      applyDraft(draft)
      recovery.edit(draftNow())
      const snapshot = this.snapshot()
      emitComposerEvent(this, { type: "change", snapshot })
      return snapshot
    },
    focus() { textareaRef.current?.focus() },
  }), [scope, draftNow, applyDraft, recovery])

  useLayoutEffect(() => {
    const unregister = registerComposer(composer)
    emitComposerEvent(composer, { type: "scope", snapshot: composer.snapshot() })
    return unregister
  }, [composer])

  const addContext = useCallback((item: ComposerContextItem, attachments: ComposerAttachment[] = []): string | null => {
    const refusal = attachments.length > 0 && !allowImages
      ? "The selected model does not accept images, so this capture cannot be attached. Switch models and try again."
      : contextRefusal(contextRef.current, item)
    if (refusal) {
      setContextError(refusal)
      return refusal
    }
    if (contextRef.current.some((existing) => existing.id === item.id)) return null
    contextRef.current = [...contextRef.current, item]
    setContext(contextRef.current)
    attachImages(attachments.map((attachment) => ({ ...attachment, contextId: item.id })))
    setContextError(null)
    return null
  }, [attachImages, allowImages])

  const removeContext = useCallback((id: string) => {
    contextRef.current = contextRef.current.filter((item) => item.id !== id)
    setContext(contextRef.current)
    removeContextImages(id)
    setContextError(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [removeContextImages])

  useLayoutEffect(() => { recovery.edit(draftNow()); emitComposerEvent(composer, { type: "change", snapshot: composer.snapshot() }) }, [text, context, images, recovery, draftNow, composer, uploading])
  useEffect(() => {
    mounted.current = true
    const unload = (event: BeforeUnloadEvent) => {
      if (recovery.getSnapshot().messages.length) { event.preventDefault(); event.returnValue = "" }
    }
    window.addEventListener("beforeunload", unload)
    return () => { mounted.current = false; window.removeEventListener("beforeunload", unload) }
  }, [recovery])

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
    return result.ok || await onSend(answer)
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

  const submitText = useCallback(async (message: string) => {
    const trimmed = message.trim()
    if (!trimmed && images.length === 0 && context.length === 0) return
    if ((!allowImages && images.length > 0) || uploading) return
    const refusal = validateContext(context)
    if (refusal) { setContextError(refusal); return }

    const textResponse = pendingInteraction?.type === "question" || (pendingInteraction?.type === "plan" && pendingInteraction.provider === "copilot")
    if (textResponse && !trimmed) return

    const imagePayload = allowImages && images.length > 0 ? images.map((img) => ({ data: img.data, mediaType: img.mediaType })) : undefined
    const draft = structuredClone({ ...draftNow(), text: message })
    // A capture names its image by where it lands among the images sent.
    const sentContext = context.map((item) => item.kind === "browser" ? { ...item, image: images.findIndex((image) => image.contextId === item.id) + 1 } : item)
    const entryId = recovery.capture(draft)
    inFlight.current.add(entryId)
    revision.current = { token: crypto.randomUUID(), value: "" }
    emitComposerEvent(composer, { type: "before-send", sendId: entryId, scope: composer.snapshot().scope, draft: structuredClone(draft) })
    applyDraft(textResponse ? { ...draft, text: "" } : EMPTY_DRAFT)
    recovery.edit(draftNow())
    const clearedRevision = recovery.getSnapshot().revision
    const settle = (sent: boolean) => {
      inFlight.current.delete(entryId)
      const restored = recovery.settle(entryId, sent, clearedRevision)
      if (mounted.current && restored) applyDraft(restored)
      emitComposerEvent(composer, { type: "settled", sendId: entryId, sent })
      if (mounted.current) emitComposerEvent(composer, { type: "change", snapshot: composer.snapshot() })
    }
    try {
      const delivery = pendingInteraction?.type === "question"
        ? submitUserQuestion(trimmed).then(Boolean)
        : textResponse ? submitPlanResponse(false, undefined, trimmed)
          : session?.sessionId ? onSend(renderComposerMessage({ text: trimmed, context: sentContext }), imagePayload)
            : onSend(renderComposerMessage({ text: trimmed, context: sentContext }), imagePayload, (session) => emitComposerEvent(composer, { type: "created", sendId: entryId, session }))
      void delivery.then(settle, () => settle(false))
    } catch { settle(false) }
    updateMultiline(false)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }, [images, context, allowImages, onSend, updateMultiline, pendingInteraction, submitUserQuestion, submitPlanResponse, session?.sessionId, uploading, recovery, draftNow, applyDraft, composer])
  const handleSubmit = useCallback(() => submitText(text), [submitText, text])

  // Spoken text continues the draft; sending it sends the whole draft.
  const dictation = useComposerDictation(useCallback((spoken: string, send: boolean) => {
    const draft = textRef.current
    const next = !draft.trim() ? spoken : /\s$/.test(draft) ? draft + spoken : `${draft} ${spoken}`
    setText(next)
    if (send) void submitText(next)
    else focusComposerAtEnd()
  }, [submitText, focusComposerAtEnd]))
  const dictationStatus = dictation?.state.status ?? "idle"
  const recording = dictationStatus === "recording"
  const dictating = dictationStatus === "starting" || recording || dictationStatus === "transcribing"

  // A copied message with context pastes back as its chips, the same items with the same ids.
  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData?.getData("text/plain")
    const parsed = pasted ? parseComposerMessage(pasted) : null
    if (parsed && !parsed.context.some((item) => item.kind === "browser")) {
      event.preventDefault()
      try {
        const combined = combineContext(draftNow(), { v: 1, text: "", context: parsed.context, attachments: [] })
        contextRef.current = combined.context
        setContext(combined.context)
      } catch (error) {
        emitComposerEvent(composer, { type: "rejected-input", scope: composer.snapshot().scope, text: pasted! })
        const id = recovery.capture({ v: 1, text: pasted!, context: [], attachments: [] })
        recovery.settle(id, false, -1)
        setContextError(`${error instanceof Error ? error.message : "Cannot import context"}. The complete pasted message is kept in this tab; download its backup before leaving.`)
        return
      }
      if (parsed.text) {
        const element = event.currentTarget
        const start = element.selectionStart ?? textRef.current.length
        const end = element.selectionEnd ?? start
        setText(textRef.current.slice(0, start) + parsed.text + textRef.current.slice(end))
      }
      return
    }
    handleImagePaste(event)
  }, [draftNow, recovery, handleImagePaste, composer])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (dispatchComposerKey(composer, { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, selectionStart: e.currentTarget.selectionStart, selectionEnd: e.currentTarget.selectionEnd, suggestionsOpen: showSlash || showFiles })) { e.preventDefault(); return }
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
    if (dictationStatus !== "idle" && e.key === "Escape") { e.preventDefault(); dictation?.cancel(); return }
    if (recording && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dictation?.finish(true); return }
    if (e.key === "Escape" && canInterrupt && onInterrupt) { e.preventDefault(); onInterrupt(); return }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!dictating) void handleSubmit() }
  }, [handleSubmit, canInterrupt, onInterrupt, showFiles, fileSuggestions.files, fileSelectedIndex, handleFileSelect, showSlash, filteredSlashList, slashSelectedIndex, handleSlashSelect, composer, dictationStatus, dictating, recording, dictation])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => { textRef.current = e.target.value; setText(e.target.value); setFileSuggestionsDismissed(false); updateMultiline(autoResize(e.target, isMultilineRef.current)) }, [updateMultiline])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    getText: () => textRef.current,
    setText: (newText: string) => {
      textRef.current = newText
      setText(newText)
      setFileSuggestionsDismissed(false)
      requestAnimationFrame(() => updateMultiline(autoResize(textareaRef.current, isMultilineRef.current)))
    },
    addContext,
    getDraft: draftNow,
    setDraft: (draft: ComposerDraft) => {
      applyDraft(draft)
      setFileSuggestionsDismissed(false)
      requestAnimationFrame(() => updateMultiline(autoResize(textareaRef.current, isMultilineRef.current)))
    },
  }), [updateMultiline, addContext, draftNow, applyDraft])

  const isPlanApproval = pendingInteraction?.type === "plan"
  const isUserQuestion = pendingInteraction?.type === "question"
  const hasPermissions = permissionRequests.length > 0
  // With session controls inside the card the message always gets its own
  // row, so the inline single-line grid only applies to the mobile composer.
  const stacked = Boolean(footer)
  const hasContent = (text.trim().length > 0 || images.length > 0 || context.length > 0) && !hasUnsupportedAttachments
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

        {snapshot.messages.filter((message) => !message.pending).map((message) => <div key={message.id} role="status" className="mb-2 rounded border p-2 text-xs">
          <p>Unsent message: {message.draft.text.slice(0, 100) || "Context / attachments"}. Kept in this tab.</p>
          <Button type="button" variant="outline" size="xs" disabled={!isDraftEmpty(draftNow())} onClick={() => { const restored = recovery.restore(message.id); if (restored) applyDraft(restored) }}>Restore unsent message</Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => downloadUnsentBackup(message.draft)}>Download unsent backup</Button>
        </div>)}
        <ContextChips items={context} attachments={images} onRemove={removeContext} onOpenQuoteSource={openQuoteSource} className="mb-2" />
        {contextError && (
          <div role="alert" className="motion-enter mb-2 flex items-center gap-2 text-xs text-warning">
            <span className="flex-1">{contextError}</span>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => setContextError(null)} className="text-muted-foreground" aria-label="Dismiss context notice">
              <X data-icon="icon" />
            </Button>
          </div>
        )}

        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img: UploadedImage, i) => (
              <div key={img.id} className="motion-list-item relative group/thumb">
                <img src={attachmentSrc(img)} alt={img.contextId ? `Capture for ${context.find((item) => item.id === img.contextId)?.kind === "browser" ? "browser annotation" : "context"} ${i + 1}` : `Upload ${i + 1}`} className="h-16 w-auto rounded-md border bg-muted object-contain" />
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => { if (img.contextId) removeContext(img.contextId); else removeImage(i) }} className="absolute -right-1.5 -top-1.5 size-5 rounded-full border bg-popover p-0 text-muted-foreground opacity-100 hover:bg-destructive hover:text-destructive-foreground sm:opacity-0 sm:group-hover/thumb:opacity-100 sm:focus-visible:opacity-100" aria-label={`Remove image ${i + 1}`}>
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
          "relative overflow-hidden border bg-popover shadow-lg shadow-black/5 transition-[border-color,box-shadow] duration-150",
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
                "min-h-0 w-full resize-none rounded-none border-0 bg-transparent text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0",
                getTextareaLayoutClass(stacked, isMultiline, compact),
              )}
            />
            <div className={cn(
              "flex shrink-0 items-center justify-end",
              getActionRowClass(stacked, isMultiline),
            )}>
              {footer}
              {dictation && dictationStatus !== "idle" ? <DictationBar dictation={dictation} /> : <>
                <RuntimePluginActions />
                {dictation && <DictationButton dictation={dictation} onStart={() => textareaRef.current?.focus()} />}
              </>}
              <ActionButtons hasContent={recording || hasContent && !dictating} onSubmit={recording ? () => dictation?.finish(true) : handleSubmit}
                submitLabel={recording ? "Transcribe and send" : isSteering ? "Steer active turn" : "Send message"} />
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
})
