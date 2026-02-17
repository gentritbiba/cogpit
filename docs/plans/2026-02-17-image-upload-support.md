# Image Upload Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add drag & drop and Ctrl+V image upload support to ChatInput, send images to Claude via stream-json, and render image thumbnails in the conversation timeline.

**Architecture:** Images are captured as base64 on the frontend (via drag/drop or paste), sent to the server in the message payload, and the server uses `--input-format stream-json` to pipe structured content blocks (including image blocks) to the Claude CLI via stdin. The JSONL stores images as inline base64 content blocks. The parser extracts these blocks and the timeline renders them as clickable thumbnails that open in a full-size modal.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Radix UI Dialog, Node.js child_process.spawn

---

### Task 1: Add ImageBlock type to types.ts

**Files:**
- Modify: `src/lib/types.ts:1-30`

**Step 1: Add the ImageBlock interface and update ContentBlock union**

In `src/lib/types.ts`, add `ImageBlock` after `ToolResultBlock` (before the `ContentBlock` type alias):

```typescript
export interface ImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: string
    data: string
  }
}
```

Then update the `ContentBlock` union on line 28 to include it:

```typescript
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock
```

**Step 2: Verify the build still compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | tail -5`
Expected: Build succeeds (ImageBlock is additive, no breakage)

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add ImageBlock type to ContentBlock union"
```

---

### Task 2: Update parser to extract image blocks from user messages

**Files:**
- Modify: `src/lib/parser.ts:41-47,578-582`

**Step 1: Add getUserMessageImages helper**

Add this function after `getUserMessageText` (after line 582) in `src/lib/parser.ts`:

```typescript
export function getUserMessageImages(content: UserContent | null): ImageBlock[] {
  if (content === null || typeof content === "string") return []
  return content.filter((b): b is ImageBlock => b.type === "image")
}
```

You need to add `ImageBlock` to the import at the top of the file. On line 1-17, add `ImageBlock` to the import from `"./types"`:

```typescript
import type {
  RawMessage,
  ParsedSession,
  Turn,
  ToolCall,
  SubAgentMessage,
  SessionStats,
  TokenUsage,
  ThinkingBlock,
  ContentBlock,
  ImageBlock,
  UserMessage,
  AssistantMessage,
  ProgressMessage,
  SystemMessage,
  SummaryMessage,
  UserContent,
} from "./types"
```

**Step 2: Verify the build still compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/lib/parser.ts
git commit -m "feat: add getUserMessageImages parser helper"
```

---

### Task 3: Render image thumbnails in UserMessage timeline component

**Files:**
- Modify: `src/components/timeline/UserMessage.tsx`

**Step 1: Update UserMessage to render images from content blocks**

Replace the entire file `src/components/timeline/UserMessage.tsx` with:

```tsx
import { useState, useMemo, memo } from "react"
import { User, ChevronDown, ChevronRight, Eye, EyeOff, X } from "lucide-react"
import ReactMarkdown from "react-markdown"
import type { UserContent } from "@/lib/types"
import { getUserMessageText, getUserMessageImages } from "@/lib/parser"
import { Dialog, DialogContent } from "@/components/ui/dialog"

const SYSTEM_TAG_RE =
  /<(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|teammate-message|env|claude_background_info|fast_mode_info|gitStatus)>/g

function stripSystemTags(text: string): string {
  return text.replace(SYSTEM_TAG_RE, "").trim()
}

interface UserMessageProps {
  content: UserContent
  timestamp: string
}

export const UserMessage = memo(function UserMessage({ content, timestamp }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [modalImage, setModalImage] = useState<string | null>(null)

  const rawText = useMemo(() => getUserMessageText(content), [content])
  const cleanText = useMemo(() => stripSystemTags(rawText), [rawText])
  const images = useMemo(() => getUserMessageImages(content), [content])
  const hasTags = rawText !== cleanText
  const displayText = showRaw ? rawText : cleanText

  const isTruncated = displayText.length > 500 && !expanded
  const visibleText = isTruncated ? displayText.slice(0, 500) + "..." : displayText

  return (
    <div className="flex gap-3 group">
      <div className="flex-shrink-0 mt-1">
        <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center">
          <User className="w-4 h-4 text-blue-400" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-blue-400">User</span>
          {timestamp && (
            <span className="text-xs text-zinc-500">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
          {hasTags && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
            >
              {showRaw ? (
                <>
                  <EyeOff className="w-3 h-3" /> Hide raw
                </>
              ) : (
                <>
                  <Eye className="w-3 h-3" /> Show raw
                </>
              )}
            </button>
          )}
        </div>

        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <button
                key={i}
                onClick={() => setModalImage(`data:${img.source.media_type};base64,${img.source.data}`)}
                className="rounded-lg overflow-hidden border border-zinc-700/50 hover:border-blue-500/50 transition-colors cursor-pointer"
              >
                <img
                  src={`data:${img.source.media_type};base64,${img.source.data}`}
                  alt={`Attached image ${i + 1}`}
                  className="max-h-40 max-w-60 object-contain bg-zinc-800"
                />
              </button>
            ))}
          </div>
        )}

        {visibleText && (
          <div className="prose prose-invert prose-sm max-w-none text-zinc-200 break-words overflow-hidden [&_pre]:bg-zinc-800 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:text-zinc-300 [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:rounded [&_a]:text-blue-400">
            <ReactMarkdown>{visibleText}</ReactMarkdown>
          </div>
        )}
        {displayText.length > 500 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronDown className="w-3 h-3" /> Show less
              </>
            ) : (
              <>
                <ChevronRight className="w-3 h-3" /> Show more
              </>
            )}
          </button>
        )}
      </div>

      {/* Full-size image modal */}
      <Dialog open={modalImage !== null} onOpenChange={(open) => !open && setModalImage(null)}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 bg-zinc-900 border-zinc-700">
          {modalImage && (
            <img
              src={modalImage}
              alt="Full size"
              className="max-w-full max-h-[85vh] object-contain mx-auto"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
})
```

Key changes from original:
- Import `getUserMessageImages` from parser and `Dialog`/`DialogContent` from ui
- Add `images` memo extracting image blocks from content
- Add `modalImage` state for the full-size modal
- Render image thumbnails as clickable `<img>` elements (max 160px tall, max 240px wide)
- Add Radix Dialog modal that shows the image full-size on click
- Guard text rendering with `{visibleText && ...}` so image-only messages don't show empty prose div

**Step 2: Verify the build compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Manually verify with the known session**

Open the app and navigate to session `83bd637a-878f-4bed-b1b8-a65d1b9cc1e5`. Find the turn with "Add a medal selector here" — it should now show an image thumbnail. Click it to verify the modal opens.

**Step 4: Commit**

```bash
git add src/components/timeline/UserMessage.tsx
git commit -m "feat: render image thumbnails in user messages with full-size modal"
```

---

### Task 4: Update ChatInput to support drag & drop and paste images

**Files:**
- Modify: `src/components/ChatInput.tsx`

**Step 1: Add image state, drag/drop, and paste handlers to ChatInput**

This is the largest change. The `ChatInput` component needs:
1. `images` state (`File[]`) to hold pending images
2. `onDrop` handler for drag & drop
3. `onPaste` handler for Ctrl+V
4. A preview strip showing thumbnails with X to remove
5. Update `onSend` to accept images

First, update the `ChatInputProps` interface to pass images alongside text:

```typescript
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
```

Add these state variables and helpers inside the `ChatInput` function, after the existing state declarations:

```typescript
const [images, setImages] = useState<Array<{ file: File; preview: string; data: string; mediaType: string }>>([])
const [isDragOver, setIsDragOver] = useState(false)

const addImageFiles = useCallback((files: FileList | File[]) => {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"))
  for (const file of imageFiles) {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // dataUrl format: "data:image/png;base64,iVBOR..."
      const base64 = dataUrl.split(",")[1]
      setImages((prev) => [
        ...prev,
        { file, preview: dataUrl, data: base64, mediaType: file.type },
      ])
    }
    reader.readAsDataURL(file)
  }
}, [])

const removeImage = useCallback((index: number) => {
  setImages((prev) => prev.filter((_, i) => i !== index))
}, [])
```

Update the `handleSubmit` to include images and clear them after send:

```typescript
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
```

Update `handleKeyDown` (the Enter key submit) — no change needed since it calls `handleSubmit`.

Add paste handler to the textarea's `onPaste`:

```typescript
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
```

Add drag & drop handlers to the outer container div:

```typescript
const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault()
  setIsDragOver(true)
}, [])

const handleDragLeave = useCallback((e: React.DragEvent) => {
  e.preventDefault()
  setIsDragOver(false)
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
```

Now update the JSX. Wrap the outer `<div>` with drag handlers:

```tsx
<div
  className={cn(
    "border-t border-zinc-800/80 bg-zinc-900/60 px-3 py-2.5 glass relative",
    isDragOver && "ring-2 ring-blue-500/50 ring-inset"
  )}
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
>
```

Add `onPaste={handlePaste}` to the `<textarea>` element.

Add a drag overlay indicator (inside the outer div, before the Plan approval bar):

```tsx
{isDragOver && (
  <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-blue-500/40 rounded-lg flex items-center justify-center z-10 pointer-events-none">
    <span className="text-sm text-blue-400 font-medium">Drop images here</span>
  </div>
)}
```

Add image preview strip (after plan/question bars, before the `<div className="flex items-end gap-2">`):

```tsx
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
```

Import `X` from lucide-react (add it to the existing import). Import `cn` from `@/lib/utils` (it's already imported).

Update the send button disabled state to also allow sending when images are present:

```tsx
disabled={!text.trim() && images.length === 0}
```

And the send button styling condition:

```tsx
text.trim() || images.length > 0
  ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
  : "text-zinc-600"
```

**Step 2: Verify build compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | tail -5`
Expected: Build succeeds (the `onSend` signature change will cause type errors downstream — fix in next task)

**Step 3: Commit**

```bash
git add src/components/ChatInput.tsx
git commit -m "feat: add drag & drop and paste image support to ChatInput"
```

---

### Task 5: Update usePtyChat hook to send images in payload

**Files:**
- Modify: `src/hooks/usePtyChat.ts`

**Step 1: Update sendMessage to accept images**

Change the `sendMessage` function signature and body. The `sendMessage` callback should accept an optional second parameter:

```typescript
const sendMessage = useCallback(
  async (text: string, images?: Array<{ data: string; mediaType: string }>) => {
    if (!sessionId) return

    setPendingMessage(text)
    setStatus("connected")
    setError(undefined)

    const permsConfig = permissions ?? DEFAULT_PERMISSIONS
    onPermissionsApplied?.()

    const abortController = new AbortController()
    activeAbortRef.current = abortController

    try {
      const res = await fetch("/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: text,
          images: images || undefined,
          cwd: cwd || undefined,
          permissions: permsConfig,
          model: model || undefined,
        }),
        signal: abortController.signal,
      })

      const data = await res.json()

      if (activeAbortRef.current === abortController) {
        if (!res.ok) {
          setError(data.error || `Request failed (${res.status})`)
          setStatus("error")
        } else {
          setStatus("idle")
        }
        setPendingMessage(null)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return
      }
      if (activeAbortRef.current === abortController) {
        setError(err instanceof Error ? err.message : "Unknown error")
        setStatus("error")
        setPendingMessage(null)
      }
    }
  },
  [sessionId, cwd, permissions, onPermissionsApplied, model]
)
```

**Step 2: Update callers to pass images through**

Search for all places that call `sendMessage` or pass `onSend` to `ChatInput`. The main call site is in `src/App.tsx` where `usePtyChat` is used. Find where `sendMessage` is passed as `onSend` prop to `ChatInput`:

In `src/App.tsx`, update the `onSend` prop to pass images through. Find the `ChatInput` usage and change from:

```tsx
onSend={sendMessage}
```

to:

```tsx
onSend={(msg, images) => sendMessage(msg, images)}
```

Or if `sendMessage` already matches the signature (it should after the hook update), keep `onSend={sendMessage}` — TypeScript will verify compatibility.

Also check `src/components/TeamChatInput.tsx` or any other ChatInput consumers — they may need the same `onSend` signature update. If they don't use images, they just ignore the second parameter.

**Step 3: Verify the build compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/hooks/usePtyChat.ts src/App.tsx
git commit -m "feat: pass images through usePtyChat to send-message API"
```

---

### Task 6: Update server to use stream-json when images are present

**Files:**
- Modify: `server/api-plugin.ts:920-1010`

**Step 1: Update the send-message handler to handle images**

In `server/api-plugin.ts`, modify the `/api/send-message` handler. Change the JSON parse to also extract `images`:

```typescript
const { sessionId, message, images, cwd, permissions, model } = JSON.parse(body)
```

Update the validation — message is now optional if images are present:

```typescript
if (!sessionId || (!message && (!images || images.length === 0))) {
  res.statusCode = 400
  res.end(
    JSON.stringify({ error: "sessionId and message or images are required" })
  )
  return
}
```

Then replace the spawn logic. When images are present, use stream-json:

```typescript
const hasImages = Array.isArray(images) && images.length > 0
const modelArgs = model ? ["--model", model] : []

let child
if (hasImages) {
  // Use stream-json to send structured content blocks with images
  child = spawn(
    "claude",
    [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--resume", sessionId,
      ...permArgs,
      ...modelArgs,
    ],
    {
      cwd: cwd || homedir(),
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }
  )

  // Build content blocks: images first, then text
  const contentBlocks: unknown[] = []
  for (const img of images as Array<{ data: string; mediaType: string }>) {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    })
  }
  if (message) {
    contentBlocks.push({ type: "text", text: message })
  }

  const streamMsg = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: contentBlocks,
    },
  })

  child.stdin!.write(streamMsg + "\n")
  child.stdin!.end()
} else {
  // Text-only: use the existing simple -p approach
  child = spawn(
    "claude",
    ["-p", message, "--resume", sessionId, ...permArgs, ...modelArgs],
    {
      cwd: cwd || homedir(),
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
}
```

The rest of the handler (tracking, stderr, close events) stays the same — just make sure `child` is used consistently after this if/else block. The existing `activeProcesses.set(sessionId, child)` and event handlers already reference `child` and will work.

**Step 2: Verify the build compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add server/api-plugin.ts
git commit -m "feat: use stream-json to send images via Claude CLI"
```

---

### Task 7: End-to-end manual test

**Files:** None (testing only)

**Step 1: Start the dev server**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run dev`

**Step 2: Test viewing existing images in timeline**

Open the app and load session `83bd637a-878f-4bed-b1b8-a65d1b9cc1e5`. Find the turn containing "Add a medal selector here" — verify:
- Image thumbnail renders below the user avatar
- Clicking the thumbnail opens the full-size modal
- The modal can be closed by clicking X or outside

**Step 3: Test drag & drop upload**

1. Open any active session (or create a new one)
2. Drag an image file from Finder onto the chat input area
3. Verify: blue border ring appears on drag over, preview thumbnail appears after drop
4. Click X on thumbnail to verify removal works
5. Type a message and press Enter — verify the image is sent and appears in the timeline

**Step 4: Test paste upload**

1. Copy an image to clipboard (e.g., take a screenshot with Cmd+Shift+4)
2. Click the chat input textarea and press Cmd+V
3. Verify: preview thumbnail appears
4. Send the message — verify it works

**Step 5: Test multiple images**

1. Paste one image, then drag another
2. Verify both thumbnails appear in the preview strip
3. Send — verify both images render in the timeline

**Step 6: Test image-only message (no text)**

1. Paste an image but don't type any text
2. Press Enter
3. Verify the send button is enabled and the message sends successfully

**Step 7: Commit if all tests pass**

No code changes needed — just verification.

---

### Task 8: Handle edge cases and cleanup

**Files:**
- Modify: `src/components/ChatInput.tsx` (if needed)
- Modify: `src/components/timeline/UserMessage.tsx` (if needed)

**Step 1: Verify large image handling**

Test with a large image (>5MB). The base64 encoding will be ~1.33x the file size. Claude's API limit is ~20MB base64 per image. Verify it sends without issues.

**Step 2: Verify non-image file rejection**

Drag a `.txt` or `.pdf` file onto the input. Verify it's silently ignored (the `addImageFiles` filter only keeps `image/*` types).

**Step 3: Verify the "show raw" toggle still works correctly**

Load a session with system tags. Verify the Show raw / Hide raw toggle works as before. For messages with images + system tags, both the images and the raw/clean text should render.

**Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address edge cases in image upload support"
```
