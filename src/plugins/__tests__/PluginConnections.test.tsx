import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { parseConnectionDefinition } from "@cogpit/plugin-contracts"
import type { PluginConnectionSnapshot } from "../../../shared/contracts/pluginConnections"
import { PluginConnections } from "../PluginConnections"
import type { RuntimePluginClient } from "../runtimeClient"
import { panelHostStatus, panelProject } from "./runtimePanelFixtures"

const definition = parseConnectionDefinition({
  version: 1, id: "service", label: "Example provider", secret: { id: "token", label: "API token" },
  auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate",
  resources: { account: { label: "Account", options: { operation: "accounts", items: "/accounts", id: "/id", label: "/name" } } },
  operations: {
    validate: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "me" }], args: {}, query: {} },
    accounts: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "accounts" }], args: {}, query: {} },
    read: { audience: "panel", origin: "https://example.com", method: "GET", path: [{ literal: "accounts" }, { resource: "account" }], args: {}, query: {} },
  },
})
function connection(status: "disconnected" | "connected" | "environment" = "disconnected"): PluginConnectionSnapshot {
  return { revision: 1, connections: [{ id: "service", label: "Example provider", status, readOnly: status === "environment", selected: {}, definition }] }
}
function setup(snapshot = connection()) {
  const client = { connections: vi.fn<RuntimePluginClient["connections"]>(async () => snapshot), connectionOptions: vi.fn<RuntimePluginClient["connectionOptions"]>(async () => [{ id: "a", label: "Account A" }]), changeConnection: vi.fn<RuntimePluginClient["changeConnection"]>(async () => ({ ...connection("connected"), revision: 2 })) }
  return { client, ...render(<PluginConnections client={client} status={panelHostStatus} pluginId="example.sample" initialProjectId={panelProject.id} />) }
}

describe("host-owned plugin connections", () => {
  it("names the selected host and sends credentials only through the trusted management client", async () => {
    const value = setup()
    const input = await screen.findByLabelText("API token")
    expect(screen.getByText(/Connection credentials belong to Host/)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "synthetic-fixture-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }))
    expect(input).toHaveValue("")
    await waitFor(() => expect(value.client.changeConnection).toHaveBeenCalledWith({ pluginId: "example.sample", projectId: panelProject.id }, "service", "credential", { secret: "synthetic-fixture-secret" }, 1, expect.any(AbortSignal)))
    expect(await screen.findByText("Connected")).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("synthetic-fixture-secret")
  })
  it("keeps environment credentials read-only while permitting resource selection", async () => {
    setup(connection("environment"))
    expect(await screen.findByText("Configured by host")).toBeInTheDocument()
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Browse choices" })).toBeEnabled()
  })
  it("cancels option discovery when its settings view is closed", async () => {
    const value = setup(connection("connected"))
    let resolve!: (value: { id: string; label: string }[]) => void
    value.client.connectionOptions.mockImplementation(() => new Promise((yes) => { resolve = yes }))
    fireEvent.click(await screen.findByRole("button", { name: "Browse choices" }))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledOnce())
    const signal = value.client.connectionOptions.mock.calls[0][3]
    value.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolve([{ id: "late", label: "Late response" }]) })
    expect(screen.queryByText("Late response")).not.toBeInTheDocument()
  })
  it("keeps the credential cleared when validation fails and displays a retryable error", async () => {
    const value = setup()
    value.client.changeConnection.mockRejectedValue(new Error("Provider rejected the credential"))
    const input = await screen.findByLabelText("API token")
    fireEvent.change(input, { target: { value: "synthetic-invalid-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }))
    expect(await screen.findByText("Provider rejected the credential")).toBeInTheDocument()
    expect(input).toHaveValue("")
  })
})
