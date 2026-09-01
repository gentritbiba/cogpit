export function encodeBase64DirName(prefix: string, cwd: string): string {
  const bytes = new TextEncoder().encode(cwd)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${prefix}${encoded}`
}

export function decodeBase64DirName(prefix: string, dirName: string): string | null {
  if (!dirName.startsWith(prefix)) return null
  try {
    const encoded = dirName.slice(prefix.length).replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
