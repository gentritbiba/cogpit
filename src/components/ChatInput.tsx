import { useState, useRef, useCallback, useEffect, memo } from "react"
import { Send, Square, Unplug, Mic, MicOff, CheckCircle, MessageSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { PendingInteraction } from "@/lib/parser"

export type ChatStatus = "ready" | "sending" | "error" | "idle" | "connected"

type SpeechRecognitionEvent = Event & {
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number }
  resultIndex: number
}

const SpeechRecognition =
  (globalThis as unknown as { SpeechRecognition?: typeof EventTarget; webkitSpeechRecognition?: typeof EventTarget })
    .SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: typeof EventTarget }).webkitSpeechRecognition

interface ChatInputProps {
  status: ChatStatus
  error?: string
  isConnected?: boolean
  onSend: (message: string, images?: Array<{ data: string; mediaType: string }>) => void
  onInterrupt?: () => void
  onDisconnect?: () => void
  permissionMode?: string
  permissionsPending?: boolean
  pendingInteraction?: PendingInteraction
}

const MODE_COLORS: Record<string, string> = {
  bypassPermissions: "border-red-800 text-red-400 bg-red-500/10",
  default: "border-blue-800 text-blue-400 bg-blue-500/10",
  plan: "border-purple-800 text-purple-400 bg-purple-500/10",
  acceptEdits: "border-green-800 text-green-400 bg-green-500/10",
  dontAsk: "border-amber-800 text-amber-400 bg-amber-500/10",
  delegate: "border-cyan-800 text-cyan-400 bg-cyan-500/10",
}

const MODE_LABELS: Record<string, string> = {
  bypassPermissions: "YOLO",
  default: "Default",
  plan: "Plan",
  acceptEdits: "Accept Edits",
  dontAsk: "Don't Ask",
  delegate: "Delegate",
}

export const ChatInput = memo(function ChatInput({
  status,
  error,
  isConnected,
  onSend,
  onInterrupt,
  onDisconnect,
  permissionMode,
  permissionsPending,
  pendingInteraction,
}: ChatInputProps) {
  const [text, setText] = useState("")
  const [isListening, setIsListening] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<InstanceType<typeof EventTarget> | null>(null)

  const [images, setImages] = useState<Array<{ file: File; preview: string; data: string; mediaType: string }>>([])
  const [isDragOver, setIsDragOver] = useState(false)

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
            canvas.getContext("2d")!.drawImage(img, 0, 0)
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

  const handleSubmit = useCallback(() => {
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
    [handleSubmit, isConnected, onInterrupt]
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value)
      const el = e.target
      el.style.height = "auto"
      el.style.height = Math.min(el.scrollHeight, 200) + "px"
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

  const toggleVoice = useCallback(() => {
    if (!SpeechRecognition) return

    if (isListening && recognitionRef.current) {
      ;(recognitionRef.current as unknown as { stop(): void }).stop()
      setIsListening(false)
      return
    }

    const recognition = new (SpeechRecognition as unknown as new () => EventTarget & {
      continuous: boolean
      interimResults: boolean
      lang: string
      start(): void
      stop(): void
    })()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = "en-US"

    recognition.addEventListener("result", ((e: SpeechRecognitionEvent) => {
      let transcript = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript
      }
      if (transcript) {
        setText((prev) => {
          const joined = prev ? prev + " " + transcript : transcript
          // Auto-resize textarea
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (el) {
              el.style.height = "auto"
              el.style.height = Math.min(el.scrollHeight, 200) + "px"
            }
          })
          return joined
        })
      }
    }) as EventListener)

    recognition.addEventListener("error", () => {
      setIsListening(false)
      recognitionRef.current = null
    })

    recognition.addEventListener("end", () => {
      setIsListening(false)
      recognitionRef.current = null
    })

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }, [isListening])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        ;(recognitionRef.current as unknown as { stop(): void }).stop()
      }
    }
  }, [])

  const isPlanApproval = pendingInteraction?.type === "plan"
  const isUserQuestion = pendingInteraction?.type === "question"

  return (
    <div
      className={cn(
        "border-t border-zinc-800/80 bg-zinc-900/60 px-3 py-2.5 glass relative",
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
                className="h-16 w-auto rounded-lg border border-zinc-700/50 object-contain bg-zinc-800"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-red-900 hover:border-red-600"
              >
                <X className="w-3 h-3 text-zinc-300" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              isPlanApproval
                ? "Provide feedback to request changes..."
                : isUserQuestion
                  ? "Type a custom response..."
                  : isConnected
                    ? "Message... (Enter to send)"
                    : "Send a message... (Enter to send)"
            }
            rows={1}
            className={cn(
              "w-full resize-none rounded-xl border bg-zinc-900/50 px-3.5 py-2.5 text-sm text-zinc-100",
              "placeholder:text-zinc-600 focus:outline-none focus:ring-2",
              isPlanApproval
                ? "border-purple-700/50 focus:border-purple-500/30 focus:ring-purple-500/20"
                : isUserQuestion
                  ? "border-pink-700/50 focus:border-pink-500/30 focus:ring-pink-500/20"
                  : "border-zinc-700/50 focus:border-blue-500/30 focus:ring-blue-500/20",
              "transition-all duration-200"
            )}
          />
          {isConnected && !isPlanApproval && !isUserQuestion && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
            </div>
          )}
        </div>

        {/* Interrupt button — sends Escape to Claude */}
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

        {/* Disconnect button — kills the PTY process entirely */}
        {isConnected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 shrink-0 p-0 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10"
                onClick={onDisconnect}
              >
                <Unplug className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Disconnect session</TooltipContent>
          </Tooltip>
        )}

        {/* Voice input button */}
        {SpeechRecognition && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 w-8 shrink-0 p-0",
                  isListening
                    ? "text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    : "text-zinc-400 hover:text-zinc-200"
                )}
                onClick={toggleVoice}
              >
                {isListening ? (
                  <MicOff className="size-4" />
                ) : (
                  <Mic className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isListening ? "Stop listening" : "Voice input"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Send button */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-9 w-9 shrink-0 p-0 rounded-lg transition-all duration-200",
            text.trim() || images.length > 0
              ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
              : "text-zinc-600"
          )}
          disabled={!text.trim() && images.length === 0}
          onClick={handleSubmit}
        >
          <Send className="size-4" />
        </Button>
      </div>
      {/* Permission mode badge */}
      {permissionMode && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
              MODE_COLORS[permissionMode] || "border-zinc-700 text-zinc-400"
            )}
          >
            {MODE_LABELS[permissionMode] || permissionMode}
          </span>
          {permissionsPending && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 text-[10px] text-amber-400 cursor-help">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                  </span>
                  pending
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[200px] text-xs">
                Applies on next message send. The current session won't be interrupted.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {status === "error" && error && (
        <p className="mt-1 text-[10px] text-red-400">{error}</p>
      )}
      </div>
    </div>
  )
})

// ── Plan Approval Bar ──────────────────────────────────────────────────────

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
          <span className="text-[10px] text-zinc-500 self-center mr-1">Permissions requested:</span>
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

// ── User Question Bar ──────────────────────────────────────────────────────

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
