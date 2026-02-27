import { useState, useRef, useCallback, useEffect, useMemo, memo, useImperativeHandle, forwardRef } from "react"
import { Send, Square, Mic, MicOff, Loader2, CheckCircle, MessageSquare, X, Power } from "lucide-react"
import { WhisperTranscriber } from "whisper-web-transcriber"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatElapsed } from "@/lib/format"
import { useElapsedTimer } from "@/hooks/useElapsedTimer"
import type { PendingInteraction } from "@/lib/parser"
import { SlashSuggestions } from "@/components/SlashSuggestions"
import type { SlashSuggestion } from "@/hooks/useSlashSuggestions"

export type ChatStatus = "ready" | "sending" | "error" | "idle" | "connected"

export interface ChatInputHandle {
  toggleVoice: () => void
  focus: () => void
}

type VoiceStatus = "idle" | "loading" | "listening" | "error"

interface ChatInputProps {
  status: ChatStatus
  error?: string
  isConnected?: boolean
  onSend: (message: string, images?: Array<{ data: string; mediaType: string }>) => void
  onInterrupt?: () => void
  onStopSession?: () => void
  pendingInteraction?: PendingInteraction
  slashSuggestions?: SlashSuggestion[]
  slashSuggestionsLoading?: boolean
  onEditConfig?: (filePath: string) => void
}

/** Auto-resize a textarea to fit its content (max 200px). */
function autoResize(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = "auto"
  el.style.height = Math.min(el.scrollHeight, 200) + "px"
}

function getPlaceholder(isPlanApproval: boolean, isUserQuestion: boolean, isConnected: boolean | undefined): string {
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

function getVoiceButtonClass(voiceStatus: VoiceStatus): string {
  switch (voiceStatus) {
    case "listening": return "text-red-400 hover:text-red-300 hover:bg-red-500/10"
    case "loading": return "text-blue-400"
    case "error": return "text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
    default: return "text-muted-foreground hover:text-foreground"
  }
}

function getVoiceTooltip(voiceStatus: VoiceStatus, voiceProgress: number, voiceError: string | null): string {
  switch (voiceStatus) {
    case "loading": return `Loading voice model... ${Math.round(voiceProgress)}%`
    case "listening": return "Stop listening (Ctrl+Shift+M)"
    case "error": return voiceError || "Voice input error — click to retry"
    default: return "Voice input (Ctrl+Shift+M)"
  }
}

export const ChatInput = memo(forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  status,
  error,
  isConnected,
  onSend,
  onInterrupt,
  onStopSession,
  pendingInteraction,
  slashSuggestions = [],
  slashSuggestionsLoading = false,
  onEditConfig,
}, ref) {
  const [text, setText] = useState("")
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle")
  const [voiceProgress, setVoiceProgress] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const transcriberRef = useRef<WhisperTranscriber | null>(null)

  // Slash suggestions state
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const showSlash = text.startsWith("/") && !text.includes(" ")

  // The filter text is everything after the leading "/" (no spaces possible due to showSlash guard)
  const slashFilter = showSlash ? text.slice(1) : ""
  const filteredSlashList = useMemo(() => {
    if (!showSlash) return []
    const query = slashFilter.toLowerCase()
    const filtered = slashSuggestions.filter((s) => {
      if (!query) return true
      return s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
    })
    // Group: commands first, then skills
    const commands = filtered.filter((s) => s.type === "command")
    const skills = filtered.filter((s) => s.type === "skill")
    return [...commands, ...skills]
  }, [showSlash, slashFilter, slashSuggestions])

  // Reset selected index when filter changes
  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashFilter])

  const [images, setImages] = useState<Array<{ file: File; preview: string; data: string; mediaType: string }>>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const elapsedSec = useElapsedTimer(!!isConnected)

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"))
    for (const file of imageFiles) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        if (SUPPORTED_TYPES.has(file.type)) {
          const base64 = dataUrl.split(",")[1]
          setImages((prev) => [
            ...prev,
            { file, preview: dataUrl, data: base64, mediaType: file.type },
          ])
        } else {
          // Convert unsupported types (e.g. TIFF from macOS screenshots) to PNG via canvas
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement("canvas")
            canvas.width = img.width
            canvas.height = img.height
            const ctx = canvas.getContext("2d")
            if (!ctx) return
            ctx.drawImage(img, 0, 0)
            const pngDataUrl = canvas.toDataURL("image/png")
            const pngBase64 = pngDataUrl.split(",")[1]
            setImages((prev) => [
              ...prev,
              { file, preview: pngDataUrl, data: pngBase64, mediaType: "image/png" },
            ])
          }
          img.src = dataUrl
        }
      }
      reader.onerror = () => {
        console.warn(`Failed to read image file: ${file.name}`)
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleSlashSelect = useCallback((suggestion: SlashSuggestion) => {
    setText(`/${suggestion.name} `)
    setSlashSelectedIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.selectionStart = el.selectionEnd = el.value.length
        autoResize(el)
      }
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    const imagePayload = images.length > 0
      ? images.map((img) => ({ data: img.data, mediaType: img.mediaType }))
      : undefined

    onSend(trimmed, imagePayload)
    setText("")
    setImages([])
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [text, images, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Slash suggestions keyboard navigation
      if (showSlash && filteredSlashList.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setSlashSelectedIndex((i) =>
            i < filteredSlashList.length - 1 ? i + 1 : 0,
          )
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setSlashSelectedIndex((i) =>
            i > 0 ? i - 1 : filteredSlashList.length - 1,
          )
          return
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault()
          const selected = filteredSlashList[slashSelectedIndex]
          if (selected) handleSlashSelect(selected)
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          setText("")
          return
        }
      }

      if (e.key === "Escape" && isConnected && onInterrupt) {
        e.preventDefault()
        onInterrupt()
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit, isConnected, onInterrupt, showSlash, filteredSlashList, slashSelectedIndex, handleSlashSelect]
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value)
      autoResize(e.target)
    },
    []
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"))
      if (imageItems.length === 0) return
      e.preventDefault()
      const files = imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[]
      addImageFiles(files)
    },
    [addImageFiles]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (e.dataTransfer.files.length > 0) {
        addImageFiles(e.dataTransfer.files)
      }
    },
    [addImageFiles]
  )

  const toggleVoice = useCallback(async () => {
    // Clear previous error and proceed to retry
    if (voiceStatus === "error") {
      setVoiceError(null)
      setVoiceStatus("idle")
    }

    // Stop listening
    if (voiceStatus === "listening" && transcriberRef.current) {
      transcriberRef.current.stopRecording()
      setVoiceStatus("idle")
      return
    }

    // Don't start if already loading
    if (voiceStatus === "loading") return

    // Lazily create transcriber on first use
    if (!transcriberRef.current) {
      setVoiceStatus("loading")
      setVoiceProgress(0)
      setVoiceError(null)

      console.log("[Voice] crossOriginIsolated:", window.crossOriginIsolated)
      console.log("[Voice] SharedArrayBuffer:", typeof SharedArrayBuffer !== "undefined")
      console.log("[Voice] mediaDevices:", !!navigator.mediaDevices)

      const transcriber = new WhisperTranscriber({
        modelSize: "base-en-q5_1",
        onTranscription: (transcript: string) => {
          if (transcript) {
            setText((prev) => {
              const joined = prev ? prev + " " + transcript : transcript
              requestAnimationFrame(() => autoResize(textareaRef.current))
              return joined
            })
          }
        },
        onProgress: (progress: number) => setVoiceProgress(progress),
        onStatus: (s: string) => {
          if (s === "recording") setVoiceStatus("listening")
        },
      })
      // Override base path so the library finds its WASM files served from /whisper/
      ;(transcriber as unknown as { getScriptBasePath: () => string }).getScriptBasePath = () => "/whisper/"
      // Suppress confirm() dialog the library shows before first model download
      const origConfirm = window.confirm
      try {
        window.confirm = () => true
        await Promise.race([
          transcriber.loadModel(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Model loading timed out")), 120_000)),
        ])
        transcriberRef.current = transcriber
      } catch (err) {
        console.error("[Voice] Failed to load model:", err)
        setVoiceError(err instanceof Error ? err.message : "Failed to load voice model")
        setVoiceStatus("error")
        return
      } finally {
        window.confirm = origConfirm
      }
    }

    // Start recording
    try {
      setVoiceStatus("listening")
      await transcriberRef.current.startRecording()
    } catch (err) {
      console.error("[Voice] Failed to start recording:", err)
      const msg = err instanceof Error ? err.message : "Failed to start recording"
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setVoiceError("Microphone access denied — check system permissions")
      } else {
        setVoiceError(msg)
      }
      setVoiceStatus("error")
    }
  }, [voiceStatus])

  useImperativeHandle(ref, () => ({
    toggleVoice,
    focus: () => textareaRef.current?.focus(),
  }), [toggleVoice])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (transcriberRef.current) {
        transcriberRef.current.destroy()
      }
    }
  }, [])

  const isPlanApproval = pendingInteraction?.type === "plan"
  const isUserQuestion = pendingInteraction?.type === "question"
  const hasContent = text.trim().length > 0 || images.length > 0

  return (
    <div
      className={cn(
        "border-t border-border/50 bg-elevation-1 px-3 py-2.5 relative",
        isDragOver && "ring-2 ring-blue-500/50 ring-inset"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay indicator */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-blue-500/40 rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <span className="text-sm text-blue-400 font-medium">Drop images here</span>
        </div>
      )}

      {/* Slash suggestions popup */}
      {showSlash && (
        <SlashSuggestions
          suggestions={filteredSlashList}
          filter={slashFilter}
          loading={slashSuggestionsLoading}
          selectedIndex={slashSelectedIndex}
          onSelect={handleSlashSelect}
          onHover={setSlashSelectedIndex}
          onEdit={onEditConfig}
        />
      )}

      <div className="mx-auto max-w-3xl">
      {/* Plan approval bar */}
      {isPlanApproval && (
        <PlanApprovalBar
          allowedPrompts={pendingInteraction.allowedPrompts}
          onApprove={() => onSend("yes")}
          onSend={onSend}
        />
      )}

      {/* User question options */}
      {isUserQuestion && (
        <UserQuestionBar
          questions={pendingInteraction.questions}
          onSend={onSend}
        />
      )}

      {/* Image preview strip */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((img, i) => (
            <div key={i} className="relative group/thumb">
              <img
                src={img.preview}
                alt={`Upload ${i + 1}`}
                className="h-16 w-auto rounded-lg border border-border/50 object-contain bg-muted"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-red-900 hover:border-red-600"
                aria-label={`Remove image ${i + 1}`}
              >
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
            className={cn(
              "w-full resize-none rounded-xl border elevation-1 px-3.5 py-2.5 text-sm text-foreground",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-2",
              getTextareaBorderClass(isPlanApproval, isUserQuestion),
              "transition-colors duration-200"
            )}
          />
          {isConnected && !isPlanApproval && !isUserQuestion && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              {elapsedSec > 0 && (
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
                  {formatElapsed(elapsedSec)}
                </span>
              )}
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
            </div>
          )}
        </div>

        {/* Interrupt button -- sends Escape to Claude */}
        {isConnected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 shrink-0 p-0 rounded-lg text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                onClick={onInterrupt}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Interrupt agent (Esc)</TooltipContent>
          </Tooltip>
        )}

        {/* Stop session -- kills the server process */}
        {isConnected && onStopSession && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 shrink-0 p-0 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10"
                onClick={onStopSession}
              >
                <Power className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop session</TooltipContent>
          </Tooltip>
        )}

        {/* Voice input button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-9 w-9 shrink-0 p-0 rounded-lg", getVoiceButtonClass(voiceStatus))}
              onClick={toggleVoice}
              disabled={voiceStatus === "loading"}
            >
              {voiceStatus === "loading" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : voiceStatus === "listening" ? (
                <MicOff className="size-4" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {getVoiceTooltip(voiceStatus, voiceProgress, voiceError)}
          </TooltipContent>
        </Tooltip>

        {/* Send button */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-9 w-9 shrink-0 p-0 rounded-lg transition-colors duration-200",
            hasContent
              ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
              : "text-muted-foreground"
          )}
          disabled={!hasContent}
          onClick={handleSubmit}
          aria-label="Send message"
        >
          <Send className="size-4" />
        </Button>
      </div>
      {status === "error" && error && (
        <p className="mt-1 text-[10px] text-red-400">{error}</p>
      )}
      </div>
    </div>
  )
}))

// -- Plan Approval Bar --------------------------------------------------------

function PlanApprovalBar({
  allowedPrompts,
  onApprove,
  onSend,
}: {
  allowedPrompts?: Array<{ tool: string; prompt: string }>
  onApprove: () => void
  onSend: (message: string) => void
}) {
  return (
    <div className="mb-2.5 rounded-lg border border-purple-500/30 bg-purple-500/5 p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-purple-500/20 shrink-0">
            <CheckCircle className="size-3 text-purple-400" />
          </div>
          <span className="text-xs font-medium text-purple-300">
            Plan ready for review
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            className="h-7 px-3 text-xs bg-purple-600 hover:bg-purple-500 text-white border-0"
            onClick={onApprove}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-500/10"
            onClick={() => onSend("no")}
          >
            Reject
          </Button>
        </div>
      </div>
      {allowedPrompts && allowedPrompts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-[10px] text-muted-foreground self-center mr-1">Permissions requested:</span>
          {allowedPrompts.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded border border-purple-500/20 bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-400"
            >
              {p.prompt}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// -- User Question Bar --------------------------------------------------------

function UserQuestionBar({
  questions,
  onSend,
}: {
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
  onSend: (message: string) => void
}) {
  // Handle multi-question responses: for now, render first question's options
  // (matches terminal behavior where questions are answered one at a time)
  const q = questions[0]
  if (!q) return null

  return (
    <div className="mb-2.5 rounded-lg border border-pink-500/30 bg-pink-500/5 p-2.5">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center justify-center w-5 h-5 rounded-full bg-pink-500/20 shrink-0">
          <MessageSquare className="size-3 text-pink-400" />
        </div>
        <span className="text-xs text-pink-300">
          {q.header && <span className="font-medium mr-1.5">{q.header}</span>}
          {q.question}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {q.options.map((opt, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs border-pink-500/30 text-pink-300 hover:bg-pink-500/10 hover:text-pink-200 hover:border-pink-500/50"
                onClick={() => onSend(opt.label)}
              >
                {opt.label}
              </Button>
            </TooltipTrigger>
            {opt.description && (
              <TooltipContent className="max-w-[250px] text-xs">
                {opt.description}
              </TooltipContent>
            )}
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
