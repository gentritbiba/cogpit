/**
 * Checks an update file against the signature the desktop build wrote for it
 * and the public key installed apps carry (`plugins.updater.pubkey`). A
 * release signed with any other key would be refused by every install.
 *
 * Both are minisign files, base64-encoded once more by Tauri.
 */
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFileSync } from "node:fs"

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const TRUSTED_COMMENT = "trusted comment: "

function minisignLines(encoded: string): string[] {
  return Buffer.from(encoded.trim(), "base64").toString("utf8").split("\n")
}

/** Throws unless `signature` is `file` signed by `publicKey`; returns what the signature says about the file. */
export function verifyUpdateSignature(file: string, signature: string, publicKey: string): { version: string | undefined } {
  const key = Buffer.from(minisignLines(publicKey)[1] ?? "", "base64")
  const [, signatureLine, commentLine, globalLine] = minisignLines(signature)
  const signed = Buffer.from(signatureLine ?? "", "base64")
  const global = Buffer.from(globalLine ?? "", "base64")
  if (key.length !== 42 || signed.length !== 74 || global.length !== 64 || !commentLine?.startsWith(TRUSTED_COMMENT)) {
    throw new Error("The signature or the public key is not in minisign format.")
  }
  if (!signed.subarray(2, 10).equals(key.subarray(2, 10))) {
    throw new Error("The file was signed with a different key than the one installed apps trust.")
  }
  const ed25519 = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]), format: "der", type: "spki" })
  // "ED" signs the BLAKE2b-512 digest of the file, "Ed" the file itself.
  const algorithm = signed.subarray(0, 2).toString("latin1")
  const contents = readFileSync(file)
  const message = algorithm === "ED" ? createHash("blake2b512").update(contents).digest() : contents
  const comment = commentLine.slice(TRUSTED_COMMENT.length)
  if (!verify(null, message, ed25519, signed.subarray(10))
    || !verify(null, Buffer.concat([signed.subarray(10), Buffer.from(comment, "utf8")]), ed25519, global)) {
    throw new Error("The signature does not match the file.")
  }
  return { version: comment.match(/(?:^|\t)version:(\S+)/)?.[1] }
}
