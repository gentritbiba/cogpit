import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import type { RuntimePluginClient } from "./runtimeClient"

export function PluginPublisherForm({ client, run, busy }: {
  client: RuntimePluginClient; run: (action: () => Promise<void>) => void; busy: boolean
}) {
  const id = useId()
  const [publisher, setPublisher] = useState("")
  const [label, setLabel] = useState("")
  const [root, setRoot] = useState<File | null>(null)
  const [fingerprint, setFingerprint] = useState("")
  const [trusted, setTrusted] = useState(false)
  return <form onSubmit={(event) => {
    event.preventDefault()
    run(async () => {
      if (!root || root.size > 256 * 1024) throw new Error("Choose a root metadata file smaller than 256 KiB")
      if (!globalThis.crypto?.subtle) throw new Error("Publisher enrollment requires HTTPS or localhost")
      const bytes = await root.arrayBuffer()
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")
      if (actual !== fingerprint.trim().toLowerCase()) throw new Error("The root file does not match the fingerprint you entered")
      await client.enrollDeveloper({ publisher, label, root: new TextDecoder("utf-8", { fatal: true }).decode(bytes), fingerprint: actual })
      setTrusted(false)
      setPublisher("")
      setLabel("")
      setFingerprint("")
    })
  }}>
    <FieldGroup>
      <Field><FieldLabel htmlFor={`${id}-name`}>Development publisher</FieldLabel>
        <Input id={`${id}-name`} value={publisher} onChange={(event) => setPublisher(event.target.value)} placeholder="dev-your-name" pattern="dev-[a-z0-9-]+" maxLength={64} required disabled={busy} />
        <FieldDescription>Development publishers have a separate namespace from official plugins.</FieldDescription>
      </Field>
      <Field><FieldLabel htmlFor={`${id}-label`}>Display name</FieldLabel>
        <Input id={`${id}-label`} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} required disabled={busy} />
      </Field>
      <Field><FieldLabel htmlFor={`${id}-root`}>Publisher root file</FieldLabel>
        <Input id={`${id}-root`} type="file" accept=".json,application/json" onChange={(event) => { setRoot(event.target.files?.[0] ?? null); setTrusted(false) }} required disabled={busy} />
      </Field>
      <Field><FieldLabel htmlFor={`${id}-fingerprint`}>Verified SHA-256 fingerprint</FieldLabel>
        <Input id={`${id}-fingerprint`} value={fingerprint} onChange={(event) => { setFingerprint(event.target.value); setTrusted(false) }} placeholder="64 hexadecimal characters" pattern="[a-fA-F0-9]{64}" required disabled={busy} />
        <FieldDescription>Get this fingerprint from the publisher through a source you trust.</FieldDescription>
      </Field>
      <Field orientation="horizontal"><Checkbox id={`${id}-trust`} checked={trusted} onCheckedChange={setTrusted} disabled={busy} />
        <FieldLabel htmlFor={`${id}-trust`}>I verified the publisher and trust packages signed by this root.</FieldLabel>
      </Field>
      <Button type="submit" disabled={busy || !trusted || !root}>Trust development publisher</Button>
    </FieldGroup>
  </form>
}
