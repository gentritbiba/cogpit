import { useEffect } from "react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { useEditionUiUnavailable } from "@/edition/hooks"
import { themeMode, type ThemeId } from "@/lib/themes"

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

  const editionUiUnavailable = useEditionUiUnavailable()
  useEffect(() => {
    if (!editionUiUnavailable) return
    toast.info("This server offers features this build of Cogpit doesn’t include.", { id: "edition-ui-unavailable" })
  }, [editionUiUnavailable])

  return (
    <Toaster
      theme={themeMode(theme)}
      position="bottom-center"
      closeButton
      visibleToasts={3}
    />
  )
}
