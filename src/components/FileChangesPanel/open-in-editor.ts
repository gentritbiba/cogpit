import { authFetch } from "@/lib/auth"

export interface EditorLocation {
  line?: number
  column?: number
}

export function openInEditor(
  filePath: string,
  mode: "file" | "diff" = "file",
  location?: EditorLocation,
): void {
  authFetch("/api/open-in-editor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, mode, ...location }),
  })
}
