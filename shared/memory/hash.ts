// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/** A 64-bit content hash: identical chunk text shares one embedding. Not cryptographic. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length.toString(36)}-${hex32(h2)}${hex32(h1)}`
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0")
}
