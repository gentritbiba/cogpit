import { useEffect } from "react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import type { ThemeId } from "@/hooks/useTheme"

interface AppStatusToastsProps {
  activeError: string | null
  clearActiveError?: () => void
  modelFallbackNotice: string | null
  dismissModelFallbackNotice: () => void
  connectionLost: boolean
  theme: ThemeId
}

export function AppStatusToasts({
  activeError,
  clearActiveError,
  modelFallbackNotice,
  dismissModelFallbackNotice,
  connectionLost,
  theme,
}: AppStatusToastsProps) {
  useEffect(() => {
    if (!activeError) {
      toast.dismiss("app-error")
      return
    }
    toast.error(activeError, {
      id: "app-error",
      duration: 8000,
      onDismiss: clearActiveError,
      onAutoClose: clearActiveError,
    })
  }, [activeError, clearActiveError])

  useEffect(() => {
    if (!modelFallbackNotice) {
      toast.dismiss("model-fallback")
      return
    }
    toast.warning(modelFallbackNotice, {
      id: "model-fallback",
      duration: Infinity,
      onDismiss: dismissModelFallbackNotice,
    })
  }, [dismissModelFallbackNotice, modelFallbackNotice])

  useEffect(() => {
    if (!connectionLost) {
      toast.dismiss("session-connection")
      return
    }
    toast.warning("Connection lost", {
      id: "session-connection",
      description: "Reconnecting to the live session…",
      duration: Infinity,
    })
  }, [connectionLost])

  return (
    <Toaster
      theme={theme === "light" ? "light" : "dark"}
      position="bottom-center"
      closeButton
      visibleToasts={3}
    />
  )
}
