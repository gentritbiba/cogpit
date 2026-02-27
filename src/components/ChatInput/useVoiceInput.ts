import { useState, useRef, useCallback } from "react"
import { WhisperTranscriber } from "whisper-web-transcriber"

export type VoiceStatus = "idle" | "loading" | "listening" | "error"

interface UseVoiceInputOptions {
  onTranscript: (transcript: string) => void
}

export function useVoiceInput({ onTranscript }: UseVoiceInputOptions) {
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle")
  const [voiceProgress, setVoiceProgress] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const transcriberRef = useRef<WhisperTranscriber | null>(null)

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
            onTranscript(transcript)
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
  }, [voiceStatus, onTranscript])

  const destroyTranscriber = useCallback(() => {
    if (transcriberRef.current) {
      transcriberRef.current.destroy()
    }
  }, [])

  return {
    voiceStatus,
    voiceProgress,
    voiceError,
    toggleVoice,
    destroyTranscriber,
  }
}

export function getVoiceButtonClass(voiceStatus: VoiceStatus): string {
  switch (voiceStatus) {
    case "listening": return "text-red-400 hover:text-red-300 hover:bg-red-500/10"
    case "loading": return "text-blue-400"
    case "error": return "text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
    default: return "text-muted-foreground hover:text-foreground"
  }
}

export function getVoiceTooltip(voiceStatus: VoiceStatus, voiceProgress: number, voiceError: string | null): string {
  switch (voiceStatus) {
    case "loading": return `Loading voice model... ${Math.round(voiceProgress)}%`
    case "listening": return "Stop listening (Ctrl+Shift+M)"
    case "error": return voiceError || "Voice input error — click to retry"
    default: return "Voice input (Ctrl+Shift+M)"
  }
}
