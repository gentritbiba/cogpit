import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseConnectionDefinition, parseManifest } from "@cogpit/plugin-contracts"

const root = join(__dirname, "..")
const manifest = parseManifest(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")))
const definition = parseConnectionDefinition(JSON.parse(readFileSync(join(root, "connections", "cloudflare.json"), "utf8")))

describe("Cloudflare connection definition", () => {
  it("declares a bearer API token, token verification and account selection from the accounts list", () => {
    expect(definition.auth).toEqual({ header: "Authorization", scheme: "bearer" })
    expect(definition.operations[definition.validationOperation]).toMatchObject({ audience: "setup", origin: "https://api.cloudflare.com" })
    expect(definition.resources.account).toMatchObject({ scope: "connection", options: { operation: "accounts", items: "/result", id: "/id", label: "/name" } })
  })

  it("binds the panel's Workers listing to the selected account and grants only that operation", () => {
    expect(definition.operations.workers).toMatchObject({ audience: "panel", method: "GET" })
    expect(definition.operations.workers.path).toEqual([{ literal: "client" }, { literal: "v4" }, { literal: "accounts" }, { resource: "account" }, { literal: "workers" }, { literal: "scripts" }])
    const grant = manifest.permissions.connections.find(connection => connection.id === definition.id)
    expect(grant).toEqual({ id: "cloudflare", definition: "connections/cloudflare.json", operations: ["workers"] })
    expect(Object.entries(definition.operations).filter(([, operation]) => operation.audience === "panel").map(([id]) => id)).toEqual(["workers"])
    expect(manifest.requires.host).toMatchObject({ "integrations.cloudflare": "^1.0.0", "connections.request": "^1.0.0" })
  })
})
