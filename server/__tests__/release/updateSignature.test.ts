// @vitest-environment node
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { verifyUpdateSignature } from "../../../scripts/lib/updateSignature"

const KEY_ID = Buffer.from("0102030405060708", "hex")
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64")

function minisignPublicKey(key: KeyObject, keyId = KEY_ID): string {
  const raw = key.export({ format: "der", type: "spki" }).subarray(-32)
  return encode(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`)
}

/** A signature as `tauri signer sign` writes it: over the BLAKE2b-512 digest, with a signed trusted comment. */
function minisignSignature(contents: string, privateKey: KeyObject, comment: string, keyId = KEY_ID): string {
  const signature = sign(null, createHash("blake2b512").update(contents).digest(), privateKey)
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment, "utf8")]), privateKey)
  return encode([
    "untrusted comment: signature from tauri secret key",
    Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
    `trusted comment: ${comment}`,
    global.toString("base64"),
    "",
  ].join("\n"))
}

describe("verifyUpdateSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const comment = "timestamp:1794451758\tfile:Cogpit.app.tar.gz\tversion:4.0.0"
  let directory: string
  let file: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cogpit-signature-"))
    file = join(directory, "Cogpit.app.tar.gz")
    writeFileSync(file, "the update")
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it("accepts a file signed with the trusted key and reads the version it was signed for", () => {
    const signature = minisignSignature("the update", privateKey, comment)
    expect(verifyUpdateSignature(file, signature, minisignPublicKey(publicKey))).toEqual({ version: "4.0.0" })
    const unversioned = minisignSignature("the update", privateKey, "timestamp:1\tfile:cogpit.pacman")
    expect(verifyUpdateSignature(file, unversioned, minisignPublicKey(publicKey))).toEqual({ version: undefined })
  })

  it("refuses a file that changed after it was signed", () => {
    const signature = minisignSignature("the update", privateKey, comment)
    writeFileSync(file, "another update")
    expect(() => verifyUpdateSignature(file, signature, minisignPublicKey(publicKey))).toThrow("does not match the file")
  })

  it("refuses a trusted comment that was edited", () => {
    const signature = Buffer.from(minisignSignature("the update", privateKey, comment), "base64").toString("utf8")
    const edited = encode(signature.replace("version:4.0.0", "version:9.9.9"))
    expect(() => verifyUpdateSignature(file, edited, minisignPublicKey(publicKey))).toThrow("does not match the file")
  })

  it("refuses a signature made with another key", () => {
    const other = generateKeyPairSync("ed25519")
    const otherId = Buffer.from("1112131415161718", "hex")
    expect(() => verifyUpdateSignature(file, minisignSignature("the update", other.privateKey, comment, otherId), minisignPublicKey(publicKey)))
      .toThrow("different key")
    // Same key id, different key.
    expect(() => verifyUpdateSignature(file, minisignSignature("the update", other.privateKey, comment), minisignPublicKey(publicKey)))
      .toThrow("does not match the file")
  })

  it("refuses anything that is not a minisign signature", () => {
    expect(() => verifyUpdateSignature(file, encode("not a signature"), minisignPublicKey(publicKey))).toThrow("minisign format")
  })
})
