import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import { copyToClipboard } from "@/lib/utils"

export interface EditorLocation {
  line?: number
  column?: number
}

export function openInEditor(
  filePath: string,
  mode: "file" | "diff" = "file",
  location?: EditorLocation,
): void {
  // On a remote device this would launch an editor window on the remote
  // machine's screen — copy the path instead so it's still actionable here.
  if (isRemoteDeviceActive()) {
    void copyToClipboard(filePath)
    return
  }
  authFetch("/api/open-in-editor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, mode, ...location }),
  })
}
