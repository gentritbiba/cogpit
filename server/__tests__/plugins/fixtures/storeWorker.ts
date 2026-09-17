import { openPluginStore } from "../../../plugins/store"
import { createAuthority, createRoot } from "./signing"
import { authorize, client, host, owner, signedPackage } from "./storeSigning"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

const [, , root, mode, crashStep] = process.argv
let armed = mode === "bootstrap"
if (armed) process.send?.({ ready: true })
const store = await openPluginStore(root, { host, crashHook: async step => {
  if (armed && step === crashStep) {
    await new Promise<void>(() => {
      process.on("message", () => {})
      process.send?.({ crashStep: step })
    })
  }
} })
if (!store.snapshot().available) throw new Error(store.snapshot().error)
if (mode === "hold") {
  process.send?.({ ready: true })
  process.on("message", async message => {
    if (message === "close") { await store.close(); process.exit(0) }
  })
} else {
  const authority = createAuthority()
  await store.enrollDeveloper("dev-test", "Crash fixture", createRoot(authority), { authorize })
  const fixture = signedPackage(authority)
  const preview = await store.stage(fixture.bytes, { owner, client, scope: { type: "all" }, authorize })
  await store.payload(preview.transactionId, owner)
  await store.beginTrial(preview.transactionId, owner, { authorize })
  if (mode === "repair") {
    await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
    await writeFile(join(root, "packages", `${fixture.digest}.json`), "original damaged bytes")
    await store.payload(fixture.digest).catch(() => {})
    process.send?.({ ready: true, transactionId: preview.transactionId, digest: preview.digest })
    armed = true
    await store.stage(fixture.bytes, { owner, client, scope: { type: "all" }, authorize })
    throw new Error("Requested repair crash hook was not reached")
  }
  process.send?.({ ready: true, transactionId: preview.transactionId, digest: preview.digest })
  armed = true
  await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
  throw new Error("Requested crash hook was not reached")
}
